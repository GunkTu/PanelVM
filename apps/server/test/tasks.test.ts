import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeSsh } from './fakeSsh.js';
import { call, login, makeApp, seedUser, type Client } from './helpers.js';

const execLog: { command: string; stdin: string }[] = [];
let failCommand: RegExp | null = null;
const fake = await startFakeSsh({
  execLog,
  // `test -e <konfigurasi>` = tidak ada (kode 1), kecuali dipaksa lain; perintah lain berhasil.
  execExit: (c) => (failCommand?.test(c) || /'test' '-e'/.test(c) ? 1 : 0),
});
const built = await makeApp();
const { app, ctx } = built;
let admin: Client, owner: Client, other: Client;
let vmId = '';
let siteId = '';

const reset = () => {
  execLog.length = 0;
  failCommand = null;
};
const url = (p = '') => `/api/vms/${vmId}/tasks${p}`;
const writes = (path: string) =>
  execLog.filter((e) => e.command.includes('tee') && e.command.includes(path));

beforeAll(async () => {
  admin = await login(app, await seedUser(built, 'admin@contoh.com', 'admin'));
  const ownerU = await seedUser(built, 'pemilik@contoh.com');
  owner = await login(app, ownerU);
  other = await login(app, await seedUser(built, 'lain@contoh.com'));
  vmId = (
    await call(app, admin, 'POST', '/api/vms', {
      name: 'vm-tugas',
      host: '127.0.0.1',
      sshPort: fake.port,
      sshUser: 'root',
    })
  ).json().id as string;
  await call(app, admin, 'PUT', `/api/vms/${vmId}/assignment`, { userId: ownerU.row.id });
  const fp = (await call(app, admin, 'POST', `/api/vms/${vmId}/host-key/scan`)).json().fingerprint;
  await call(app, admin, 'POST', `/api/vms/${vmId}/host-key/approve`, { fingerprint: fp });
  siteId = crypto.randomUUID();
  ctx.db
    .prepare(
      'INSERT INTO sites (id, vm_id, domain, kind, php_version, root_path, web_server, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      siteId,
      vmId,
      'blog.contoh.com',
      'laravel',
      '8.3',
      '/var/www/blog.contoh.com',
      'nginx',
      Date.now(),
    );
});
afterAll(async () => {
  await app.close();
  await fake.close();
});

describe('otorisasi', () => {
  it('tanpa login 401, client lain 404 untuk semua endpoint', async () => {
    const body = {
      kind: 'cron',
      name: 'x1',
      schedule: '* * * * *',
      command: 'ls',
      workdir: '/srv/a',
    };
    expect((await call(app, null, 'GET', url())).statusCode).toBe(401);
    expect((await call(app, null, 'POST', url(), body)).statusCode).toBe(401);
    expect((await call(app, other, 'GET', url())).statusCode).toBe(404);
    expect((await call(app, other, 'POST', url(), body)).statusCode).toBe(404);
    expect((await call(app, other, 'GET', url('/options'))).statusCode).toBe(404);
  });
});

