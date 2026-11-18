import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actor, requireActive } from '../../auth/plugin.js';
import type { Ctx } from '../../context.js';
import { AppError, notFound } from '../../errors.js';
import { rateLimit } from '../../ratelimit.js';
import { assertVmAccess, type VmRow } from '../../rbac/index.js';
import { execRemote, type ExecResult } from '../../ssh/exec.js';
import type { Lease } from '../../ssh/pool.js';
import { inDir } from '../../ssh/shell.js';
import { toPublicJob } from '../jobs/service.js';
import { runSteps, type Step } from '../software/install.js';
import { confEnabled, DOMAIN_RE, siteRoot } from '../sites/nginx.js';
import { privOpts, withVm } from '../vms/service.js';
import {
  appRoot,
  commandProblem,
  cronFile,
  cronPath,
  expandCommand,
  NAME_RE,
  nextFreePort,
  PORT_MAX,
  PORT_MIN,
  proxyConf,
  proxyConfPath,
  RUNTIME_BIN,
  RUNTIME_HINT,
  systemdUnit,
  unitName,
  unitPath,
  validSchedule,
  WORKDIR_RE,
  type Runtime,
  type TaskKind,
} from './spec.js';

const vmParams = z.object({ vmId: z.string().uuid() });
const taskParams = z.object({ vmId: z.string().uuid(), taskId: z.string().uuid() });

interface TaskRow {
  id: string;
  vm_id: string;
  kind: TaskKind;
  name: string;
  site_id: string | null;
  domain: string | null;
  runtime: Runtime | null;
  workdir: string;
  command: string;
  install_cmd: string | null;
  schedule: string | null;
  port: number | null;
  git_url: string | null;
  git_branch: string | null;
  created_at: number;
}

const name = z
  .string()
  .regex(NAME_RE, 'Nama 2-31 karakter: huruf kecil di awal, lalu huruf kecil, angka, atau -.');
const command = z.string().superRefine((v, ctx) => {
  const p = commandProblem(v);
  if (p) ctx.addIssue({ code: 'custom', message: p });
});
const workdir = z
  .string()
  .regex(WORKDIR_RE, 'Folder kerja harus di /var/www/... atau /srv/... (tanpa "..").');
const schedule = z
  .string()
  .refine(validSchedule, 'Jadwal tidak valid. Contoh: "*/5 * * * *" atau "@daily".');
const gitUrl = z
  .string()
  .trim()
  .max(300)
  .regex(
    /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._~/-]+$/i,
    'URL harus https:// tanpa kredensial, contoh https://github.com/user/repo.git',
  );
const branch = z
  .string()
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'Nama branch tidak valid.');

const createBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cron'),
    name,
    schedule,
    command,
    workdir: workdir.optional(),
    siteId: z.string().uuid().optional(),
  }),
  z.object({
    kind: z.literal('worker'),
    name,
    command,
    workdir: workdir.optional(),
    siteId: z.string().uuid().optional(),
  }),
  z.object({
    kind: z.literal('app'),
    name,
    domain: z.string().regex(DOMAIN_RE, 'Domain tidak valid. Contoh: app.contoh.com'),
    runtime: z.enum(['node', 'python', 'other']),
    command,
    installCommand: command.optional(),
    gitUrl: gitUrl.optional(),
    gitBranch: branch.default('main'),
    port: z.number().int().min(PORT_MIN).max(PORT_MAX).optional(),
  }),
]);

