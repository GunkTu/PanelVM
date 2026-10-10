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
import { APACHE_MODULES } from './apache.js';
import {
  defaultDocRootRel,
  DOC_ROOT_RE,
  DOMAIN_RE,
  docRoot,
  phpSocket,
  siteRoot,
  type SiteKind,
} from './nginx.js';
import { WEB_SERVERS, type WebServer } from './webserver.js';
import { findDirsArgv, parseDirListing, suggestDocRoot } from './docroot.js';
import {
  archiveKindOrThrow,
  DETECT_SCRIPT,
  DOWNLOAD_SCRIPT,
  normalizeDownloadUrl,
} from './download.js';

interface SiteRow {
  id: string;
  vm_id: string;
  domain: string;
  kind: SiteKind;
  php_version: string | null;
  root_path: string;
  web_server: WebServer;
  /** NULL = bawaan menurut jenis situs; "." = folder utama; selain itu subfolder relatif. */
  doc_root: string | null;
  /** 1 = situs utama Nginx (default_server): melayani Host yang tidak cocok dengan domain mana pun. */
  is_default: number;
  created_at: number;
}

/** Tulisan halaman awal buatan panel; dipakai juga untuk mengenalinya saat deploy. */
const PLACEHOLDER_TEXT = 'Situs siap. Upload kode Anda lewat Panel VM.';

const vmParams = z.object({ vmId: z.string().uuid() });
const siteParams = z.object({ vmId: z.string().uuid(), siteId: z.string().uuid() });
const phpVersion = z.string().regex(/^[5-9]\.\d$/, 'Versi PHP tidak valid.');
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(DOMAIN_RE, 'Domain tidak valid. Contoh: blog.contoh.com (huruf kecil, tanpa http://).');
const webServerField = z.enum(['nginx', 'apache']);

