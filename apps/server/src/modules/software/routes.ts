import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actor, requireActive } from '../../auth/plugin.js';
import type { Ctx } from '../../context.js';
import { AppError } from '../../errors.js';
import { assertVmAccess, type VmRow } from '../../rbac/index.js';
import { execRemote } from '../../ssh/exec.js';
import { rateLimit } from '../../ratelimit.js';
import { toPublicJob } from '../jobs/service.js';
import { privOpts, withVm } from '../vms/service.js';
import { PHP_OPTIONAL_EXTENSIONS } from './catalog.js';
import { aptUpdate, buildPlan, runSteps } from './install.js';
import { collectStatus, parseDpkg } from './status.js';

const vmParams = z.object({ vmId: z.string().uuid() });
const installBody = z.object({
  item: z.enum([
    'base-tools',
    'nginx',
    'php-repo',
    'php',
    'composer',
    'mariadb',
    'mysql',
    'postgresql',
    'redis',
  ]),
  version: z.string().max(8).optional(),
  extensions: z.array(z.enum(PHP_OPTIONAL_EXTENSIONS)).max(10).optional(),
  acceptThirdParty: z.boolean().optional(),
});

export function softwareRoutes(app: FastifyInstance, ctx: Ctx): void {
  const access = (req: FastifyRequest, module?: 'software'): { vm: VmRow; userId: string } => {
    const { vmId } = vmParams.parse(req.params);
    const user = actor(req);
    return { vm: assertVmAccess(ctx.db, user, vmId, module), userId: user.id };
  };
  const emailOf = (id: string) =>
    (
      ctx.db.prepare('SELECT email FROM users WHERE id = ?').get(id) as
        { email: string } | undefined
    )?.email ?? '';

  app.get(
    '/api/vms/:vmId/software',
    { config: rateLimit(30), onRequest: requireActive },
    async (req) => {
      const { vm } = access(req, 'software');
      return withVm(ctx, vm, (lease) => collectStatus(lease.client, privOpts(vm)));
    },
  );

  app.post(
    '/api/vms/:vmId/software/install',
    { config: rateLimit(10), onRequest: requireActive },
    async (req) => {
      const { vm, userId } = access(req, 'software');
      const body = installBody.parse(req.body);
      if (body.item === 'php-repo' && body.acceptThirdParty !== true) {
        throw new AppError(
          400,
          'third_party_unaccepted',
          'Repositori ini adalah sumber paket pihak ketiga. Centang persetujuan untuk melanjutkan.',
        );
      }

      // Validasi dan perencanaan dilakukan sinkron agar kesalahan input langsung terlihat di UI.
      const plan = await withVm(ctx, vm, async (lease) => {
        const status = await collectStatus(lease.client, privOpts(vm));
        const row = status.items.find((i) => i.id === body.item);
        if (row?.conflict) throw new AppError(409, 'conflict', row.conflict);
        if (row && !row.available && ['mariadb', 'mysql', 'redis', 'nginx'].includes(row.id)) {
          throw new AppError(
            409,
            'unavailable',
            `${row.title} tidak tersedia di repositori VM ini. Coba "Segarkan daftar paket" dulu, atau pakai terminal untuk menambah repositori sendiri.`,
          );
        }
        const optionalAvailable = new Set<string>();
        if (body.item === 'php' && body.version && body.extensions?.length) {
          const r = await execRemote(
            lease.client,
            ['apt-cache', 'policy', ...body.extensions.map((e) => `php${body.version}-${e}`)],
            privOpts(vm),
          );
          for (const e of body.extensions)
            if (
              new RegExp(
                `php${body.version!.replace('.', '\\.')}-${e}:\\n\\s+Installed:.*\\n\\s+Candidate: (?!\\(none\\))`,
              ).test(r.stdout)
            )
              optionalAvailable.add(e);
        }
        return buildPlan(body, status.os, {
          phpVersions: status.php.versions.map((v) => v.version),
          pgVersions: status.postgres.versions.map((v) => v.version),
          phpOptionalAvailable: optionalAvailable,
        });
      });

      const title = `Pasang ${body.item}${body.version ? ` ${body.version}` : ''}`;
      const job = ctx.jobs.start(
        { vmId: vm.id, userId, ip: req.ip, kind: 'install', title, vmName: vm.name },
        (log) =>
          withVm(ctx, vm, async (lease) => {
            log(`Mulai oleh ${emailOf(userId)} pada VM "${vm.name}".\n`);
            await runSteps(lease.client, privOpts(vm), plan.steps, log);
            if (plan.verifyPackages.length) {
              const r = await execRemote(
                lease.client,
                [
                  'dpkg-query',
                  '-W',
                  '-f=${Package}\t${db:Status-Abbrev}\t${Version}\n',
                  ...plan.verifyPackages,
                ],
                privOpts(vm),
              );
              const ok = parseDpkg(r.stdout);
              const missing = plan.verifyPackages.filter((p) => !ok.has(p));
              if (missing.length)
                throw new AppError(
                  422,
                  'verify_failed',
                  `Pemasangan selesai tetapi paket ini belum terpasang: ${missing.join(', ')}.`,
                );
            }
            log('\n[SELESAI] Pemasangan berhasil.\n');
          }),
      );
      return toPublicJob(job, false);
    },
  );

  app.post(
    '/api/vms/:vmId/software/apt-update',
    { config: rateLimit(10), onRequest: requireActive },
    async (req) => {
      const { vm, userId } = access(req, 'software');
      const job = ctx.jobs.start(
        {
          vmId: vm.id,
          userId,
          ip: req.ip,
          kind: 'apt-update',
          title: 'Segarkan daftar paket',
          vmName: vm.name,
        },
        (log) =>
          withVm(ctx, vm, async (lease) => {
            await runSteps(lease.client, privOpts(vm), [aptUpdate()], log);
            log('\n[SELESAI] Daftar paket diperbarui.\n');
          }),
      );
      return toPublicJob(job, false);
    },
  );

  app.get('/api/vms/:vmId/jobs', { onRequest: requireActive }, async (req) => {
    const { vm } = access(req);
    return { items: ctx.jobs.list(vm.id).map((j) => toPublicJob(j, false)) };
  });

  /** Lanjutkan atau batalkan job yang berhenti menunggu tindakan (mis. .env belum benar). */
  for (const outcome of ['resume', 'cancel'] as const) {
    app.post(
      `/api/vms/:vmId/jobs/:jobId/${outcome}`,
      { config: rateLimit(30), onRequest: requireActive },
      async (req) => {
        const { vm, userId } = access(req);
        const { jobId } = z.object({ jobId: z.string().uuid() }).parse(req.params);
        const job = ctx.jobs.respond(vm.id, jobId, outcome);
        ctx.audit.record({
          userId,
          vmId: vm.id,
          ip: req.ip,
          action: `job.${outcome}`,
          target: job.title,
          result: 'ok',
        });
        return toPublicJob(job, false);
      },
    );
  }

  app.get('/api/vms/:vmId/jobs/:jobId', { onRequest: requireActive }, async (req) => {
    const { vm } = access(req);
    const { jobId } = z.object({ jobId: z.string().uuid() }).parse(req.params);
    return toPublicJob(ctx.jobs.get(vm.id, jobId), true);
  });
}
