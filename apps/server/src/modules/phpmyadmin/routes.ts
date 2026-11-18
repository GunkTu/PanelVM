import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actor, requireActive } from '../../auth/plugin.js';
import type { Ctx } from '../../context.js';
import { AppError } from '../../errors.js';
import { rateLimit } from '../../ratelimit.js';
import { assertVmAccess, parseModules, type VmRow } from '../../rbac/index.js';
import { execRemote, type ExecResult } from '../../ssh/exec.js';
import type { Lease } from '../../ssh/pool.js';
import { toPublicJob } from '../jobs/service.js';
import { ticketUrl } from '../previews/gate.js';
import { newSubdomain, PERMANENT_EXPIRES_AT, type PreviewRow } from '../previews/service.js';
import { runSteps, type Step } from '../software/install.js';
import { privOpts, withVm } from '../vms/service.js';
import {
  DETECT_ROOT_SCRIPT,
  DETECT_VERSION_SCRIPT,
  DOWNLOAD_SCRIPT,
  newBlowfishSecret,
  PMA_CONF_AVAILABLE,
  PMA_CONF_ENABLED,
  PMA_DIR,
  PMA_PORT,
  PMA_TMP,
  PMA_URL,
  pmaConfig,
  pmaNginxConf,
} from './spec.js';

const vmParams = z.object({ vmId: z.string().uuid() });

interface PmaRow {
  vm_id: string;
  php_version: string;
  port: number;
  version: string | null;
  installed_at: number;
}

