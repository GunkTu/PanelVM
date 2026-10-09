import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apacheConf } from '../src/modules/sites/apache.js';
import { nginxConf } from '../src/modules/sites/nginx.js';
import { startFakeSsh } from './fakeSsh.js';
import { call, login, makeApp, seedUser, type Client } from './helpers.js';

describe('nginxConf: situs utama', () => {
  it('default_server hanya bila diminta; selebihnya listen 80 biasa', () => {
    expect(nginxConf('a.contoh.com', 'laravel', '8.3')).toContain('    listen 80;\n');
    expect(nginxConf('a.contoh.com', 'laravel', '8.3', null, false)).not.toContain(
      'default_server',
    );
    const c = nginxConf('a.contoh.com', 'laravel', '8.3', null, true);
    expect(c).toContain('    listen 80 default_server;\n');
    expect(c).toContain('server_name a.contoh.com;');
    expect(c).toContain('root /var/www/a.contoh.com/public;');
  });

  it('Apache tidak terpengaruh', () => {
    expect(apacheConf('a.contoh.com', 'php', '8.3')).not.toContain('default_server');
  });
});

const execLog: { command: string; stdin: string }[] = [];
let failCommand: RegExp | null = null;
const fake = await startFakeSsh({
  execLog,
  execExit: (c) => (failCommand?.test(c) ? 1 : 0),
});
const built = await makeApp();
const { app, ctx } = built;
let admin: Client, owner: Client, other: Client;
let vmId = '';
const siteIds: Record<string, string> = {};