describe('cron', () => {
  it('membuat jadwal Laravel scheduler: file /etc/cron.d ditulis sebagai www-data, izin 644', async () => {
    reset();
    const r = await call(app, owner, 'POST', url(), {
      kind: 'cron',
      name: 'blog-scheduler',
      siteId,
      schedule: '* * * * *',
      command: 'php8.3 artisan schedule:run',
    });
    expect(r.statusCode).toBe(201);
    const w = writes('/etc/cron.d/panelvm-blog-scheduler');
    expect(w).toHaveLength(1);
    expect(w[0]!.stdin).toContain(
      '* * * * * www-data cd /var/www/blog.contoh.com && php8.3 artisan schedule:run >/dev/null 2>&1',
    );
    expect(execLog.some((e) => e.command.includes('chmod') && e.command.includes('644'))).toBe(
      true,
    );
    expect(
      ctx.db.prepare("SELECT COUNT(*) c FROM vm_tasks WHERE name = 'blog-scheduler'").get(),
    ).toEqual({ c: 1 });
  });

  it('masukan berbahaya ditolak sebelum menyentuh VM', async () => {
    reset();
    const base = {
      kind: 'cron',
      name: 'x1',
      schedule: '* * * * *',
      command: 'ls',
      workdir: '/srv/a',
    };
    for (const bad of [
      { command: 'ls; rm -rf /' },
      { command: 'ls $(id)' },
      { schedule: '* * * * * root id' },
      { schedule: '99 * * * *' },
      { workdir: '/etc' },
      { workdir: '/var/www/../etc' },
      { name: 'a;b' },
      { name: 'A' },
    ]) {
      const r = await call(app, owner, 'POST', url(), { ...base, ...bad });
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(execLog).toHaveLength(0);
  });

  it('nama kembar ditolak; situs milik VM lain tidak bisa dipakai; tanpa cron di VM dijelaskan', async () => {
    reset();
    const dup = await call(app, owner, 'POST', url(), {
      kind: 'cron',
      name: 'blog-scheduler',
      schedule: '* * * * *',
      command: 'ls',
      workdir: '/srv/a',
    });
    expect(dup.statusCode).toBe(409);
    const ghost = await call(app, owner, 'POST', url(), {
      kind: 'cron',
      name: 'hantu',
      schedule: '* * * * *',
      command: 'ls',
      siteId: crypto.randomUUID(),
    });
    expect(ghost.statusCode).toBe(404);
    failCommand = /command -v cron/;
    const noCron = await call(app, owner, 'POST', url(), {
      kind: 'cron',
      name: 'tanpa-cron',
      schedule: '@daily',
      command: 'ls',
      workdir: '/srv/a',
    });
    expect(noCron.statusCode).toBe(409);
    expect(noCron.json().error).toBe('no_cron');
    expect(noCron.json().message).toMatch(/menu Aplikasi/);
  });
});

describe('worker', () => {
  it('membuat queue worker: unit systemd ditulis, daemon-reload, enable --now', async () => {
    reset();
    const r = await call(app, owner, 'POST', url(), {
      kind: 'worker',
      name: 'blog-queue',
      siteId,
      command: 'php8.3 artisan queue:work --sleep=3 --tries=3',
    });
    expect(r.statusCode).toBe(201);
    const w = writes('/etc/systemd/system/panelvm-worker-blog-queue.service');
    expect(w).toHaveLength(1);
    expect(w[0]!.stdin).toContain('User=www-data');
    expect(w[0]!.stdin).toContain(
      'ExecStart=/usr/bin/env php8.3 artisan queue:work --sleep=3 --tries=3',
    );
    const cmds = execLog.map((e) => e.command);
    const reload = cmds.findIndex((c) => c.includes('daemon-reload'));
    const enable = cmds.findIndex(
      (c) => c.includes('enable') && c.includes('panelvm-worker-blog-queue.service'),
    );
    expect(reload).toBeGreaterThan(-1);
    expect(enable).toBeGreaterThan(reload);
  });

  it('VM tanpa systemd ditolak dengan pesan jelas', async () => {
    reset();
    failCommand = /test.*-d.*\/run\/systemd\/system/;
    const r = await call(app, owner, 'POST', url(), {
      kind: 'worker',
      name: 'w2',
      command: 'ls',
      workdir: '/srv/a',
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('no_systemd');
  });

  it('start/stop/restart hanya untuk worker/app; aksi di luar daftar ditolak', async () => {
    const list = (await call(app, owner, 'GET', url())).json().items as {
      id: string;
      kind: string;
    }[];
    const worker = list.find((t) => t.kind === 'worker')!;
    const cron = list.find((t) => t.kind === 'cron')!;
    reset();
    expect(
      (await call(app, owner, 'POST', url(`/${worker.id}/action`), { action: 'restart' }))
        .statusCode,
    ).toBe(200);
    expect(
      execLog.some(
        (e) =>
          e.command.includes('restart') && e.command.includes('panelvm-worker-blog-queue.service'),
      ),
    ).toBe(true);
    expect(
      (await call(app, owner, 'POST', url(`/${worker.id}/action`), { action: 'disable' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await call(app, owner, 'POST', url(`/${cron.id}/action`), { action: 'start' })).statusCode,
    ).toBe(400);
    expect(
      (await call(app, other, 'POST', url(`/${worker.id}/action`), { action: 'stop' })).statusCode,
    ).toBe(404);
    expect((await call(app, other, 'GET', url(`/${worker.id}/logs`))).statusCode).toBe(404);
  });

  it('log memakai journalctl dengan batas baris', async () => {
    const worker = (
      (await call(app, owner, 'GET', url())).json().items as { id: string; kind: string }[]
    ).find((t) => t.kind === 'worker')!;
    reset();
    expect((await call(app, owner, 'GET', url(`/${worker.id}/logs?lines=100`))).statusCode).toBe(
      200,
    );
    expect(execLog.some((e) => e.command.includes('journalctl') && e.command.includes('100'))).toBe(
      true,
    );
    expect((await call(app, owner, 'GET', url(`/${worker.id}/logs?lines=100000`))).statusCode).toBe(
      400,
    );
  });
});

describe('aplikasi Node/Python', () => {
  const appBody = {
    kind: 'app',
    name: 'toko',
    domain: 'toko.contoh.com',
    runtime: 'node',
    command: 'npm start',
    installCommand: 'npm ci',
  };

  async function jobDone(vm: string, id: string) {
    for (let i = 0; i < 200; i++) {
      const j = (await call(app, owner, 'GET', `/api/vms/${vm}/jobs/${id}`)).json();
      if (j.status !== 'running') return j;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('job tidak selesai');
  }

  it('membuat aplikasi: job menulis service dan proxy Nginx ke port otomatis, install dijalankan sebagai www-data', async () => {
    reset();
    const r = await call(app, owner, 'POST', url(), appBody);
    expect(r.statusCode).toBe(202);
    expect(r.json().task.port).toBe(3001);
    const j = await jobDone(vmId, r.json().job.id);
    expect(j.status).toBe('succeeded');

    const unit = writes('/etc/systemd/system/panelvm-app-toko.service')[0]!;
    expect(unit.stdin).toContain('Environment=PORT=3001');
    expect(unit.stdin).toContain('WorkingDirectory=/var/www/toko.contoh.com');
    const conf = writes('/etc/nginx/sites-available/toko.contoh.com.conf')[0]!;
    expect(conf.stdin).toContain('proxy_pass http://127.0.0.1:3001;');
    const cmds = execLog.map((e) => e.command);
    const install = cmds.findIndex(
      (c) =>
        c.includes('runuser') && c.includes('www-data') && c.includes('npm') && c.includes('ci'),
    );
    const start = cmds.findIndex(
      (c) => c.includes('enable') && c.includes('panelvm-app-toko.service'),
    );
    const nginxTest = cmds.findIndex((c) => c.includes('nginx -t'));
    expect(install).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(install);
    expect(nginxTest).toBeGreaterThan(start); // Nginx terakhir
  });

  it('domain/port bentrok dan masukan salah ditolak', async () => {
    reset();
    expect(
      (await call(app, owner, 'POST', url(), { ...appBody, name: 'toko2' })).json().error,
    ).toBe('domain_taken');
    expect(
      (
        await call(app, owner, 'POST', url(), {
          ...appBody,
          name: 'toko3',
          domain: 'blog.contoh.com',
        })
      ).json().error,
    ).toBe('domain_taken'); // dipakai situs
    expect(
      (
        await call(app, owner, 'POST', url(), {
          ...appBody,
          name: 'toko4',
          domain: 'baru.contoh.com',
          port: 3001,
        })
      ).json().error,
    ).toBe('port_taken');
    for (const bad of [
      { command: 'node a.js; id' },
      { port: 22 },
      { port: 99999 },
      { runtime: 'ruby' },
      { domain: 'bukan domain' },
      { gitUrl: 'http://github.com/a/b.git' },
      { gitUrl: 'https://user:pw@github.com/a/b.git' },
      { installCommand: 'npm ci && curl x' },
    ]) {
      const r = await call(app, owner, 'POST', url(), {
        ...appBody,
        name: 'toko9',
        domain: 'x9.contoh.com',
        ...bad,
      });
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(execLog).toHaveLength(0);
  });

  it('runtime belum terpasang dijelaskan dan tidak ada baris tersisa', async () => {
    reset();
    failCommand = /command -v.*node/;
    const r = await call(app, owner, 'POST', url(), {
      ...appBody,
      name: 'toko5',
      domain: 'toko5.contoh.com',
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('runtime_missing');
    expect(ctx.db.prepare("SELECT COUNT(*) c FROM vm_tasks WHERE name = 'toko5'").get()).toEqual({
      c: 0,
    });
  });
});

describe('hapus', () => {
  it('butuh konfirmasi nama; cron: hanya file cron.d dihapus; app: unit dan konfigurasi Nginx', async () => {
    const items = (await call(app, owner, 'GET', url())).json().items as {
      id: string;
      kind: string;
      name: string;
    }[];
    const cron = items.find((t) => t.kind === 'cron')!;
    reset();
    expect(
      (await call(app, owner, 'POST', url(`/${cron.id}/delete`), { confirm: 'salah' })).statusCode,
    ).toBe(400);
    expect(
      (await call(app, other, 'POST', url(`/${cron.id}/delete`), { confirm: cron.name }))
        .statusCode,
    ).toBe(404);
    expect(execLog).toHaveLength(0);
    expect(
      (await call(app, owner, 'POST', url(`/${cron.id}/delete`), { confirm: cron.name }))
        .statusCode,
    ).toBe(200);
    expect(
      execLog.some(
        (e) => e.command.includes('rm') && e.command.includes('/etc/cron.d/panelvm-blog-scheduler'),
      ),
    ).toBe(true);

    const appRow = items.find((t) => t.kind === 'app')!;
    reset();
    const r = await call(app, owner, 'POST', url(`/${appRow.id}/delete`), { confirm: appRow.name });
    expect(r.statusCode).toBe(200);
    const cmds = execLog.map((e) => e.command);
    expect(cmds.some((c) => c.includes('disable') && c.includes('panelvm-app-toko.service'))).toBe(
      true,
    );
    expect(cmds.some((c) => c.includes('rm') && c.includes('toko.contoh.com.conf'))).toBe(true);
    expect(cmds.some((c) => c.includes('rm') && c.includes('-rf'))).toBe(false); // file aplikasi tidak ikut dihapus
  });

  it('audit mencatat tanpa isi perintah', () => {
    const rows = JSON.stringify(
      ctx.db
        .prepare("SELECT action, target, meta FROM audit_logs WHERE action LIKE 'task.%'")
        .all(),
    );
    expect(rows).toContain('task.create');
    expect(rows).toContain('task.delete');
    expect(rows).not.toContain('artisan');
  });
});