const toPublic = (s: SiteRow) => ({
  id: s.id,
  domain: s.domain,
  kind: s.kind,
  phpVersion: s.php_version,
  webServer: s.web_server,
  rootPath: s.root_path,
  docRoot: docRoot(s.domain, s.kind, s.doc_root),
  /** Folder dokumen relatif ("." = folder utama) dan apakah masih mengikuti bawaan jenis situs. */
  docRootRel: s.doc_root ?? defaultDocRootRel(s.kind),
  docRootAuto: s.doc_root === null,
  isDefault: s.is_default === 1,
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

  /** Konfigurasi situs yang sedang berlaku (untuk rollback saat konfigurasi baru ditolak). */
  const confOf = (s: SiteRow): string =>
    WEB_SERVERS[s.web_server].conf(s.domain, s.kind, s.php_version, s.doc_root, s.is_default === 1);

  /**
   * Tulis konfigurasi, aktifkan, uji sintaks (nginx -t / apache2ctl configtest), dan rollback bila ditolak.
   * Untuk Apache, modul yang dibutuhkan (rewrite, proxy_fcgi, dst.) diaktifkan lebih dulu.
   */
  async function applyWebServer(
    vm: VmRow,
    lease: Lease,
    server: WebServer,
    s: {
      domain: string;
      kind: SiteKind;
      phpVersion: string | null;
      docRoot: string | null;
      isDefault?: boolean;
    },
    previous?: string,
  ): Promise<void> {
    const ws = WEB_SERVERS[server];
    if (server === 'apache')
      await must(vm, lease, ['a2enmod', '-q', ...APACHE_MODULES], 'Mengaktifkan modul Apache');
    await must(vm, lease, ['tee', ws.available(s.domain)], `Menulis konfigurasi ${ws.title}`, {
      stdin: ws.conf(s.domain, s.kind, s.phpVersion, s.docRoot, s.isDefault ?? false),
    });
    await must(
      vm,
      lease,
      ['ln', '-sf', ws.available(s.domain), ws.enabled(s.domain)],
      'Mengaktifkan situs',
    );
    const test = await exec(vm, lease, ws.test);
    if (test.code !== 0) {
      if (previous !== undefined)
        await exec(vm, lease, ['tee', ws.available(s.domain)], { stdin: previous });
      else await exec(vm, lease, ['rm', '-f', '--', ws.enabled(s.domain), ws.available(s.domain)]);
      throw new AppError(
        422,
        'webserver_rejected',
        `${ws.title} menolak konfigurasi: ${`${test.stderr}${test.stdout}`.trim().slice(0, 400)}`,
      );
    }
    await must(vm, lease, ws.reload, `Memuat ulang ${ws.title}`);
  }

  app.get('/api/vms/:vmId/sites', { onRequest: requireActive }, async (req) => {
    const { vm } = access(req);
    const rows = db
      .prepare('SELECT * FROM sites WHERE vm_id = ? ORDER BY domain')
      .all(vm.id) as SiteRow[];
    return { items: rows.map(toPublic) };
  });

  /** Prasyarat untuk membuat situs: web server (Nginx atau Apache) dan versi PHP yang terpasang. */
  app.get('/api/vms/:vmId/sites/options', { onRequest: requireActive }, async (req) => {
    const { vm } = access(req);
    return withVm(ctx, vm, async (lease) => {
      const [ng, ap, php, comp] = await Promise.all([
        exec(vm, lease, WEB_SERVERS.nginx.detect),
        exec(vm, lease, WEB_SERVERS.apache.detect),
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
      const nginx = ng.code === 0;
      const apache = ap.code === 0;
      return {
        nginx,
        apache,
        /** Web server yang dipakai situs baru; null bila belum ada, "both" bila keduanya ada (harus memilih). */
        webServer: nginx && apache ? 'both' : nginx ? 'nginx' : apache ? 'apache' : null,
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
        /** Wajib hanya bila VM punya Nginx dan Apache sekaligus (terpasang di luar panel). */
        webServer: webServerField.optional(),
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

    let server: WebServer = 'nginx';
    await withVm(ctx, vm, async (lease) => {
      const [hasNginx, hasApache] = await Promise.all([
        exec(vm, lease, WEB_SERVERS.nginx.detect).then((r) => r.code === 0),
        exec(vm, lease, WEB_SERVERS.apache.detect).then((r) => r.code === 0),
      ]);
      const installed = ([hasNginx && 'nginx', hasApache && 'apache'] as const).filter(
        (x): x is WebServer => !!x,
      );
      if (installed.length === 0) {
        throw new AppError(
          409,
          'webserver_missing',
          'Belum ada web server di VM. Pasang Nginx atau Apache (pilih salah satu) lewat menu Aplikasi terlebih dulu.',
        );
      }
      if (b.webServer) {
        if (!installed.includes(b.webServer))
          throw new AppError(
            409,
            'webserver_not_installed',
            `${WEB_SERVERS[b.webServer].title} belum terpasang di VM ini. Pasang lewat menu Aplikasi atau pilih web server yang sudah ada.`,
          );
        server = b.webServer;
      } else if (installed.length === 1) {
        server = installed[0]!;
      } else {
        throw new AppError(
          400,
          'webserver_choice',
          'VM ini punya Nginx dan Apache sekaligus. Pilih web server mana yang dipakai untuk situs ini.',
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
      if (await sftp.exists(WEB_SERVERS[server].available(b.domain)).catch(() => false)) {
        throw new AppError(
          409,
          'conf_exists',
          `Sudah ada konfigurasi ${WEB_SERVERS[server].title} untuk ${b.domain} di VM (bukan dari panel). Hapus atau ganti nama dulu lewat File Manager.`,
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
        const page = `<!doctype html><meta charset="utf-8"><title>${b.domain}</title><h1>${b.domain}</h1><p>${PLACEHOLDER_TEXT}</p>\n`;
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
      await applyWebServer(vm, lease, server, {
        domain: b.domain,
        kind: b.kind,
        phpVersion: phpV,
        docRoot: null,
      });
    });

    const id = randomUUID();
    db.prepare(
      'INSERT INTO sites (id, vm_id, domain, kind, php_version, root_path, web_server, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, vm.id, b.domain, b.kind, phpV, root, server, Date.now());
    rec(req, vm, userId, 'create', b.domain, 'ok', { kind: b.kind, php: phpV, server });
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
      await applyWebServer(
        vm,
        lease,
        site.web_server,
        {
          domain: site.domain,
          kind: site.kind,
          phpVersion: v,
          docRoot: site.doc_root,
          isDefault: site.is_default === 1,
        },
        confOf(site),
      );
    });
    db.prepare('UPDATE sites SET php_version = ? WHERE id = ?').run(v, site.id);
    rec(req, vm, userId, 'php_change', site.domain, 'ok', { from: site.php_version, to: v });
    return toPublic(loadSite(vm, site.id));
  });

  /** Daftar folder di dalam situs (dan mana yang berisi index) untuk memilih folder dokumen. */
  app.get('/api/vms/:vmId/sites/:siteId/dirs', { onRequest: requireActive }, async (req) => {
    const { vm } = access(req);
    const { siteId } = siteParams.parse(req.params);
    const site = loadSite(vm, siteId);
    const r = await withVm(ctx, vm, (lease) =>
      exec(vm, lease, findDirsArgv(siteRoot(site.domain)), { timeoutMs: 30_000 }),
    );
    const entries = parseDirListing(r.stdout);
    return {
      current: site.doc_root ?? defaultDocRootRel(site.kind),
      auto: site.doc_root === null,
      defaultPath: defaultDocRootRel(site.kind),
      suggested: suggestDocRoot(site.kind, entries),
      entries,
    };
  });

  /** Pilih folder dokumen (null = kembali ke bawaan menurut jenis situs). Konfigurasi diuji dan di-rollback bila ditolak. */
  app.post(
    '/api/vms/:vmId/sites/:siteId/docroot',
    { config: rateLimit(30), onRequest: requireActive },
    async (req) => {
      const { vm, userId } = access(req);
      const { siteId } = siteParams.parse(req.params);
      const site = loadSite(vm, siteId);
      const { path } = z
        .object({
          path: z
            .string()
            .regex(DOC_ROOT_RE, 'Folder tidak valid. Pilih dari daftar folder situs.')
            .nullable(),
        })
        .parse(req.body);
      await withVm(ctx, vm, async (lease) => {
        const target = docRoot(site.domain, site.kind, path);
        if ((await exec(vm, lease, ['test', '-d', target])).code !== 0) {
          throw new AppError(
            409,
            'docroot_missing',
            'Folder itu belum ada di VM. Deploy kode dulu atau pilih folder lain dari daftar.',
          );
        }
        await applyWebServer(
          vm,
          lease,
          site.web_server,
          {
            domain: site.domain,
            kind: site.kind,
            phpVersion: site.php_version,
            docRoot: path,
            isDefault: site.is_default === 1,
          },
          confOf(site),
        );
      });
      db.prepare('UPDATE sites SET doc_root = ? WHERE id = ?').run(path, site.id);
      rec(req, vm, userId, 'docroot', site.domain, 'ok', { from: site.doc_root, to: path });
      return toPublic(loadSite(vm, site.id));
    },
  );

  /**
   * Jadikan situs ini "situs utama" Nginx (default_server) atau lepaskan. Tanpa ini, permintaan yang Host-nya bukan
   * persis domain situs (mis. dibuka lewat IP VM) dijawab halaman bawaan "Welcome to nginx". Halaman bawaan hanya
   * dinonaktifkan (symlink di sites-enabled dilepas, berkasnya tetap) dan dipulihkan saat situs utama dilepas.
   */
  app.post(
    '/api/vms/:vmId/sites/:siteId/default',
    { config: rateLimit(10), onRequest: requireActive },
    async (req) => {
      const { vm, userId } = access(req);
      const { siteId } = siteParams.parse(req.params);
      const site = loadSite(vm, siteId);
      const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
      if (site.web_server !== 'nginx') {
        throw new AppError(
          400,
          'default_unsupported',
          'Pilihan situs utama baru tersedia untuk Nginx. Di Apache, nonaktifkan situs bawaan lewat Terminal (a2dissite 000-default lalu systemctl reload apache2).',
        );
      }
      if ((site.is_default === 1) === enabled) return toPublic(site);
      const STOCK_ON = '/etc/nginx/sites-enabled/default';
      const STOCK_AVAILABLE = '/etc/nginx/sites-available/default';
      const base = { domain: site.domain, kind: site.kind, phpVersion: site.php_version };

      await withVm(ctx, vm, async (lease) => {
        const stockWasLinked = (await exec(vm, lease, ['test', '-L', STOCK_ON])).code === 0;
        const others = enabled
          ? (db
              .prepare('SELECT * FROM sites WHERE vm_id = ? AND is_default = 1 AND id != ?')
              .all(vm.id, site.id) as SiteRow[])
          : [];
        try {
          if (enabled) {
            if (stockWasLinked)
              await must(
                vm,
                lease,
                ['rm', '-f', '--', STOCK_ON],
                'Menonaktifkan halaman bawaan Nginx',
              );
            for (const o of others)
              await applyWebServer(
                vm,
                lease,
                'nginx',
                {
                  domain: o.domain,
                  kind: o.kind,
                  phpVersion: o.php_version,
                  docRoot: o.doc_root,
                  isDefault: false,
                },
                confOf(o),
              );
            await applyWebServer(
              vm,
              lease,
              'nginx',
              { ...base, docRoot: site.doc_root, isDefault: true },
              confOf(site),
            );
          } else {
            // Pulihkan halaman bawaan bila ada, supaya Nginx tetap punya server default.
            const stockExists = (await exec(vm, lease, ['test', '-e', STOCK_AVAILABLE])).code === 0;
            const stockLinked = (await exec(vm, lease, ['test', '-e', STOCK_ON])).code === 0;
            if (stockExists && !stockLinked)
              await must(
                vm,
                lease,
                ['ln', '-sf', STOCK_AVAILABLE, STOCK_ON],
                'Memulihkan halaman bawaan Nginx',
              );
            await applyWebServer(
              vm,
              lease,
              'nginx',
              { ...base, docRoot: site.doc_root, isDefault: false },
              confOf(site),
            );
          }
        } catch (e) {
          // Kembalikan keadaan semula sebisanya: halaman bawaan dan konfigurasi situs lain.
          if (enabled) {
            if (stockWasLinked)
              await exec(vm, lease, ['ln', '-sf', STOCK_AVAILABLE, STOCK_ON]).catch(() => {});
            for (const o of others)
              await exec(vm, lease, ['tee', WEB_SERVERS.nginx.available(o.domain)], {
                stdin: confOf(o),
              }).catch(() => {});
          }
          throw e;
        }
      });

      db.transaction(() => {
        if (enabled) db.prepare('UPDATE sites SET is_default = 0 WHERE vm_id = ?').run(vm.id);
        db.prepare('UPDATE sites SET is_default = ? WHERE id = ?').run(enabled ? 1 : 0, site.id);
      })();
      rec(req, vm, userId, enabled ? 'default_on' : 'default_off', site.domain);
      return toPublic(loadSite(vm, site.id));
    },
  );

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
      const ws = WEB_SERVERS[site.web_server];
      await must(
        vm,
        lease,
        ['rm', '-f', '--', ws.enabled(site.domain), ws.available(site.domain)],
        `Menghapus konfigurasi ${ws.title}`,
      );
      const test = await exec(vm, lease, ws.test);
      if (test.code === 0) await exec(vm, lease, ws.reload);
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

  /**
   * Setelah deploy: bila folder dokumen masih mengikuti bawaan dan bawaan itu tidak berisi index, cari folder yang
   * berisi index (mis. dist/, public_html/). Satu kandidat (atau satu nama umum) dipakai otomatis; selain itu
   * pengguna diberi tahu untuk memilih dari daftar folder di halaman Situs Web.
   */
  async function autoDocRoot(
    vm: VmRow,
    site: SiteRow,
    lease: Lease,
    log: (t: string) => void,
  ): Promise<void> {
    const fresh = loadSite(vm, site.id);
    // Halaman awal buatan panel dibuang dulu: bila dibiarkan, folder itu dianggap "sudah berisi index" dan
    // folder dokumen sebenarnya (mis. public/ pada proyek PHP biasa) tidak pernah terdeteksi. Hanya berkas
    // yang isinya persis tulisan panel yang dihapus; index.html milik pengguna tidak disentuh.
    for (const rel of ['index.html', 'public/index.html']) {
      await exec(vm, lease, [
        'sh',
        '-c',
        'grep -qF -- "$1" "$2" 2>/dev/null && rm -f -- "$2"',
        'sh',
        PLACEHOLDER_TEXT,
        `${siteRoot(site.domain)}/${rel}`,
      ]);
    }
    if (fresh.doc_root !== null) return; // pengguna sudah memilih sendiri
    const r = await exec(vm, lease, findDirsArgv(siteRoot(site.domain)), { timeoutMs: 30_000 });
    const entries = parseDirListing(r.stdout);
    const fallback = defaultDocRootRel(site.kind);
    if (entries.find((e) => e.path === fallback)?.hasIndex) return;
    const pick = suggestDocRoot(site.kind, entries);
    if (pick) {
      await applyWebServer(
        vm,
        lease,
        site.web_server,
        {
          domain: site.domain,
          kind: site.kind,
          phpVersion: site.php_version,
          docRoot: pick,
          isDefault: fresh.is_default === 1,
        },
        confOf(fresh),
      );
      db.prepare('UPDATE sites SET doc_root = ? WHERE id = ?').run(pick, site.id);
      log(
        `\nFolder "${fallback}" tidak berisi index; folder dokumen otomatis diatur ke "${pick}". Ubah lewat tombol Folder dokumen bila salah.\n`,
      );
    } else if (entries.some((e) => e.hasIndex)) {
      log(
        `\n[peringatan] Folder "${fallback}" tidak berisi index, dan ada beberapa folder lain yang berisi index. Pilih yang benar lewat tombol Folder dokumen di halaman Situs Web.\n`,
      );
    } else {
      log(
        `\n[peringatan] Tidak ada file index.php/index.html di folder dokumen "${fallback}" maupun subfoldernya. Periksa isi arsip Anda, lalu atur Folder dokumen bila perlu.\n`,
      );
    }
  }

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
      await autoDocRoot(vm, site, lease, log);
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

  /**
   * Deploy dari URL (mis. Google Drive): VM mengunduh arsip langsung dari sumbernya sehingga tidak lewat panel
   * dan Cloudflare. Hanya https; jenis arsip dideteksi dari isi berkas. Audit hanya mencatat host (URL bisa
   * memuat token).
   */
  app.post(
    '/api/vms/:vmId/sites/:siteId/deploy-url',
    { config: rateLimit(5), onRequest: requireActive },
    async (req) => {
      const { vm, userId } = access(req);
      const { siteId } = siteParams.parse(req.params);
      const site = loadSite(vm, siteId);
      const b = z
        .object({
          url: z.string().trim().min(1).max(2000),
          composer: z.boolean().default(true),
          migrate: z.boolean().default(false),
          optimize: z.boolean().default(false),
        })
        .parse(req.body);
      const target = normalizeDownloadUrl(b.url);
      const opts: DeployOptions = {
        composer: b.composer,
        migrate: b.migrate,
        optimize: b.optimize,
      };
      const maxDownload = ctx.env.MAX_URL_DEPLOY_MB * 1024 * 1024;
      const archive = `/tmp/panel-url-${randomBytes(6).toString('hex')}.bin`;
      const job = ctx.jobs.start(
        {
          vmId: vm.id,
          userId,
          ip: req.ip,
          kind: 'deploy',
          title: `Deploy ${site.domain} dari URL`,
          vmName: vm.name,
        },
        (log, ctl) =>
          withVm(ctx, vm, async (lease) => {
            try {
              log(
                `Mengunduh arsip dari ${target.host} langsung ke VM (batas ${ctx.env.MAX_URL_DEPLOY_MB} MB).\n`,
              );
              await runSteps(
                lease.client,
                privOpts(vm),
                [
                  {
                    title: 'Unduh arsip ke VM',
                    argv: [
                      'bash',
                      '-c',
                      DOWNLOAD_SCRIPT,
                      'bash',
                      target.url,
                      archive,
                      String(maxDownload),
                    ],
                    timeoutMs: 65 * 60_000,
                    hideCommand: true,
                  },
                ],
                log,
              );
              const kind = archiveKindOrThrow(
                (await exec(vm, lease, ['sh', '-c', DETECT_SCRIPT, 'sh', archive])).stdout,
                target.provider,
              );
              log(`Jenis arsip terdeteksi: ${kind}.\n`);
              await runDeploy(
                vm,
                site,
                lease,
                (stage) => [
                  kind === 'zip'
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
      rec(req, vm, userId, 'deploy_url', site.domain, 'ok', {
        host: target.host,
        provider: target.provider,
      });
      return toPublicJob(job, false);
    },
  );
}
