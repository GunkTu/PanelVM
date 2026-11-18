import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signTicket, verifyTicket } from '../src/modules/previews/access.js';
import {
  DETECT_ROOT_SCRIPT,
  DOWNLOAD_SCRIPT,
  newBlowfishSecret,
  pmaConfig,
  pmaNginxConf,
} from '../src/modules/phpmyadmin/spec.js';
import { startFakeSsh } from './fakeSsh.js';
import { call, login, makeApp, seedUser, type Client, type TestUser } from './helpers.js';

const BASE = 'preview.test';
const execLog: { command: string; stdin: string }[] = [];
let failCommand: RegExp | null = null;
const fake = await startFakeSsh({
  execLog,
  execExit: (c) => (failCommand?.test(c) ? 1 : 0),
});
const built = await makeApp(false, { PREVIEW_BASE_DOMAIN: BASE });
const { app, ctx } = built;
let admin: Client, owner: Client, other: Client;
let vmId = '';
let ownerId = '';
let ownerUser: TestUser;
let panelPort = 0;
let pmaServer: http.Server;
let pmaPort = 0;

describe('spec phpMyAdmin', () => {
  it('konfigurasi: root dan password kosong dilarang, server tetap, rahasia 32 karakter', () => {
    const s = newBlowfishSecret();
    expect(s).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(newBlowfishSecret()).not.toBe(s);
    const c = pmaConfig(s);
    expect(c).toContain(`blowfish_secret'] = '${s}'`);
    expect(c).toContain("['AllowRoot'] = false");
    expect(c).toContain("['AllowNoPassword'] = false");
    expect(c).toContain("['AllowArbitraryServer'] = false");
    expect(c).toContain("['host'] = '127.0.0.1'");
    expect(() => pmaConfig("x'; system('id');//")).toThrow();
  });

  it('Nginx hanya mendengarkan di loopback dan memblokir folder internal', () => {
    const c = pmaNginxConf('8.3', '.');
    expect(c).toContain('listen 127.0.0.1:8091;');
    expect(c).not.toMatch(/listen\s+(\*|0\.0\.0\.0|80\b|\[::\])/);
    expect(c).toContain('root /opt/phpmyadmin/current;');
    expect(c).toContain('fastcgi_pass unix:/run/php/php8.3-fpm.sock;');
    expect(c).toMatch(/libraries\|templates\|vendor\|setup/);
    expect(pmaNginxConf('8.2', 'public')).toContain('root /opt/phpmyadmin/current/public;');
    expect(() => pmaNginxConf('8.3; id', '.')).toThrow();
    expect(() => pmaNginxConf('8.3', '.', 80)).toThrow();
  });

  it('skrip unduh memverifikasi checksum dan hanya memakai https', () => {
    expect(DOWNLOAD_SCRIPT).toContain("--proto '=https'");
    expect(DOWNLOAD_SCRIPT).toContain('sha256sum');
    expect(DOWNLOAD_SCRIPT).toMatch(/\[ "\$want" = "\$got" \]/);
    expect(DETECT_ROOT_SCRIPT).toContain('public/index.php');
  });
});

describe('tiket sekali pakai', () => {
  const key = Buffer.alloc(32, 9);
  const now = 1_000_000;

  it('sah hanya untuk preview yang sama dan sebelum kedaluwarsa; dirusak ditolak', () => {
    const t = signTicket(key, 'p1', now + 60_000, 'abc');
    expect(verifyTicket(key, t, 'p1', now)).toEqual({ nonce: 'abc', expMs: now + 60_000 });
    expect(verifyTicket(key, t, 'p2', now)).toBeNull();
    expect(verifyTicket(key, t, 'p1', now + 60_001)).toBeNull();
    expect(verifyTicket(key, t.slice(0, -2) + 'xx', 'p1', now)).toBeNull();
    expect(verifyTicket(Buffer.alloc(32, 1), t, 'p1', now)).toBeNull();
    expect(verifyTicket(key, '', 'p1', now)).toBeNull();
    expect(verifyTicket(key, null, 'p1', now)).toBeNull();
    expect(verifyTicket(key, 'x'.repeat(400), 'p1', now)).toBeNull();
  });
});

function raw(host: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const r = http.request(
        { host: '127.0.0.1', port: panelPort, path, headers: { host, ...headers } },
        (res) => {
          let body = '';
          res.on('data', (d: Buffer) => (body += d.toString('utf8')));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      r.on('error', reject);
      r.end();
    },
  );
}

