import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actor, requireActive } from '../../auth/plugin.js';
import type { Ctx } from '../../context.js';
import { AppError, notFound } from '../../errors.js';
import { assertVmAccess, type VmRow } from '../../rbac/index.js';
import { rateLimit } from '../../ratelimit.js';
import { execRemote } from '../../ssh/exec.js';
import type { Lease } from '../../ssh/pool.js';
import { privOpts, withVm } from '../vms/service.js';
import {
  ACTIONS,
  isProtectedUnit,
  mergeServices,
  parseListUnits,
  parseShow,
  parseUnitFiles,
  unitName,
} from './systemd.js';

const vmParams = z.object({ vmId: z.string().uuid() });
const MAX_LOG_LINES = 500;

export function serviceRoutes(app: FastifyInstance, ctx: Ctx): void {
  const access = (req: FastifyRequest): { vm: VmRow; userId: string } => {
    const { vmId } = vmParams.parse(req.params);
    const user = actor(req);
    return { vm: assertVmAccess(ctx.db, user, vmId, 'services'), userId: user.id };
  };
  const run = (vm: VmRow, lease: Lease, argv: string[], timeoutMs = 30_000) =>
    execRemote(lease.client, argv, { ...privOpts(vm), timeoutMs });
  const noSystemd = () =>
    new AppError(
      409,
      'no_systemd',
      'VM ini tidak memakai systemd, jadi service tidak bisa dikelola dari panel. Gunakan terminal.',
    );

  async function assertUnitExists(vm: VmRow, lease: Lease, unit: string): Promise<void> {
    const r = await run(vm, lease, [
      'systemctl',
      'show',
      '-p',
      'LoadState',
      '--value',
      '--no-pager',
      '--',
      unit,
    ]);
    if (
      r.code !== 0 &&
      /not (been )?loaded|System has not been booted|Failed to connect/i.test(r.stderr)
    )
      throw noSystemd();
    if (r.stdout.trim() !== 'loaded') throw notFound('Service');
  }

  app.get(
    '/api/vms/:vmId/services',
    { config: rateLimit(30), onRequest: requireActive },
    async (req) => {
      const { vm } = access(req);
      return withVm(ctx, vm, async (lease) => {
        const [units, files] = await Promise.all([
          run(vm, lease, [
            'systemctl',
            'list-units',
            '--type=service',
            '--all',
            '--no-legend',
            '--plain',
            '--no-pager',
          ]),
          run(vm, lease, [
            'systemctl',
            'list-unit-files',
            '--type=service',
            '--no-legend',
            '--no-pager',
          ]),
        ]);
        if (units.code !== 0) throw noSystemd();
        return { items: mergeServices(parseListUnits(units.stdout), parseUnitFiles(files.stdout)) };
      });
    },
  );

  app.post(
    '/api/vms/:vmId/services/action',
    { config: rateLimit(30), onRequest: requireActive },
    async (req) => {
      const { vm, userId } = access(req);
      const b = z.object({ unit: unitName, action: z.enum(ACTIONS) }).parse(req.body);
      if (isProtectedUnit(b.unit) && b.action !== 'reload') {
        throw new AppError(
          403,
          'protected_service',
          `${b.unit} adalah layanan sistem yang dilindungi (mematikannya bisa memutus akses panel ke VM). Hanya "reload" yang diizinkan dari panel; gunakan terminal bila Anda yakin.`,
        );
      }
      const result = await withVm(ctx, vm, async (lease) => {
        await assertUnitExists(vm, lease, b.unit);
        const r = await run(vm, lease, ['systemctl', b.action, '--', b.unit], 120_000);
        if (r.code !== 0) {
          ctx.audit.record({
            userId,
            vmId: vm.id,
            ip: req.ip,
            action: `service.${b.action}`,
            target: b.unit,
            result: 'fail',
          });
          throw new AppError(
            422,
            'service_failed',
            `systemctl ${b.action} ${b.unit} gagal: ${(r.stderr || r.stdout).trim().split('\n')[0]?.slice(0, 240) || 'tanpa pesan'}. Lihat log service untuk penyebabnya.`,
          );
        }
        const after = parseShow(
          (
            await run(vm, lease, [
              'systemctl',
              'show',
              '-p',
              'ActiveState,SubState,UnitFileState',
              '--no-pager',
              '--',
              b.unit,
            ])
          ).stdout,
        );
        return {
          active: after.ActiveState ?? '',
          sub: after.SubState ?? '',
          enabled: after.UnitFileState ?? '',
        };
      });
      ctx.audit.record({
        userId,
        vmId: vm.id,
        ip: req.ip,
        action: `service.${b.action}`,
        target: b.unit,
        result: 'ok',
      });
      return { ok: true, unit: b.unit, ...result };
    },
  );

  app.get(
    '/api/vms/:vmId/services/logs',
    { config: rateLimit(60), onRequest: requireActive },
    async (req) => {
      const { vm } = access(req);
      const q = z
        .object({
          unit: unitName,
          lines: z.coerce.number().int().min(1).max(MAX_LOG_LINES).default(100),
        })
        .parse(req.query);
      return withVm(ctx, vm, async (lease) => {
        await assertUnitExists(vm, lease, q.unit);
        const r = await run(vm, lease, [
          'journalctl',
          '--unit',
          q.unit,
          '-n',
          String(q.lines),
          '--no-pager',
          '-o',
          'short-iso',
        ]);
        if (r.code !== 0)
          throw new AppError(
            422,
            'logs_failed',
            'Gagal membaca log service. Pastikan journald aktif di VM.',
          );
        return {
          unit: q.unit,
          lines: q.lines,
          log: r.stdout.slice(-256 * 1024),
          truncated: r.truncated,
        };
      });
    },
  );
}