export function phpMyAdminRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, audit } = ctx;

  const access = (req: FastifyRequest): { vm: VmRow; userId: string } => {
    const { vmId } = vmParams.parse(req.params);
    const user = actor(req);
    return { vm: assertVmAccess(db, user, vmId, 'database'), userId: user.id };
  };
  const row = (vmId: string) =>
    db.prepare('SELECT * FROM vm_phpmyadmin WHERE vm_id = ?').get(vmId) as PmaRow | undefined;
  const rec = (
    req: FastifyRequest,
    vm: VmRow,
    userId: string,
    action: string,
    result: 'ok' | 'fail' = 'ok',
    meta?: Record<string, unknown>,
  ) =>
    audit.record({
      userId,
      vmId: vm.id,
      ip: req.ip,
      action: `pma.${action}`,
      target: vm.name,
      result,
      meta,
    });
  const exec = (
    vm: VmRow,
    lease: Lease,
    argv: string[],
    extra: { stdin?: string; timeoutMs?: number } = {},
  ): Promise<ExecResult> => execRemote(lease.client, argv, { ...privOpts(vm), ...extra });

  const previewsReady = (vm: VmRow): boolean =>
    ctx.previews.enabled && parseModules(vm.modules_enabled).previews;

  app.get(
    '/api/vms/:vmId/phpmyadmin',
    { config: rateLimit(30), onRequest: requireActive },
    async (req) => {
      const { vm } = access(req);
      const r = row(vm.id);
      const phpVersions = await withVm(ctx, vm, async (lease) => {
        const ls = await exec(vm, lease, ['sh', '-c', 'ls /run/php 2>/dev/null; true']);
        return [...ls.stdout.matchAll(/^php(\d\.\d)-fpm\.sock$/gm)].map((m) => m[1]!);
      });
      return {
        installed: !!r,
        version: r?.version ?? null,
        phpVersion: r?.php_version ?? null,
        installedAt: r?.installed_at ?? null,
        phpVersions,
        canOpen: previewsReady(vm),
        cantOpenReason: !ctx.previews.enabled
          ? 'Fitur preview belum diaktifkan di server (PREVIEW_BASE_DOMAIN). Hubungi admin.'
          : !parseModules(vm.modules_enabled).previews
            ? 'Modul Preview Web belum aktif untuk VM ini. Minta admin mengaktifkannya.'
            : null,
      };
    },
  );

  app.post(
    '/api/vms/:vmId/phpmyadmin/install',
    { config: rateLimit(5), onRequest: requireActive },
    async (req) => {
      const { vm, userId } = access(req);
      const b = z
        .object({ phpVersion: z.string().regex(/^[5-9]\.\d$/, 'Versi PHP tidak valid.') })
        .parse(req.body);

      await withVm(ctx, vm, async (lease) => {
        if ((await exec(vm, lease, ['sh', '-c', 'command -v nginx'])).code !== 0)
          throw new AppError(
            409,
            'need_nginx',
            'phpMyAdmin dilayani lewat Nginx, tetapi Nginx belum terpasang di VM. Pasang Nginx lewat menu Aplikasi (Apache belum didukung untuk fitur ini).',
          );
        if (
          (await exec(vm, lease, ['test', '-S', `/run/php/php${b.phpVersion}-fpm.sock`])).code !== 0
        )
          throw new AppError(
            409,
            'php_missing',
            `PHP ${b.phpVersion} (FPM) belum terpasang atau belum berjalan di VM. Pasang lewat menu Aplikasi, lalu coba lagi.`,
          );
        if ((await exec(vm, lease, ['sh', '-c', 'command -v curl'])).code !== 0)
          throw new AppError(
            409,
            'curl_missing',
            'curl belum terpasang di VM. Pasang "Alat dasar" lewat menu Aplikasi, lalu coba lagi.',
          );
      });

      const id = String(Date.now());
      const release = `${PMA_DIR}/releases/${id}`;
      const prior = row(vm.id);

      const job = ctx.jobs.start(
        {
          vmId: vm.id,
          userId,
          ip: req.ip,
          kind: 'install',
          title: prior ? 'Perbarui phpMyAdmin' : 'Pasang phpMyAdmin',
          vmName: vm.name,
        },
        (log, ctl) =>
          withVm(ctx, vm, async (lease) => {
            const run = (steps: Step[]) => runSteps(lease.client, privOpts(vm), steps, log, ctl);
            await run([
              {
                title: 'Siapkan folder',
                argv: ['mkdir', '-p', '--', `${PMA_DIR}/releases`, PMA_TMP],
              },
              {
                title: 'Unduh phpMyAdmin resmi dan verifikasi checksum',
                argv: ['sh', '-c', DOWNLOAD_SCRIPT, 'sh', PMA_URL, id, PMA_DIR],
                timeoutMs: 10 * 60_000,
                hideCommand: true,
              },
              {
                title: 'Tulis konfigurasi (login hanya dengan user database biasa)',
                argv: ['tee', '--', `${release}/config.inc.php`],
                stdin: pmaConfig(newBlowfishSecret()),
                hideCommand: true,
              },
              {
                title: 'Atur izin file',
                argv: [
                  'sh',
                  '-c',
                  'chown -R root:www-data "$1" && chmod -R u=rwX,g=rX,o= "$1" && chown -R www-data:www-data "$2" && chmod 700 "$2"',
                  'sh',
                  release,
                  '/var/lib/phpmyadmin',
                ],
              },
            ]);
            const rootRel =
              (
                await exec(vm, lease, ['sh', '-c', DETECT_ROOT_SCRIPT, 'sh', release])
              ).stdout.trim() === 'public'
                ? 'public'
                : '.';
            await run([
              { title: 'Aktifkan rilis baru', argv: ['ln', '-sfn', release, `${PMA_DIR}/current`] },
              {
                title: 'Tulis konfigurasi Nginx (hanya 127.0.0.1)',
                argv: ['tee', '--', PMA_CONF_AVAILABLE],
                stdin: pmaNginxConf(b.phpVersion, rootRel, PMA_PORT),
                hideCommand: true,
              },
              {
                title: 'Aktifkan situs',
                argv: ['ln', '-sf', PMA_CONF_AVAILABLE, PMA_CONF_ENABLED],
              },
              {
                title: 'Uji konfigurasi Nginx',
                argv: [
                  'sh',
                  '-c',
                  'nginx -t || { rm -f "$1" "$2"; exit 1; }',
                  'sh',
                  PMA_CONF_ENABLED,
                  PMA_CONF_AVAILABLE,
                ],
              },
              {
                title: 'Muat ulang Nginx',
                argv: ['sh', '-c', 'systemctl reload nginx 2>/dev/null || nginx -s reload'],
              },
              {
                title: 'Hapus rilis lama (simpan 2 terbaru)',
                argv: [
                  'sh',
                  '-c',
                  'cd "$1" && ls -1t | tail -n +3 | while read -r d; do rm -rf -- "$d"; done',
                  'sh',
                  `${PMA_DIR}/releases`,
                ],
                tolerateFail: true,
              },
            ]);
            const version =
              (await exec(vm, lease, ['sh', '-c', DETECT_VERSION_SCRIPT, 'sh', release])).stdout
                .trim()
                .split('\n')[0] || null;
            db.prepare(
              `INSERT INTO vm_phpmyadmin (vm_id, php_version, port, version, installed_at) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(vm_id) DO UPDATE SET php_version = excluded.php_version, port = excluded.port, version = excluded.version, installed_at = excluded.installed_at`,
            ).run(vm.id, b.phpVersion, PMA_PORT, version, Date.now());
            log(
              `\nphpMyAdmin${version ? ` ${version}` : ''} siap. Klik "Buka phpMyAdmin" di halaman Database.\n`,
            );
          }),
      );
      rec(req, vm, userId, prior ? 'update' : 'install', 'ok', { php: b.phpVersion });
      return toPublicJob(job, false);
    },
  );

  /** Tiket sekali pakai (berlaku 60 detik) untuk membuka phpMyAdmin di host preview terpisah. */
  app.post(
    '/api/vms/:vmId/phpmyadmin/open',
    { config: rateLimit(20), onRequest: requireActive },
    async (req) => {
      const { vm, userId } = access(req);
      const r = row(vm.id);
      if (!r)
        throw new AppError(
          409,
          'pma_missing',
          'phpMyAdmin belum dipasang di VM ini. Klik "Pasang phpMyAdmin" dulu.',
        );
      if (!previewsReady(vm))
        throw new AppError(
          503,
          'previews_unavailable',
          'phpMyAdmin dibuka lewat fitur preview, tetapi preview belum aktif (PREVIEW_BASE_DOMAIN di server atau modul Preview Web di VM ini). Hubungi admin.',
        );
      // Preview milik sistem dimiliki pemilik VM (validasi preview mengecek pemilik aktif).
      const owner = db.prepare('SELECT user_id FROM vm_access WHERE vm_id = ?').get(vm.id) as
        { user_id: string } | undefined;
      if (!owner)
        throw new AppError(
          409,
          'no_owner',
          'VM ini belum dihubungkan ke akun client, jadi phpMyAdmin belum bisa dibuka. Hubungkan VM ke client lewat menu Kelola VM.',
        );

      let p = db
        .prepare("SELECT * FROM previews WHERE vm_id = ? AND purpose = 'pma'")
        .get(vm.id) as PreviewRow | undefined;
      if (p && (p.user_id !== owner.user_id || p.port !== r.port)) {
        ctx.previews.remove(p.id);
        p = undefined;
      }
      if (!p) {
        const id = randomUUID();
        db.prepare(
          `INSERT INTO previews (id, vm_id, user_id, subdomain, port, label, host_header, access, password_hash, created_at, expires_at, purpose)
           VALUES (?, ?, ?, ?, ?, 'phpMyAdmin', NULL, 'password', NULL, ?, ?, 'pma')`,
        ).run(id, vm.id, owner.user_id, newSubdomain(), r.port, Date.now(), PERMANENT_EXPIRES_AT);
        p = db.prepare('SELECT * FROM previews WHERE id = ?').get(id) as PreviewRow;
      }
      rec(req, vm, userId, 'open');
      return { url: ticketUrl(ctx, p) };
    },
  );

  app.post(
    '/api/vms/:vmId/phpmyadmin/uninstall',
    { config: rateLimit(5), onRequest: requireActive },
    async (req) => {
      const { vm, userId } = access(req);
      const { confirm } = z.object({ confirm: z.string() }).parse(req.body);
      if (confirm !== 'phpmyadmin')
        throw new AppError(
          400,
          'confirm_mismatch',
          'Konfirmasi tidak cocok. Ketik "phpmyadmin" untuk menghapus.',
        );
      if (!row(vm.id))
        throw new AppError(409, 'pma_missing', 'phpMyAdmin tidak terpasang di VM ini.');
      await withVm(ctx, vm, async (lease) => {
        await exec(vm, lease, ['rm', '-f', '--', PMA_CONF_ENABLED, PMA_CONF_AVAILABLE]);
        if ((await exec(vm, lease, ['nginx', '-t'])).code === 0)
          await exec(vm, lease, [
            'sh',
            '-c',
            'systemctl reload nginx 2>/dev/null || nginx -s reload',
          ]);
        // Hanya folder tetap milik panel; database pengguna tidak disentuh.
        await exec(vm, lease, ['rm', '-rf', '--', PMA_DIR, '/var/lib/phpmyadmin'], {
          timeoutMs: 120_000,
        });
      });
      const p = db
        .prepare("SELECT id FROM previews WHERE vm_id = ? AND purpose = 'pma'")
        .get(vm.id) as { id: string } | undefined;
      if (p) ctx.previews.remove(p.id);
      db.prepare('DELETE FROM vm_phpmyadmin WHERE vm_id = ?').run(vm.id);
      rec(req, vm, userId, 'uninstall');
      return { ok: true };
    },
  );
}