beforeAll(async () => {
  pmaServer = http.createServer((_req, res) => res.end('PMA-OK'));
  await new Promise<void>((r) => pmaServer.listen(0, '127.0.0.1', r));
  pmaPort = (pmaServer.address() as AddressInfo).port;
  await app.listen({ port: 0, host: '127.0.0.1' });
  panelPort = (app.server.address() as AddressInfo).port;

  admin = await login(app, await seedUser(built, 'admin@contoh.com', 'admin'));
  const ownerU = await seedUser(built, 'pemilik@contoh.com');
  ownerUser = ownerU;
  ownerId = ownerU.row.id;
  owner = await login(app, ownerU);
  other = await login(app, await seedUser(built, 'lain@contoh.com'));
  vmId = (
    await call(app, admin, 'POST', '/api/vms', {
      name: 'vm-pma',
      host: '127.0.0.1',
      sshPort: fake.port,
      sshUser: 'root',
    })
  ).json().id as string;
  await call(app, admin, 'PUT', `/api/vms/${vmId}/assignment`, { userId: ownerId });
  const fp = (await call(app, admin, 'POST', `/api/vms/${vmId}/host-key/scan`)).json().fingerprint;
  await call(app, admin, 'POST', `/api/vms/${vmId}/host-key/approve`, { fingerprint: fp });
});
afterAll(async () => {
  await app.close();
  await fake.close();
  await new Promise<void>((r) => pmaServer.close(() => r()));
});

const url = (p: string) => `/api/vms/${vmId}/phpmyadmin${p}`;

describe('otorisasi dan prasyarat', () => {
  it('tanpa login 401, client lain 404 untuk semua endpoint', async () => {
    for (const [m, p, body] of [
      ['GET', '', undefined],
      ['POST', '/install', { phpVersion: '8.3' }],
      ['POST', '/open', {}],
      ['POST', '/uninstall', { confirm: 'phpmyadmin' }],
    ] as const) {
      expect((await call(app, null, m, url(p), body)).statusCode, `${m} ${p}`).toBe(401);
      expect((await call(app, other, m, url(p), body)).statusCode, `${m} ${p}`).toBe(404);
    }
  });

  it('install: versi PHP salah ditolak; Nginx/PHP belum ada dijelaskan', async () => {
    execLog.length = 0;
    expect(
      (await call(app, owner, 'POST', url('/install'), { phpVersion: '8.3; id' })).statusCode,
    ).toBe(400);
    failCommand = /command -v nginx/;
    const noNginx = await call(app, owner, 'POST', url('/install'), { phpVersion: '8.3' });
    expect(noNginx.statusCode).toBe(409);
    expect(noNginx.json().error).toBe('need_nginx');
    failCommand = /'-S'/;
    const noPhp = await call(app, owner, 'POST', url('/install'), { phpVersion: '8.3' });
    expect(noPhp.json().error).toBe('php_missing');
    failCommand = null;
    expect(execLog.some((e) => e.command.includes('tee'))).toBe(false);
  });

  it('open sebelum terpasang ditolak dengan petunjuk', async () => {
    const r = await call(app, owner, 'POST', url('/open'), {});
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('pma_missing');
  });
});

describe('pasang', () => {
  it('job: unduh+verifikasi, config, Nginx loopback diuji sebelum reload, lalu status tersimpan', async () => {
    execLog.length = 0;
    const r = await call(app, owner, 'POST', url('/install'), { phpVersion: '8.3' });
    expect(r.statusCode).toBe(200);
    const jobId = r.json().id as string;
    for (let i = 0; i < 200; i++) {
      const j = (await call(app, owner, 'GET', `/api/vms/${vmId}/jobs/${jobId}`)).json();
      if (j.status !== 'running') {
        expect(j.status).toBe('succeeded');
        break;
      }
      await new Promise((res) => setTimeout(res, 25));
    }
    const cmds = execLog.map((e) => e.command);
    const download = cmds.findIndex((c) => c.includes('sha256sum'));
    const conf = execLog.findIndex(
      (e) => e.command.includes('tee') && e.command.includes('panelvm-phpmyadmin.conf'),
    );
    const test = cmds.findIndex((c) => c.includes('nginx -t'));
    const reload = cmds.findIndex((c) => c.includes('reload nginx'));
    expect(download).toBeGreaterThan(-1);
    expect(conf).toBeGreaterThan(download);
    expect(execLog[conf]!.stdin).toContain('listen 127.0.0.1:8091;');
    expect(test).toBeGreaterThan(conf);
    expect(reload).toBeGreaterThan(test);
    const cfg = execLog.find(
      (e) => e.command.includes('config.inc.php') && e.command.includes('tee'),
    )!;
    expect(cfg.stdin).toContain("['AllowRoot'] = false");
    const st = (await call(app, owner, 'GET', url(''))).json();
    expect(st.installed).toBe(true);
    expect(st.phpVersion).toBe('8.3');
    expect(st.canOpen).toBe(true);
    // rahasia konfigurasi tidak pernah dikembalikan ke browser
    expect(JSON.stringify(st)).not.toContain('blowfish');
    expect(
      JSON.stringify(ctx.db.prepare("SELECT * FROM audit_logs WHERE action LIKE 'pma.%'").all()),
    ).not.toContain('blowfish');
  });
});