const insertSite = (domain: string, server: 'nginx' | 'apache' = 'nginx') => {
  const id = crypto.randomUUID();
  ctx.db
    .prepare(
      'INSERT INTO sites (id, vm_id, domain, kind, php_version, root_path, web_server, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, vmId, domain, 'laravel', '8.3', `/var/www/${domain}`, server, Date.now());
  siteIds[domain] = id;
  return id;
};
const url = (domain: string) => `/api/vms/${vmId}/sites/${siteIds[domain]}/default`;
const isDefault = (domain: string) =>
  (
    ctx.db.prepare('SELECT is_default d FROM sites WHERE id = ?').get(siteIds[domain]) as {
      d: number;
    }
  ).d;
const cmds = () => execLog.map((e) => e.command);
const reset = () => {
  execLog.length = 0;
  failCommand = null;
};

beforeAll(async () => {
  admin = await login(app, await seedUser(built, 'admin@contoh.com', 'admin'));
  const ownerU = await seedUser(built, 'pemilik@contoh.com');
  owner = await login(app, ownerU);
  other = await login(app, await seedUser(built, 'lain@contoh.com'));
  const r = await call(app, admin, 'POST', '/api/vms', {
    name: 'vm-situs',
    host: '127.0.0.1',
    sshPort: fake.port,
    sshUser: 'root',
  });
  vmId = r.json().id as string;
  await call(app, admin, 'PUT', `/api/vms/${vmId}/assignment`, { userId: ownerU.row.id });
  const fp = (await call(app, admin, 'POST', `/api/vms/${vmId}/host-key/scan`)).json().fingerprint;
  await call(app, admin, 'POST', `/api/vms/${vmId}/host-key/approve`, { fingerprint: fp });
  insertSite('blog.contoh.com');
  insertSite('toko.contoh.com');
  insertSite('apache.contoh.com', 'apache');
});
afterAll(async () => {
  await app.close();
  await fake.close();
});

describe('POST /sites/:id/default', () => {
  it('otorisasi: tanpa login 401, client lain 404', async () => {
    expect(
      (await call(app, null, 'POST', url('blog.contoh.com'), { enabled: true })).statusCode,
    ).toBe(401);
    expect(
      (await call(app, other, 'POST', url('blog.contoh.com'), { enabled: true })).statusCode,
    ).toBe(404);
    expect(isDefault('blog.contoh.com')).toBe(0);
  });

  it('masukan salah ditolak', async () => {
    for (const body of [{}, { enabled: 'ya' }, { enabled: 1 }]) {
      expect((await call(app, owner, 'POST', url('blog.contoh.com'), body)).statusCode).toBe(400);
    }
  });

  it('Apache belum didukung: pesan jelas, tanpa menyentuh VM', async () => {
    reset();
    const r = await call(app, owner, 'POST', url('apache.contoh.com'), { enabled: true });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('default_unsupported');
    expect(r.json().message).toMatch(/a2dissite 000-default/);
    expect(cmds()).toEqual([]);
  });

  it('mengaktifkan: halaman bawaan dinonaktifkan (hanya symlink), konfigurasi memakai default_server, lalu diuji dan dimuat ulang', async () => {
    reset();
    const r = await call(app, owner, 'POST', url('blog.contoh.com'), { enabled: true });
    expect(r.statusCode).toBe(200);
    expect(r.json().isDefault).toBe(true);
    expect(isDefault('blog.contoh.com')).toBe(1);

    const c = cmds();
    const rm = c.findIndex(
      (x) => x.includes('rm') && x.includes('/etc/nginx/sites-enabled/default'),
    );
    const write = execLog.findIndex(
      (e) =>
        e.command.includes('tee') &&
        e.command.includes('/etc/nginx/sites-available/blog.contoh.com.conf'),
    );
    const test = c.findIndex((x) => x.includes('nginx') && x.includes('-t'));
    expect(rm).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(rm); // halaman bawaan dilepas sebelum konfigurasi baru ditulis
    expect(test).toBeGreaterThan(write);
    expect(execLog[write]!.stdin).toContain('listen 80 default_server;');
    // hanya symlink yang dilepas; berkas sites-available/default tidak dihapus
    expect(c.some((x) => x.includes('rm') && x.includes('sites-available/default'))).toBe(false);
    expect(c.some((x) => x.includes('rm') && x.includes('-rf'))).toBe(false);
  });

  it('hanya satu situs utama: menjadikan situs lain melepas yang sebelumnya (konfigurasinya ditulis ulang tanpa default_server)', async () => {
    reset();
    const r = await call(app, owner, 'POST', url('toko.contoh.com'), { enabled: true });
    expect(r.statusCode).toBe(200);
    expect(isDefault('toko.contoh.com')).toBe(1);
    expect(isDefault('blog.contoh.com')).toBe(0);
    const blogWrite = execLog.find(
      (e) => e.command.includes('blog.contoh.com.conf') && e.command.includes('tee'),
    )!;
    expect(blogWrite.stdin).not.toContain('default_server');
    const tokoWrite = execLog.find(
      (e) => e.command.includes('toko.contoh.com.conf') && e.command.includes('tee'),
    )!;
    expect(tokoWrite.stdin).toContain('listen 80 default_server;');
    expect(
      ctx.db.prepare('SELECT COUNT(*) c FROM sites WHERE vm_id = ? AND is_default = 1').get(vmId),
    ).toEqual({ c: 1 });
  });

  it('mengulang permintaan yang sama tidak mengubah apa pun', async () => {
    reset();
    const r = await call(app, owner, 'POST', url('toko.contoh.com'), { enabled: true });
    expect(r.statusCode).toBe(200);
    expect(cmds()).toEqual([]);
  });

  it('nginx menolak konfigurasi: halaman bawaan dipulihkan dan status tidak berubah', async () => {
    reset();
    failCommand = /nginx.*-t/;
    const r = await call(app, owner, 'POST', url('blog.contoh.com'), { enabled: true });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe('webserver_rejected');
    expect(isDefault('blog.contoh.com')).toBe(0);
    expect(isDefault('toko.contoh.com')).toBe(1); // tidak berubah
    expect(
      cmds().some(
        (x) =>
          x.includes('ln') &&
          x.includes('sites-available/default') &&
          x.includes('sites-enabled/default'),
      ),
    ).toBe(true);
    // konfigurasi situs utama sebelumnya (toko) ditulis kembali apa adanya
    const restore = execLog.filter(
      (e) => e.command.includes('toko.contoh.com.conf') && e.command.includes('tee'),
    );
    expect(restore.at(-1)!.stdin).toContain('listen 80 default_server;');
    failCommand = null;
  });

  it('melepas: halaman bawaan dipulihkan (symlink), konfigurasi tanpa default_server', async () => {
    reset();
    const r = await call(app, owner, 'POST', url('toko.contoh.com'), { enabled: false });
    expect(r.statusCode).toBe(200);
    expect(r.json().isDefault).toBe(false);
    expect(isDefault('toko.contoh.com')).toBe(0);
    const c = cmds();
    expect(
      c.some((x) => x.includes('ln') && x.includes('/etc/nginx/sites-available/default')),
    ).toBe(false); // fake: file bawaan dianggap sudah terhubung
    const write = execLog.find(
      (e) => e.command.includes('toko.contoh.com.conf') && e.command.includes('tee'),
    )!;
    expect(write.stdin).not.toContain('default_server');
  });

  it('audit mencatat aksi dan tidak memuat isi konfigurasi', () => {
    const rows = ctx.db
      .prepare("SELECT action, target FROM audit_logs WHERE action LIKE 'site.default%'")
      .all() as {
      action: string;
      target: string;
    }[];
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['site.default_on', 'site.default_off']),
    );
    expect(JSON.stringify(rows)).not.toContain('server_name');
  });
});