export function taskRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, audit } = ctx;

  const access = (req: FastifyRequest): { vm: VmRow; userId: string } => {
    const { vmId } = vmParams.parse(req.params);
    const user = actor(req);
    return { vm: assertVmAccess(db, user, vmId, 'sites'), userId: user.id };
  };
  const loadTask = (vm: VmRow, id: string): TaskRow => {
    const t = db.prepare('SELECT * FROM vm_tasks WHERE id = ? AND vm_id = ?').get(id, vm.id) as
      TaskRow | undefined;
    if (!t) throw notFound('Tugas');
    return t;
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
      action: `task.${action}`,
      target,
      result,
      meta,
    });
  const exec = (
    vm: VmRow,
    lease: Lease,
    argv: string[],
    extra: { stdin?: string; timeoutMs?: number } = {},
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
  const hasSystemd = async (vm: VmRow, lease: Lease) =>
    (await exec(vm, lease, ['test', '-d', '/run/systemd/system'])).code === 0;
  const requireSystemd = async (vm: VmRow, lease: Lease) => {
    if (!(await hasSystemd(vm, lease)))
      throw new AppError(
        409,
        'no_systemd',
        'VM ini tidak memakai systemd, jadi worker dan aplikasi tidak bisa dikelola dari panel. Gunakan terminal.',
      );
  };
  const unitOf = (t: TaskRow): string => unitName(t.kind as 'worker' | 'app', t.name);

  const toPublic = (t: TaskRow, state: string | null) => ({
    id: t.id,
    kind: t.kind,
    name: t.name,
    domain: t.domain,
    runtime: t.runtime,
    workdir: t.workdir,
    command: t.command,
    installCommand: t.install_cmd,
    schedule: t.schedule,
    port: t.port,
    gitUrl: t.git_url,
    siteId: t.site_id,
    state: t.kind === 'cron' ? 'scheduled' : (state ?? 'unknown'),
    createdAt: t.created_at,
  });

  app.get(
    '/api/vms/:vmId/tasks',
    { config: rateLimit(30), onRequest: requireActive },
    async (req) => {
      const { vm } = access(req);
      const rows = db
        .prepare('SELECT * FROM vm_tasks WHERE vm_id = ? ORDER BY kind, name')
        .all(vm.id) as TaskRow[];
      const units = rows.filter((r) => r.kind !== 'cron');
      const states = new Map<string, string>();
      if (units.length > 0) {
        const r = await withVm(ctx, vm, (lease) =>
          exec(vm, lease, ['systemctl', 'is-active', '--', ...units.map(unitOf)]),
        );
        const lines = r.stdout.split('\n').filter(Boolean);
        units.forEach((u, i) => states.set(u.id, lines[i] ?? 'unknown'));
      }
      return { items: rows.map((t) => toPublic(t, states.get(t.id) ?? null)) };
    },
  );

  /** Daftar situs (untuk preset Laravel di UI) ikut di sini agar halaman cukup satu permintaan. */
  app.get('/api/vms/:vmId/tasks/options', { onRequest: requireActive }, async (req) => {
    const { vm } = access(req);
    const sites = db
      .prepare(
        'SELECT id, domain, kind, php_version AS phpVersion, root_path AS rootPath FROM sites WHERE vm_id = ? ORDER BY domain',
      )
      .all(vm.id);
    const used = (
      db.prepare('SELECT port FROM vm_tasks WHERE vm_id = ? AND port IS NOT NULL').all(vm.id) as {
        port: number;
      }[]
    ).map((r) => r.port);
    return { sites, nextPort: nextFreePort(used) };
  });

  app.post(
    '/api/vms/:vmId/tasks',
    { config: rateLimit(10), onRequest: requireActive },
    async (req, reply) => {
      const { vm, userId } = access(req);
      const b = createBody.parse(req.body);
      if (
        db.prepare('SELECT 1 AS ok FROM vm_tasks WHERE vm_id = ? AND name = ?').get(vm.id, b.name)
      )
        throw new AppError(
          409,
          'task_exists',
          `Nama "${b.name}" sudah dipakai di VM ini. Pilih nama lain.`,
        );

      // Folder kerja: dari situs yang dipilih (harus milik VM ini) atau diisi langsung.
      let dir = '';
      let siteId: string | null = null;
      if (b.kind !== 'app') {
        if (b.siteId) {
          const s = db
            .prepare('SELECT id, root_path FROM sites WHERE id = ? AND vm_id = ?')
            .get(b.siteId, vm.id) as { id: string; root_path: string } | undefined;
          if (!s) throw notFound('Situs');
          siteId = s.id;
          dir = s.root_path;
        } else if (b.workdir) dir = b.workdir;
        else throw new AppError(400, 'workdir_required', 'Pilih situs atau isi folder kerja.');
        if (!WORKDIR_RE.test(dir))
          throw new AppError(
            400,
            'bad_workdir',
            'Folder kerja harus di /var/www/... atau /srv/....',
          );
      }

      if (b.kind === 'cron') {
        await withVm(ctx, vm, async (lease) => {
          if (
            (await exec(vm, lease, ['sh', '-c', 'command -v cron || command -v crond'])).code !== 0
          )
            throw new AppError(
              409,
              'no_cron',
              'Layanan cron belum terpasang di VM. Pasang "cron" lewat menu Aplikasi, lalu coba lagi.',
            );
          if ((await exec(vm, lease, ['test', '-d', dir])).code !== 0)
            throw new AppError(
              422,
              'workdir_missing',
              `Folder ${dir} tidak ada di VM. Periksa penulisannya.`,
            );
          await must(vm, lease, ['tee', '--', cronPath(b.name)], 'Menulis jadwal cron', {
            stdin: cronFile({
              name: b.name,
              schedule: b.schedule,
              workdir: dir,
              command: b.command,
            }),
          });
          await must(vm, lease, ['chmod', '644', '--', cronPath(b.name)], 'Mengatur izin cron');
          await exec(vm, lease, ['chown', 'root:root', '--', cronPath(b.name)]);
        });
        const id = randomUUID();
        db.prepare(
          'INSERT INTO vm_tasks (id, vm_id, kind, name, site_id, workdir, command, schedule, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(id, vm.id, 'cron', b.name, siteId, dir, b.command, b.schedule, Date.now());
        rec(req, vm, userId, 'create', b.name, 'ok', { kind: 'cron' });
        reply.code(201);
        return toPublic(loadTask(vm, id), null);
      }

      if (b.kind === 'worker') {
        await withVm(ctx, vm, async (lease) => {
          await requireSystemd(vm, lease);
          if ((await exec(vm, lease, ['test', '-d', dir])).code !== 0)
            throw new AppError(
              422,
              'workdir_missing',
              `Folder ${dir} tidak ada di VM. Periksa penulisannya.`,
            );
          await exec(vm, lease, [
            'sh',
            '-c',
            'mkdir -p "$1/.home" && chown www-data:www-data "$1/.home"',
            'sh',
            dir,
          ]);
          const u = unitName('worker', b.name);
          await must(vm, lease, ['tee', '--', unitPath('worker', b.name)], 'Menulis unit systemd', {
            stdin: systemdUnit({
              kind: 'worker',
              name: b.name,
              workdir: dir,
              command: b.command,
              port: null,
              withEnvFile: false,
            }),
          });
          await must(vm, lease, ['systemctl', 'daemon-reload'], 'Memuat ulang systemd');
          await must(vm, lease, ['systemctl', 'enable', '--now', '--', u], 'Menjalankan worker');
        });
        const id = randomUUID();
        db.prepare(
          'INSERT INTO vm_tasks (id, vm_id, kind, name, site_id, workdir, command, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(id, vm.id, 'worker', b.name, siteId, dir, b.command, Date.now());
        rec(req, vm, userId, 'create', b.name, 'ok', { kind: 'worker' });
        reply.code(201);
        return toPublic(loadTask(vm, id), 'active');
      }

      // --- aplikasi Node/Python: reverse proxy + service, dikerjakan sebagai job ---
      const domain = b.domain;
      if (
        db.prepare('SELECT 1 AS ok FROM sites WHERE vm_id = ? AND domain = ?').get(vm.id, domain) ||
        db.prepare('SELECT 1 AS ok FROM vm_tasks WHERE vm_id = ? AND domain = ?').get(vm.id, domain)
      )
        throw new AppError(
          409,
          'domain_taken',
          `Domain ${domain} sudah dipakai oleh situs atau aplikasi lain di VM ini.`,
        );
      const used = (
        db.prepare('SELECT port FROM vm_tasks WHERE vm_id = ? AND port IS NOT NULL').all(vm.id) as {
          port: number;
        }[]
      ).map((r) => r.port);
      const port = b.port ?? nextFreePort(used);
      if (port === null || used.includes(port))
        throw new AppError(
          409,
          'port_taken',
          `Port ${port ?? ''} sudah dipakai aplikasi lain. Pilih port lain di rentang ${PORT_MIN}-${PORT_MAX}.`,
        );

      await withVm(ctx, vm, async (lease) => {
        await requireSystemd(vm, lease);
        if ((await exec(vm, lease, ['sh', '-c', 'command -v nginx'])).code !== 0)
          throw new AppError(
            409,
            'need_nginx',
            'Aplikasi Node/Python memakai Nginx sebagai reverse proxy, tetapi Nginx belum terpasang di VM. Pasang Nginx lewat menu Aplikasi (Apache belum didukung untuk fitur ini).',
          );
        if ((await exec(vm, lease, ['test', '-e', proxyConfPath(domain)])).code === 0)
          throw new AppError(
            409,
            'conf_exists',
            `Sudah ada konfigurasi Nginx untuk ${domain} di VM (bukan dari panel). Hapus atau ganti nama dulu lewat File Manager.`,
          );
        const bin = RUNTIME_BIN[b.runtime];
        if (bin && (await exec(vm, lease, ['sh', '-c', 'command -v "$1"', 'sh', bin])).code !== 0)
          throw new AppError(409, 'runtime_missing', RUNTIME_HINT[b.runtime]);
        if (b.gitUrl && (await exec(vm, lease, ['sh', '-c', 'command -v git'])).code !== 0)
          throw new AppError(
            409,
            'git_missing',
            'Git belum terpasang di VM. Pasang "Alat dasar" lewat menu Aplikasi.',
          );
      });

      const root = appRoot(domain);
      const id = randomUUID();
      db.prepare(
        'INSERT INTO vm_tasks (id, vm_id, kind, name, domain, runtime, workdir, command, install_cmd, port, git_url, git_branch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        vm.id,
        'app',
        b.name,
        domain,
        b.runtime,
        root,
        b.command,
        b.installCommand ?? null,
        port,
        b.gitUrl ?? null,
        b.gitUrl ? b.gitBranch : null,
        Date.now(),
      );
      const steps = createAppSteps({
        name: b.name,
        domain,
        root,
        command: b.command,
        installCommand: b.installCommand ?? null,
        port,
        gitUrl: b.gitUrl ?? null,
        gitBranch: b.gitBranch,
      });
      const job = ctx.jobs.start(
        {
          vmId: vm.id,
          userId,
          ip: req.ip,
          kind: 'deploy',
          title: `Buat aplikasi ${b.name} (${domain})`,
          vmName: vm.name,
        },
        (log, ctl) =>
          withVm(ctx, vm, (lease) => runSteps(lease.client, privOpts(vm), steps, log, ctl)),
      );
      rec(req, vm, userId, 'create', b.name, 'ok', { kind: 'app', runtime: b.runtime, port });
      reply.code(202);
      return { task: toPublic(loadTask(vm, id), null), job: toPublicJob(job, false) };
    },
  );

  /** Langkah membuat aplikasi: folder/clone, dependensi, service systemd, lalu Nginx (terakhir agar rollback mudah). */
  function createAppSteps(a: {
    name: string;
    domain: string;
    root: string;
    command: string;
    installCommand: string | null;
    port: number;
    gitUrl: string | null;
    gitBranch: string;
  }): Step[] {
    const steps: Step[] = [];
    if (a.gitUrl)
      steps.push({
        title: `Clone ${a.gitUrl} (branch ${a.gitBranch})`,
        argv: ['git', 'clone', '--depth', '1', '--branch', a.gitBranch, '--', a.gitUrl, a.root],
        env: { GIT_TERMINAL_PROMPT: '0' },
        timeoutMs: 10 * 60_000,
      });
    else steps.push({ title: 'Siapkan folder aplikasi', argv: ['mkdir', '-p', '--', a.root] });
    steps.push(
      { title: 'Siapkan folder home aplikasi', argv: ['mkdir', '-p', '--', `${a.root}/.home`] },
      {
        title: 'Atur pemilik file ke www-data',
        argv: ['chown', '-R', 'www-data:www-data', '--', a.root],
        timeoutMs: 5 * 60_000,
      },
    );
    if (a.installCommand) steps.push(installStep(a.root, a.installCommand));
    steps.push(
      {
        title: 'Tulis unit systemd',
        argv: ['tee', '--', unitPath('app', a.name)],
        stdin: systemdUnit({
          kind: 'app',
          name: a.name,
          workdir: a.root,
          command: a.command,
          port: a.port,
          withEnvFile: true,
        }),
        hideCommand: true,
      },
      { title: 'Muat ulang systemd', argv: ['systemctl', 'daemon-reload'] },
      {
        title: 'Jalankan aplikasi',
        argv: ['systemctl', 'enable', '--now', '--', unitName('app', a.name)],
      },
      {
        title: 'Tulis konfigurasi Nginx (reverse proxy)',
        argv: ['tee', '--', proxyConfPath(a.domain)],
        stdin: proxyConf(a.domain, a.port),
        hideCommand: true,
      },
      {
        title: 'Aktifkan situs',
        argv: ['ln', '-sf', proxyConfPath(a.domain), confEnabled(a.domain)],
      },
      {
        title: 'Uji konfigurasi Nginx',
        argv: [
          'sh',
          '-c',
          'nginx -t || { rm -f "$1" "$2"; exit 1; }',
          'sh',
          confEnabled(a.domain),
          proxyConfPath(a.domain),
        ],
      },
      {
        title: 'Muat ulang Nginx',
        argv: ['sh', '-c', 'systemctl reload nginx 2>/dev/null || nginx -s reload'],
      },
    );
    return steps;
  }

  /** Jalankan perintah pemasangan dependensi sebagai www-data di folder aplikasi (HOME di dalam folder aplikasi). */
  function installStep(root: string, cmd: string): Step {
    return {
      title: `Pasang dependensi: ${cmd}`,
      argv: inDir(root, [
        'runuser',
        '-u',
        'www-data',
        '--',
        'env',
        `HOME=${root}/.home`,
        'PATH=/usr/local/bin:/usr/bin:/bin',
        ...expandCommand(cmd, null).split(' '),
      ]),
      timeoutMs: 20 * 60_000,
    };
  }

  const actionBody = z.object({ action: z.enum(['start', 'stop', 'restart']) });

  app.post(
    '/api/vms/:vmId/tasks/:taskId/action',
    { config: rateLimit(20), onRequest: requireActive },
    async (req) => {
      const { vm, userId } = access(req);
      const t = loadTask(vm, taskParams.parse(req.params).taskId);
      if (t.kind === 'cron')
        throw new AppError(
          400,
          'cron_no_action',
          'Jadwal cron tidak bisa dijalankan atau dihentikan; hapus jadwalnya bila tidak diperlukan.',
        );
      const { action } = actionBody.parse(req.body);
      await withVm(ctx, vm, async (lease) => {
        await requireSystemd(vm, lease);
        await must(vm, lease, ['systemctl', action, '--', unitOf(t)], `Perintah ${action}`);
      });
      rec(req, vm, userId, action, t.name, 'ok', { kind: t.kind });
      return { ok: true };
    },
  );

  app.get(
    '/api/vms/:vmId/tasks/:taskId/logs',
    { config: rateLimit(30), onRequest: requireActive },
    async (req) => {
      const { vm } = access(req);
      const t = loadTask(vm, taskParams.parse(req.params).taskId);
      if (t.kind === 'cron')
        throw new AppError(
          400,
          'cron_no_logs',
          'Jadwal cron tidak menyimpan log (keluarannya dibuang). Jalankan perintahnya dari terminal untuk melihat hasilnya.',
        );
      const { lines } = z
        .object({ lines: z.coerce.number().int().min(10).max(500).default(200) })
        .parse(req.query);
      const r = await withVm(ctx, vm, (lease) =>
        exec(vm, lease, [
          'journalctl',
          '-u',
          unitOf(t),
          '-n',
          String(lines),
          '--no-pager',
          '-o',
          'short-iso',
        ]),
      );
      return { log: r.stdout.slice(-128 * 1024), code: r.code };
    },
  );

  /** Pasang ulang aplikasi: git pull (bila dari Git), install dependensi, restart. */
  app.post(
    '/api/vms/:vmId/tasks/:taskId/redeploy',
    { config: rateLimit(5), onRequest: requireActive },
    async (req) => {
      const { vm, userId } = access(req);
      const t = loadTask(vm, taskParams.parse(req.params).taskId);
      if (t.kind !== 'app')
        throw new AppError(400, 'not_app', 'Hanya aplikasi Node/Python yang bisa dipasang ulang.');
      const steps: Step[] = [];
      if (t.git_url)
        steps.push({
          title: 'Ambil pembaruan dari Git',
          argv: inDir(t.workdir, [
            'runuser',
            '-u',
            'www-data',
            '--',
            'env',
            `HOME=${t.workdir}/.home`,
            'GIT_TERMINAL_PROMPT=0',
            'git',
            'pull',
            '--ff-only',
          ]),
          timeoutMs: 10 * 60_000,
        });
      if (t.install_cmd) steps.push(installStep(t.workdir, t.install_cmd));
      steps.push({
        title: 'Mulai ulang aplikasi',
        argv: ['systemctl', 'restart', '--', unitOf(t)],
      });
      const job = ctx.jobs.start(
        {
          vmId: vm.id,
          userId,
          ip: req.ip,
          kind: 'deploy',
          title: `Pasang ulang ${t.name}`,
          vmName: vm.name,
        },
        (log, ctl) =>
          withVm(ctx, vm, (lease) => runSteps(lease.client, privOpts(vm), steps, log, ctl)),
      );
      rec(req, vm, userId, 'redeploy', t.name, 'ok');
      return toPublicJob(job, false);
    },
  );

  app.post(
    '/api/vms/:vmId/tasks/:taskId/delete',
    { config: rateLimit(10), onRequest: requireActive },
    async (req) => {
      const { vm, userId } = access(req);
      const t = loadTask(vm, taskParams.parse(req.params).taskId);
      const b = z
        .object({ confirm: z.string(), deleteFiles: z.boolean().default(false) })
        .parse(req.body);
      if (b.confirm !== t.name)
        throw new AppError(
          400,
          'confirm_mismatch',
          'Konfirmasi tidak cocok. Ketik nama persis untuk menghapus.',
        );
      await withVm(ctx, vm, async (lease) => {
        if (t.kind === 'cron') {
          await must(vm, lease, ['rm', '-f', '--', cronPath(t.name)], 'Menghapus jadwal cron');
          return;
        }
        const u = unitOf(t);
        await exec(vm, lease, ['systemctl', 'disable', '--now', '--', u]);
        await must(
          vm,
          lease,
          ['rm', '-f', '--', unitPath(t.kind as 'worker' | 'app', t.name)],
          'Menghapus unit systemd',
        );
        await exec(vm, lease, ['systemctl', 'daemon-reload']);
        if (t.kind === 'app' && t.domain && DOMAIN_RE.test(t.domain)) {
          await exec(vm, lease, ['rm', '-f', '--', confEnabled(t.domain), proxyConfPath(t.domain)]);
          if ((await exec(vm, lease, ['nginx', '-t'])).code === 0)
            await exec(vm, lease, [
              'sh',
              '-c',
              'systemctl reload nginx 2>/dev/null || nginx -s reload',
            ]);
          // Path dibangun ulang dari domain tervalidasi, bukan dari nilai tersimpan.
          if (b.deleteFiles)
            await must(
              vm,
              lease,
              ['rm', '-rf', '--', siteRoot(t.domain)],
              'Menghapus file aplikasi',
              { timeoutMs: 5 * 60_000 },
            );
        }
      });
      db.prepare('DELETE FROM vm_tasks WHERE id = ?').run(t.id);
      rec(req, vm, userId, 'delete', t.name, 'ok', { kind: t.kind, deleteFiles: b.deleteFiles });
      return { ok: true };
    },
  );
}
