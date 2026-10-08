import { rateLimit } from '../../ratelimit.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actor, requireActive } from '../../auth/plugin.js';
import type { Ctx } from '../../context.js';
import { AppError, notFound } from '../../errors.js';
import { assertVmAccess, type VmRow } from '../../rbac/index.js';
import { execRemote, type ExecResult } from '../../ssh/exec.js';
import type { Lease } from '../../ssh/pool.js';
import { Sftp } from '../files/sftp.js';
import { toPublicJob, type JobControl } from '../jobs/service.js';
import { runSteps, type Step } from '../software/install.js';
import { parseDpkg } from '../software/status.js';
import { privOpts, withVm } from '../vms/service.js';
import {
  ARTISAN_COMMANDS,
  deploySteps,
  phpIn,
  type ArtisanCommand,
  type DeployOptions,
} from './deploy.js';
import {
  confAvailable,
  confEnabled,
  DOMAIN_RE,
  docRoot,
  nginxConf,
  phpSocket,
  siteRoot,
  type SiteKind,
} from './nginx.js';

interface SiteRow {
  id: string;
  vm_id: string;
  domain: string;
  kind: SiteKind;
  php_version: string | null;
  root_path: string;
  created_at: number;
}

const vmParams = z.object({ vmId: z.string().uuid() });
const siteParams = z.object({ vmId: z.string().uuid(), siteId: z.string().uuid() });
const phpVersion = z.string().regex(/^[5-9]\.\d$/, 'Versi PHP tidak valid.');
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(DOMAIN_RE, 'Domain tidak valid. Contoh: blog.contoh.com (huruf kecil, tanpa http://).');
const RELOAD = ['sh', '-c', 'systemctl reload nginx 2>/dev/null || nginx -s reload'];

const toPublic = (s: SiteRow) => ({
  id: s.id,
  domain: s.domain,
  kind: s.kind,
  phpVersion: s.php_version,
  rootPath: s.root_path,
  docRoot: docRoot(s.domain, s.kind),
  envPath: s.kind === 'laravel' ? `${s.root_path}/.env` : null,
  createdAt: s.created_at,
});