describe('membuka lewat tiket', () => {
  let ticket = '';
  let host = '';

  it('open menghasilkan URL tiket di host preview; preview milik sistem tidak tampil di daftar pengguna', async () => {
    ctx.db.prepare('UPDATE vm_phpmyadmin SET port = ? WHERE vm_id = ?').run(pmaPort, vmId);
    const r = await call(app, owner, 'POST', url('/open'), {});
    expect(r.statusCode).toBe(200);
    const u = new URL(r.json().url as string);
    expect(u.host.endsWith(`.${BASE}`)).toBe(true);
    expect(u.pathname).toBe('/__pv/ticket');
    host = u.host;
    ticket = u.pathname + u.search;
    const list = (await call(app, owner, 'GET', `/api/vms/${vmId}/previews`)).json();
    expect(list.items).toHaveLength(0);
    expect(ctx.db.prepare("SELECT COUNT(*) c FROM previews WHERE purpose = 'pma'").get()).toEqual({
      c: 1,
    });
  });

  it('tanpa cookie halaman tidak terbuka dan tidak menampilkan form kata sandi', async () => {
    const r = await raw(host, '/', { accept: 'text/html' });
    expect(r.status).toBe(401);
    expect(r.body).toContain('Dibuka lewat panel');
    expect(r.body).not.toContain('PMA-OK');
    expect((await raw(host, '/__pv/login')).status).toBe(401);
  });

  it('tiket ditukar sekali menjadi cookie, lalu halaman terbuka; tiket yang sama tidak bisa dipakai lagi', async () => {
    const ex = await raw(host, ticket);
    expect(ex.status).toBe(303);
    const cookie = String(ex.headers['set-cookie']).split(';')[0]!;
    expect(String(ex.headers['set-cookie'])).toContain('HttpOnly');
    const page = await raw(host, '/', { cookie });
    expect(page.status).toBe(200);
    expect(page.body).toBe('PMA-OK');
    const again = await raw(host, ticket);
    expect(again.status).toBe(401);
    expect(again.body).toContain('Tiket tidak berlaku');
  });

  it('tiket rusak atau milik preview lain ditolak', async () => {
    const bad = await raw(host, ticket.slice(0, -3) + 'abc');
    expect(bad.status).toBe(401);
    const r2 = await call(app, owner, 'POST', url('/open'), {});
    const t2 = new URL(r2.json().url as string);
    // tiket valid, tetapi dikirim ke host yang berbeda
    const wrongHost = await raw(`pv-lain.${BASE}`, t2.pathname + t2.search);
    expect(wrongHost.status).not.toBe(303);
  });

  it('admin juga bisa membuka; suspend pemilik mematikan akses yang sudah ada', async () => {
    const r = await call(app, admin, 'POST', url('/open'), {});
    expect(r.statusCode).toBe(200);
    const u = new URL(r.json().url as string);
    const ex = await raw(u.host, u.pathname + u.search);
    const cookie = String(ex.headers['set-cookie']).split(';')[0]!;
    expect((await raw(u.host, '/', { cookie })).status).toBe(200);
    await call(app, admin, 'PATCH', `/api/users/${ownerId}`, { status: 'suspended' });
    expect((await raw(u.host, '/', { cookie })).status).toBe(404);
    await call(app, admin, 'PATCH', `/api/users/${ownerId}`, { status: 'active' });
  });
});

describe('hapus', () => {
  it('butuh konfirmasi; menghapus konfigurasi Nginx, folder tetap milik panel, dan preview sistem', async () => {
    owner = await login(app, ownerUser, 1); // sesi lama diputus oleh suspend di tes sebelumnya
    expect(
      (await call(app, owner, 'POST', url('/uninstall'), { confirm: 'salah' })).statusCode,
    ).toBe(400);
    execLog.length = 0;
    const r = await call(app, owner, 'POST', url('/uninstall'), { confirm: 'phpmyadmin' });
    expect(r.statusCode).toBe(200);
    const rm = execLog.filter((e) => e.command.includes("'rm'"));
    expect(rm.some((e) => e.command.includes('panelvm-phpmyadmin.conf'))).toBe(true);
    expect(rm.some((e) => e.command.includes('/opt/phpmyadmin'))).toBe(true);
    expect(
      rm.some((e) => e.command.includes('/var/www') || e.command.includes('/var/lib/mysql')),
    ).toBe(false);
    expect(ctx.db.prepare("SELECT COUNT(*) c FROM previews WHERE purpose = 'pma'").get()).toEqual({
      c: 0,
    });
    expect((await call(app, owner, 'GET', url(''))).json().installed).toBe(false);
  });
});