export function siteRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, audit } = ctx;
  const maxBytes = ctx.env.MAX_UPLOAD_MB * 1024 * 1024;

  const access = (req: FastifyRequest): { vm: VmRow; userId: string } => {
    const { vmId } = vmParams.parse(req.params);
    const user = actor(req);
    return { vm: assertVmAccess(db, user, vmId, 'sites'), userId: user.id };
  };
  const loadSite = (vm: VmRow, siteId: string): SiteRow => {
    const s = db.prepare('SELECT * FROM sites WHERE id = ? AND vm_id = ?').get(siteId, vm.id) as
      SiteRow | undefined;
    if (!s) throw notFound('Situs');
    return s;
  };
  const rec = (
    req: FastifyRequest,
    vm: VmRow,
    userId: string,
    action: string,
    target: string,
    result: 'ok' | 'fail' = 'ok',
    meta?: Record<string, unknown>,
  ) =>
    audit.record({
      userId,
      vmId: vm.id,
      ip: req.ip,
      action: `site.${action}`,
      target,
      result,
      meta,
    });

  const exec = (
    vm: VmRow,
    lease: Lease,
    argv: string[],
    extra: { stdin?: string; timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<ExecResult> => execRemote(lease.client, argv, { ...privOpts(vm), ...extra });
  const must = async (
    vm: VmRow,
    lease: Lease,
    argv: string[],
    what: string,
    extra: { stdin?: string; timeoutMs?: number } = {},
  ) => {
    const r = await exec(vm, lease, argv, extra);
    if (r.code !== 0)
      throw new AppError(
        422,
        'remote_failed',
        `${what} gagal: ${(r.stderr || r.stdout).trim().slice(0, 300) || 'tanpa pesan'}`,
      );
    return r;
  };

  /** Tulis konfigurasi, aktifkan, uji dengan nginx -t, dan rollback bila ditolak. */
  async function applyNginx(
    vm: VmRow,
    lease: Lease,
    s: { domain: string; kind: SiteKind; phpVersion: string | null },
    previous?: string,
  ): Promise<void> {
    await must(vm, lease, ['tee', confAvailable(s.domain)], 'Menulis konfigurasi nginx', {
      stdin: nginxConf(s.domain, s.kind, s.phpVersion),
    });
    await must(
      vm,
      lease,
      ['ln', '-sf', confAvailable(s.domain), confEnabled(s.domain)],
      'Mengaktifkan situs',
    );
    const test = await exec(vm, lease, ['nginx', '-t']);
    if (test.code !== 0) {
      if (previous !== undefined)
        await exec(vm, lease, ['tee', confAvailable(s.domain)], { stdin: previous });
      else
        await exec(vm, lease, ['rm', '-f', '--', confEnabled(s.domain), confAvailable(s.domain)]);
      throw new AppError(
        422,
        'nginx_rejected',
        `Nginx menolak konfigurasi: ${test.stderr.trim().slice(0, 400)}`,
      );
    }
    await must(vm, lease, RELOAD, 'Memuat ulang nginx');
  }

  app.get('/api/vms/:vmId/sites', { onRequest: requireActive }, async (req) => {
    const { vm } = access(req);
    const rows = db
      .prepare('SELECT * FROM sites WHERE vm_id = ? ORDER BY domain')
      .all(vm.id) as SiteRow[];
    return { items: rows.map(toPublic) };
  });

  /** Prasyarat untuk membuat situs: nginx dan versi PHP yang terpasang. */
  app.get('/api/vms/:vmId/sites/options', { onRequest: requireActive }, async (req) => {
    const { vm } = access(req);
    return withVm(ctx, vm, async (lease) => {
      const [ng, php, comp] = await Promise.all([
        exec(vm, lease, ['sh', '-c', 'command -v nginx']),
        exec(vm, lease, [
          'dpkg-query',
          '-W',
          '-f=${Package}\t${db:Status-Abbrev}\t${Version}\n',
          'php*-fpm',
        ]),
        exec(vm, lease, ['sh', '-c', 'command -v composer']),
      ]);
      const versions = [...parseDpkg(php.stdout).keys()]
        .map((p) => /^php(\d+\.\d+)-fpm$/.exec(p)?.[1])
        .filter((v): v is string => !!v);
      return {
        nginx: ng.code === 0,
        composer: comp.code === 0,
        phpVersions: versions.sort().reverse(),
      };
    });
  });

  app.post('/api/vms/:vmId/sites', { onRequest: requireActive }, async (req, reply) => {
    const { vm, userId } = access(req);
    const b = z
      .object({
        domain,
        kind: z.enum(['laravel', 'php', 'static']),
        phpVersion: phpVersion.optional(),
      })
      .parse(req.body);
    if (b.kind !== 'static' && !b.phpVersion)
      throw new AppError(400, 'php_required', 'Pilih versi PHP untuk situs Laravel/PHP.');
    if (b.kind === 'static' && b.phpVersion)
      throw new AppError(400, 'php_unused', 'Situs statis tidak memakai PHP.');
    if (
      db.prepare('SELECT 1 AS ok FROM sites WHERE vm_id = ? AND domain = ?').get(vm.id, b.domain)
    ) {
      throw new AppError(409, 'site_exists', `Situs ${b.domain} sudah ada di VM ini.`);
    }
    const phpV = b.kind === 'static' ? null : b.phpVersion!;
    const root = siteRoot(b.domain);

    await withVm(ctx, vm, async (lease) => {
      if ((await exec(vm, lease, ['sh', '-c', 'command -v nginx'])).code !== 0) {
        throw new AppError(
          409,
          'nginx_missing',
          'Nginx belum terpasang di VM. Pasang lewat menu Aplikasi terlebih dulu.',
        );
      }
      if (phpV && (await exec(vm, lease, ['test', '-S', phpSocket(phpV)])).code !== 0) {
        throw new AppError(
          409,
          'php_missing',
          `PHP ${phpV} (FPM) belum terpasang atau belum berjalan di VM. Pasang/aktifkan lewat menu Aplikasi.`,
        );
      }
      const sftp = new Sftp(await lease.sftp());
      if (await sftp.exists(confAvailable(b.domain)).catch(() => false)) {
        throw new AppError(
          409,
          'conf_exists',
          `Sudah ada konfigurasi nginx untuk ${b.domain} di VM (bukan dari panel). Hapus atau ganti nama dulu lewat File Manager.`,
        );
      }
      await must(
        vm,
        lease,
        ['mkdir', '-p', '--', docRoot(b.domain, b.kind)],
        'Membuat folder situs',
      );
      // Halaman placeholder hanya bila folder dokumen masih kosong.
      const empty =
        (
          await exec(vm, lease, [
            'sh',
            '-c',
            'test -z "$(ls -A "$1")"',
            'sh',
            docRoot(b.domain, b.kind),
          ])
        ).code === 0;
      if (empty) {
        const page = `<!doctype html><meta charset="utf-8"><title>${b.domain}</title><h1>${b.domain}</h1><p>Situs siap. Upload kode Anda lewat Panel VM.</p>\n`;
        await must(
          vm,
          lease,
          [
            'tee',
            `${docRoot(b.domain, b.kind)}/${b.kind === 'static' ? 'index.html' : 'index.html'}`,
          ],
          'Menulis halaman awal',
          { stdin: page },
        );
      }
      await exec(vm, lease, ['chown', '-R', 'www-data:www-data', '--', root]);
      await applyNginx(vm, lease, { domain: b.domain, kind: b.kind, phpVersion: phpV });
    });

    const id = randomUUID();
    db.prepare(
      'INSERT INTO sites (id, vm_id, domain, kind, php_version, root_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, vm.id, b.domain, b.kind, phpV, root, Date.now());
    rec(req, vm, userId, 'create', b.domain, 'ok', { kind: b.kind, php: phpV });
    reply.code(201);
    return toPublic(loadSite(vm, id));
  });

  app.post('/api/vms/:vmId/sites/:siteId/php', { onRequest: requireActive }, async (req) => {
    const { vm, userId } = access(req);
    const { siteId } = siteParams.parse(req.params);
    const site = loadSite(vm, siteId);
    if (site.kind === 'static')
      throw new AppError(400, 'static_site', 'Situs statis tidak memakai PHP.');
    const { phpVersion: v } = z.object({ phpVersion }).parse(req.body);
    await withVm(ctx, vm, async (lease) => {
      if ((await exec(vm, lease, ['test', '-S', phpSocket(v)])).code !== 0) {
        throw new AppError(
          409,
          'php_missing',
          `PHP ${v} (FPM) belum terpasang atau belum berjalan di VM. Pasang lewat menu Aplikasi.`,
        );
      }
      await applyNginx(
        vm,
        lease,
        { domain: site.domain, kind: site.kind, phpVersion: v },
        nginxConf(site.domain, site.kind, site.php_version),
      );
    });
    db.prepare('UPDATE sites SET php_version = ? WHERE id = ?').run(v, site.id);
    rec(req, vm, userId, 'php_change', site.domain, 'ok', { from: site.php_version, to: v });
    return toPublic(loadSite(vm, site.id));
  });

  app.post('/api/vms/:vmId/sites/:siteId/delete', { onRequest: requireActive }, async (req) => {
    const { vm, userId } = access(req);
    const { siteId } = siteParams.parse(req.params);
    const site = loadSite(vm, siteId);
    const b = z
      .object({ confirm: z.string(), deleteFiles: z.boolean().default(false) })
      .parse(req.body);
    if (b.confirm !== site.domain)
      throw new AppError(
        400,
        'confirm_mismatch',
        'Konfirmasi tidak cocok. Ketik domain situs persis untuk menghapus.',
      );
    await withVm(ctx, vm, async (lease) => {
      await must(
        vm,
        lease,
        ['rm', '-f', '--', confEnabled(site.domain), confAvailable(site.domain)],
        'Menghapus konfigurasi nginx',
      );
      const test = await exec(vm, lease, ['nginx', '-t']);
      if (test.code === 0) await exec(vm, lease, RELOAD);
      // Path dibangun ulang dari domain tervalidasi, bukan dari nilai tersimpan.
      if (b.deleteFiles && DOMAIN_RE.test(site.domain))
        await must(vm, lease, ['rm', '-rf', '--', siteRoot(site.domain)], 'Menghapus file situs', {
          timeoutMs: 5 * 60_000,
        });
    });
    db.prepare('DELETE FROM sites WHERE id = ?').run(site.id);
    rec(req, vm, userId, 'delete', site.domain, 'ok', { deleteFiles: b.deleteFiles });
    return { ok: true };
  });

  /** Perintah artisan dari daftar tetap (Laravel). Keluaran dibatasi 64 KB. */
  app.post(
    '/api/vms/:vmId/sites/:siteId/artisan',
    { config: rateLimit(30), onRequest: requireActive },
    async (req) => {
      const { vm, userId } = access(req);
      const { siteId } = siteParams.parse(req.params);
      const site = loadSite(vm, siteId);
      if (site.kind !== 'laravel' || !site.php_version)
        throw new AppError(400, 'not_laravel', 'Perintah artisan hanya untuk situs Laravel.');
      const { command } = z
        .object({
          command: z.enum(Object.keys(ARTISAN_COMMANDS) as [ArtisanCommand, ...ArtisanCommand[]]),
        })
        .parse(req.body);
      const r = await withVm(ctx, vm, (lease) =>
        exec(
          vm,
          lease,
          phpIn(site.root_path, site.php_version!, ['artisan', ...ARTISAN_COMMANDS[command]]),
          { timeoutMs: 10 * 60_000 },
        ),
      );
      rec(req, vm, userId, 'artisan', site.domain, r.code === 0 ? 'ok' : 'fail', { command });
      return { command, code: r.code, output: `${r.stdout}${r.stderr}`.slice(-64 * 1024) };
    },
  );

  const deployQuery = z.object({
    filename: z.string().min(1).max(255),
    composer: z.enum(['true', 'false']).default('true'),
    migrate: z.enum(['true', 'false']).default('false'),
    optimize: z.enum(['true', 'false']).default('false'),
  });
  const optsFrom = (q: z.infer<typeof deployQuery>): DeployOptions => ({
    composer: q.composer === 'true',
    migrate: q.migrate === 'true',
    optimize: q.optimize === 'true',
  });

  /** Langkah umum: kosongkan staging, ambil source (ekstrak/clone), ratakan folder tunggal, lalu deploySteps. */
  async function runDeploy(
    vm: VmRow,
    site: SiteRow,
    lease: Lease,
    prepare: (stage: string) => Step[],
    opts: DeployOptions,
    extraExcludes: string[],
    log: (t: string) => void,
    ctl: JobControl,
  ): Promise<void> {
    const stage = `/var/www/.panel-staging-${randomBytes(6).toString('hex')}`;
    const sftp = new Sftp(await lease.sftp());
    // "Update" = aplikasi sudah pernah dideploy (ada artisan). Halaman placeholder bukan deploy sebelumnya.
    const isUpdate = site.kind === 'laravel' && (await sftp.exists(`${site.root_path}/artisan`));
    const envExists = await sftp.exists(`${site.root_path}/.env`);
    try {
      await runSteps(
        lease.client,
        privOpts(vm),
        [
          { title: 'Siapkan folder staging', argv: ['mkdir', '-p', '--', stage] },
          ...prepare(stage),
        ],
        log,
      );
      // Hapus sampah macOS dan ratakan bila arsip hanya berisi satu folder.
      await exec(vm, lease, ['rm', '-rf', '--', `${stage}/__MACOSX`]);
      const ls = await exec(vm, lease, ['ls', '-A', '--', stage]);
      const entries = ls.stdout.split('\n').filter(Boolean);
      let source = stage;
      if (
        entries.length === 1 &&
        (await exec(vm, lease, ['test', '-d', `${stage}/${entries[0]}`])).code === 0
      ) {
        source = `${stage}/${entries[0]}`;
        log(`\nArsip berisi satu folder ("${entries[0]}"); isinya dipakai sebagai root situs.\n`);
      }
      if (entries.length === 0)
        throw new AppError(
          422,
          'empty_source',
          'Source code kosong. Periksa arsip atau repositori Anda.',
        );
      if (
        site.kind === 'laravel' &&
        (await exec(vm, lease, ['test', '-f', `${source}/artisan`])).code !== 0
      ) {
        log(
          '\n[peringatan] File "artisan" tidak ditemukan; ini tidak terlihat seperti proyek Laravel. Proses dilanjutkan.\n',
        );
      }
      await runSteps(
        lease.client,
        privOpts(vm),
        deploySteps({
          domain: site.domain,
          kind: site.kind,
          phpVersion: site.php_version,
          sourceDir: source,
          stageDir: stage,
          isUpdate,
          envExists,
          opts,
          extraExcludes,
        }),
        log,
        ctl,
      );
      log('\n[SELESAI] Deploy berhasil.\n');
    } finally {
      await exec(vm, lease, ['rm', '-rf', '--', stage]).catch(() => {});
    }
  }

  app.post(
    '/api/vms/:vmId/sites/:siteId/deploy',
    { config: rateLimit(10), onRequest: requireActive, bodyLimit: maxBytes },
    async (req) => {
      const { vm, userId } = access(req);
      const { siteId } = siteParams.parse(req.params);
      const site = loadSite(vm, siteId);
      const q = deployQuery.parse(req.query);
      const lower = q.filename.toLowerCase();
      const zip = lower.endsWith('.zip');
      if (!zip && !/\.(tar\.gz|tgz|tar)$/.test(lower))
        throw new AppError(400, 'bad_archive', 'Format didukung: .zip, .tar.gz, .tgz, .tar.');
      if (ctx.jobs.hasRunning(vm.id))
        throw new AppError(
          409,
          'job_running',
          'Masih ada proses lain yang berjalan di VM ini. Tunggu sampai selesai, lalu unggah lagi.',
        );
      const declared = Number(req.headers['content-length'] ?? NaN);
      if (!Number.isFinite(declared))
        throw new AppError(
          411,
          'length_required',
          'Ukuran file tidak diketahui. Unggah lewat halaman Situs Web.',
        );
      if (declared > maxBytes)
        throw new AppError(
          413,
          'too_large',
          `Arsip melebihi batas ${ctx.env.MAX_UPLOAD_MB} MB. Hapus folder vendor/node_modules dari arsip (akan dipasang ulang lewat composer), atau unggah lewat terminal.`,
        );

      const archive = `/tmp/panel-deploy-${randomBytes(6).toString('hex')}${zip ? '.zip' : lower.endsWith('.tar') ? '.tar' : '.tar.gz'}`;
      let received = 0;
      // Unggah streaming ke /tmp di VM (SFTP, tanpa menampung di memori panel).
      await withVm(ctx, vm, async (lease) => {
        const s = new Sftp(await lease.sftp());
        const limiter = new Transform({
          transform(chunk: Buffer, _e, cb) {
            received += chunk.length;
            if (received > maxBytes)
              return cb(
                new AppError(413, 'too_large', `Arsip melebihi batas ${ctx.env.MAX_UPLOAD_MB} MB.`),
              );
            cb(null, chunk);
          },
        });
        try {
          await pipeline(
            req.body as Readable,
            limiter,
            s.raw.createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
          );
        } catch (e) {
          await s.unlink(archive).catch(() => {});
          throw e instanceof AppError
            ? e
            : new AppError(502, 'upload_failed', 'Unggah ke VM terputus. Coba lagi.');
        }
      });

      const opts = optsFrom(q);
      const job = ctx.jobs.start(
        {
          vmId: vm.id,
          userId,
          ip: req.ip,
          kind: 'deploy',
          title: `Deploy ${site.domain}`,
          vmName: vm.name,
        },
        (log, ctl) =>
          withVm(ctx, vm, async (lease) => {
            log(`Arsip ${q.filename} (${received.toLocaleString('en-US')} byte) diterima.\n`);
            try {
              await runDeploy(
                vm,
                site,
                lease,
                (stage) => [
                  zip
                    ? {
                        title: 'Ekstrak arsip zip',
                        argv: ['unzip', '-q', '-o', archive, '-d', stage],
                        timeoutMs: 10 * 60_000,
                      }
                    : {
                        title: 'Ekstrak arsip tar',
                        argv: ['tar', '-xf', archive, '-C', stage],
                        timeoutMs: 10 * 60_000,
                      },
                ],
                opts,
                [],
                log,
                ctl,
              );
            } finally {
              await exec(vm, lease, ['rm', '-f', '--', archive]).catch(() => {});
            }
          }),
      );
      rec(req, vm, userId, 'deploy_upload', site.domain, 'ok', {
        bytes: received,
        composer: opts.composer,
        migrate: opts.migrate,
      });
      return toPublicJob(job, false);
    },
  );

  app.post(
    '/api/vms/:vmId/sites/:siteId/deploy-git',
    { config: rateLimit(10), onRequest: requireActive },
    async (req) => {
      const { vm, userId } = access(req);
      const { siteId } = siteParams.parse(req.params);
      const site = loadSite(vm, siteId);
      const b = z
        .object({
          // Hanya HTTPS publik tanpa kredensial; repositori privat memakai upload arsip.
          url: z
            .string()
            .max(300)
            .regex(
              /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._~/-]+$/i,
              'URL harus https:// tanpa kredensial, contoh https://github.com/user/repo.git',
            ),
          branch: z
            .string()
            .max(100)
            .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'Nama branch tidak valid.')
            .default('main'),
          composer: z.boolean().default(true),
          migrate: z.boolean().default(false),
          optimize: z.boolean().default(false),
        })
        .parse(req.body);
      const opts: DeployOptions = {
        composer: b.composer,
        migrate: b.migrate,
        optimize: b.optimize,
      };
      const job = ctx.jobs.start(
        {
          vmId: vm.id,
          userId,
          ip: req.ip,
          kind: 'deploy',
          title: `Deploy ${site.domain} dari Git`,
          vmName: vm.name,
        },
        (log, ctl) =>
          withVm(ctx, vm, (lease) =>
            runDeploy(
              vm,
              site,
              lease,
              (stage) => [
                {
                  title: `Clone ${b.url} (branch ${b.branch})`,
                  argv: [
                    'git',
                    'clone',
                    '--depth',
                    '1',
                    '--branch',
                    b.branch,
                    '--',
                    b.url,
                    `${stage}/src`,
                  ],
                  env: { GIT_TERMINAL_PROMPT: '0' },
                  timeoutMs: 10 * 60_000,
                },
              ],
              opts,
              ['./.git'],
              log,
              ctl,
            ),
          ),
      );
      rec(req, vm, userId, 'deploy_git', site.domain, 'ok', { url: b.url, branch: b.branch });
      return toPublicJob(job, false);
    },
  );
}
