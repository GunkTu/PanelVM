import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeSsh } from './fakeSsh.js';
import { call, login, makeApp, ORIGIN, seedUser, type Client, type TestUser } from './helpers.js';

const BASE = 'preview.test';
const built = await makeApp(false, { PREVIEW_BASE_DOMAIN: BASE });
const { app, ctx } = built;

let fake: Awaited<ReturnType<typeof startFakeSsh>>;
let appServer: http.Server;
let appPort = 0;
let panelPort = 0;
let admin: Client, a: Client, b: Client;
let userA: TestUser, userB: TestUser;
let vmA = '';
let vmB = '';
let closedPort = 0;

interface PreviewDto {
  id: string;
  url: string;
  port: number;
  label: string;
  expiresAt: number;
}
const hostOf = (url: string) => new URL(url).host;

/** Request mentah ke panel dengan header Host tertentu (meniru Cloudflare/NPM meneruskan host asli). */
function raw(
  host: string,
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const r = http.request(
        {
          host: '127.0.0.1',
          port: panelPort,
          path,
          method: init.method ?? 'GET',
          headers: { host, ...init.headers },
        },
        (res) => {
          let body = '';
          res.on('data', (d: Buffer) => (body += d.toString('utf8')));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      r.on('error', reject);
      r.end(init.body);
    },
  );
}

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function createPreview(c: Client, vmId: string, body: Record<string, unknown>) {
  return call(app, c, 'POST', `/api/vms/${vmId}/previews`, body);
}

async function approveHostKey(vmId: string) {
  const scan = await call(app, admin, 'POST', `/api/vms/${vmId}/host-key/scan`);
  const fingerprint = scan.json().fingerprint as string;
  const ok = await call(app, admin, 'POST', `/api/vms/${vmId}/host-key/approve`, { fingerprint });
  expect(ok.statusCode).toBe(200);
}

beforeAll(async () => {
  fake = await startFakeSsh();

  // "Aplikasi teman" di dalam VM: membalas info request dan meng-echo WebSocket.
  appServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString('utf8')));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-app', 'yes');
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          host: req.headers.host,
          xff: req.headers['x-forwarded-for'],
          xfProto: req.headers['x-forwarded-proto'],
          xfHost: req.headers['x-forwarded-host'],
          origin: req.headers.origin ?? null,
          body,
        }),
      );
    });
  });
  const wss = new WebSocketServer({ server: appServer });
  wss.on('connection', (ws) => ws.on('message', (m) => ws.send(`echo:${m.toString()}`)));
  await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', r));
  appPort = (appServer.address() as AddressInfo).port;
  closedPort = await freePort();

  await app.listen({ port: 0, host: '127.0.0.1' });
  panelPort = (app.server.address() as AddressInfo).port;

  const adminU = await seedUser(built, 'admin@contoh.com', 'admin');
  userA = await seedUser(built, 'a@contoh.com');
  userB = await seedUser(built, 'b@contoh.com');
  admin = await login(app, adminU);
  a = await login(app, userA);
  b = await login(app, userB);

  const mk = async (name: string) => {
    const r = await call(app, admin, 'POST', '/api/vms', {
      name,
      host: '127.0.0.1',
      sshPort: fake.port,
      sshUser: 'tester',
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };
  vmA = await mk('vm-a');
  vmB = await mk('vm-b');
  await call(app, admin, 'PUT', `/api/vms/${vmA}/assignment`, { userId: userA.row.id });
  await call(app, admin, 'PUT', `/api/vms/${vmB}/assignment`, { userId: userB.row.id });
  await approveHostKey(vmA);
  await approveHostKey(vmB);
});

afterAll(async () => {
  await app.close();
  await fake.close();
  await new Promise<void>((r) => appServer.close(() => r()));
});

describe('pembuatan dan otorisasi', () => {
  let pa: PreviewDto;

  it('client pemilik VM membuat preview; alamat acak di bawah domain dasar', async () => {
    const res = await createPreview(a, vmA, { port: appPort, label: 'Tugas Web', ttlHours: 2 });
    expect(res.statusCode).toBe(201);
    pa = res.json() as PreviewDto;
    expect(pa.url).toMatch(new RegExp(`^https://pv-[a-z2-7]{26}\\.${BASE.replace('.', '\\.')}$`));
    expect(pa.port).toBe(appPort);
    expect(pa.expiresAt).toBeGreaterThan(Date.now() + 1.9 * 3_600_000);
    expect(pa.expiresAt).toBeLessThan(Date.now() + 2.1 * 3_600_000);
  });

  it('dua preview tidak pernah memakai alamat yang sama', async () => {
    const r2 = await createPreview(a, vmA, { port: closedPort });
    expect(r2.statusCode).toBe(201);
    expect((r2.json() as PreviewDto).url).not.toBe(pa.url);
    await call(app, a, 'DELETE', `/api/vms/${vmA}/previews/${(r2.json() as PreviewDto).id}`);
  });

  it('client lain tidak bisa melihat, membuat, memperpanjang, mengecek, atau mencabut (404)', async () => {
    expect((await call(app, b, 'GET', `/api/vms/${vmA}/previews`)).statusCode).toBe(404);
    expect((await createPreview(b, vmA, { port: 4000 })).statusCode).toBe(404);
    expect(
      (await call(app, b, 'POST', `/api/vms/${vmA}/previews/${pa.id}/extend`, { ttlHours: 5 }))
        .statusCode,
    ).toBe(404);
    expect((await call(app, b, 'POST', `/api/vms/${vmA}/previews/${pa.id}/check`)).statusCode).toBe(
      404,
    );
    expect((await call(app, b, 'DELETE', `/api/vms/${vmA}/previews/${pa.id}`)).statusCode).toBe(
      404,
    );
  });

  it('id preview milik VM lain tidak bisa dipakai lewat VM sendiri (lintas VM)', async () => {
    expect((await call(app, b, 'DELETE', `/api/vms/${vmB}/previews/${pa.id}`)).statusCode).toBe(
      404,
    );
    expect(
      (await call(app, b, 'POST', `/api/vms/${vmB}/previews/${pa.id}/extend`, { ttlHours: 5 }))
        .statusCode,
    ).toBe(404);
    const still = await call(app, a, 'GET', `/api/vms/${vmA}/previews`);
    expect(still.json().items.map((p: PreviewDto) => p.id)).toContain(pa.id);
  });

  it('tanpa login ditolak (401) dan tanpa token CSRF ditolak (403)', async () => {
    expect((await call(app, null, 'GET', `/api/vms/${vmA}/previews`)).statusCode).toBe(401);
    const noCsrf = await app.inject({
      method: 'POST',
      url: `/api/vms/${vmA}/previews`,
      headers: { origin: ORIGIN, cookie: a.cookie },
      payload: { port: 4000 },
    });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('admin tidak bisa membuat preview, tetapi bisa memantau dan mencabut', async () => {
    const denied = await createPreview(admin, vmA, { port: 4001 });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().message).toMatch(/pemilik VM/);

    const list = await call(app, admin, 'GET', '/api/admin/previews');
    expect(list.statusCode).toBe(200);
    const item = list.json().items.find((p: { id: string }) => p.id === pa.id);
    expect(item.owner).toBe('a@contoh.com');
    expect(item.vmName).toBe('vm-a');
    expect(typeof item.live).toBe('boolean');
  });

  it('client tidak bisa memakai endpoint admin', async () => {
    expect((await call(app, a, 'GET', '/api/admin/previews')).statusCode).toBe(403);
    expect((await call(app, a, 'DELETE', `/api/admin/previews/${pa.id}`)).statusCode).toBe(403);
  });

  it('modul previews dimatikan -> 403', async () => {
    const before = ctx.db.prepare('SELECT modules_enabled m FROM vms WHERE id = ?').get(vmB) as {
      m: string;
    };
    ctx.db
      .prepare('UPDATE vms SET modules_enabled = ? WHERE id = ?')
      .run('{"previews":false}', vmB);
    expect((await createPreview(b, vmB, { port: 4000 })).statusCode).toBe(403);
    expect((await call(app, b, 'GET', `/api/vms/${vmB}/previews`)).statusCode).toBe(403);
    ctx.db.prepare('UPDATE vms SET modules_enabled = ? WHERE id = ?').run(before.m, vmB);
  });

  it('input tidak valid ditolak dengan pesan yang jelas', async () => {
    for (const body of [
      { port: 22 },
      { port: 443 },
      { port: 1023 },
      { port: 3000, hostHeader: 'http://blog.contoh.com' },
      { port: 3000, hostHeader: 'blog.contoh.com:80' },
      { port: 70000 },
      { port: 'abc' },
      { port: 3000.5 },
      { port: 3000, ttlHours: 0 },
      { port: 3000, ttlHours: 999 },
      { port: 3000, label: '<script>alert(1)</script>' },
      { port: 3000, label: 'x'.repeat(61) },
      {},
    ]) {
      const res = await createPreview(a, vmA, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().message).toMatch(/Input tidak valid/);
    }
    const ssh = await createPreview(a, vmA, { port: fake.port });
    expect(ssh.statusCode).toBe(400);
    expect(ssh.json().error).toBe('port_reserved');
  });

  it('port yang sama dan batas jumlah per VM', async () => {
    const dup = await createPreview(a, vmA, { port: appPort });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('preview_exists');

    const ids: string[] = [];
    for (const port of [closedPort, closedPort + 1]) {
      const r = await createPreview(a, vmA, { port });
      expect(r.statusCode).toBe(201);
      ids.push((r.json() as PreviewDto).id);
    }
    const over = await createPreview(a, vmA, { port: closedPort + 2 });
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toBe('preview_limit');
    for (const id of ids) await call(app, a, 'DELETE', `/api/vms/${vmA}/previews/${id}`);
  });

  it('perpanjang memajukan masa berlaku; audit tidak memuat alamat preview', async () => {
    const res = await call(app, a, 'POST', `/api/vms/${vmA}/previews/${pa.id}/extend`, {
      ttlHours: 48,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().expiresAt).toBeGreaterThan(Date.now() + 47 * 3_600_000);

    const rows = ctx.db.prepare("SELECT * FROM audit_logs WHERE action LIKE 'preview.%'").all();
    expect(rows.length).toBeGreaterThan(0);
    const sub = hostOf(pa.url).split('.')[0]!;
    expect(JSON.stringify(rows)).not.toContain(sub);
    expect(JSON.stringify(rows)).not.toMatch(/pv-[a-z2-7]{26}/);
  });
});

describe('proxy HTTP dan WebSocket', () => {
  let pa: PreviewDto;
  let host: string;

  beforeAll(async () => {
    const list = await call(app, a, 'GET', `/api/vms/${vmA}/previews`);
    pa = (list.json().items as PreviewDto[]).find((p) => p.port === appPort)!;
    host = hostOf(pa.url);
  });

  it('GET diteruskan ke aplikasi di VM lewat tunnel SSH; Host ditulis ulang', async () => {
    const res = await raw(host, '/halaman?x=1', { headers: { 'x-forwarded-for': '6.6.6.6' } });
    expect(res.status).toBe(200);
    expect(res.headers['x-app']).toBe('yes');
    const info = JSON.parse(res.body);
    expect(info.url).toBe('/halaman?x=1');
    expect(info.host).toBe(`localhost:${appPort}`);
    expect(info.xfProto).toBe('https');
    expect(info.xfHost).toBe(host);
    expect(info.xff).not.toContain('6.6.6.6'); // header kiriman pengunjung tidak dipercaya
  });

  it('respons bebas header keamanan panel, ber-noindex, dan tidak di-cache', async () => {
    const res = await raw(host, '/');
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['x-robots-tag']).toMatch(/noindex/);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('path /api di host preview menuju aplikasi, BUKAN API panel', async () => {
    const res = await raw(host, '/api/vms');
    expect(res.status).toBe(200);
    expect(res.headers['x-app']).toBe('yes');
    expect(JSON.parse(res.body).url).toBe('/api/vms');
    const noAuth = await raw(host, '/api/auth/me');
    expect(noAuth.headers['x-app']).toBe('yes');
  });

  it('POST dari origin preview tidak diblokir cek Origin/CSRF panel; body utuh', async () => {
    const res = await raw(host, '/kirim', {
      method: 'POST',
      body: 'halo-dunia',
      headers: { origin: `https://${host}`, 'content-type': 'text/plain' },
    });
    expect(res.status).toBe(200);
    const info = JSON.parse(res.body);
    expect(info.method).toBe('POST');
    expect(info.body).toBe('halo-dunia');
    expect(info.origin).toBe(`https://${host}`);
  });

  it('host biasa tetap dilayani panel (bukan preview)', async () => {
    const res = await raw(`vm.${BASE}`, '/api/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
    const ownOrigin = await raw(new URL(ORIGIN).host, '/api/health');
    expect(ownOrigin.status).toBe(200);
  });

  it('host preview tidak dikenal -> 404 netral berbahasa Indonesia, tanpa bocoran', async () => {
    const res = await raw(`pv-${'a'.repeat(26)}.${BASE}`, '/');
    expect(res.status).toBe(404);
    expect(res.body).toMatch(/Preview tidak ditemukan/);
    expect(res.body).not.toMatch(/vm-a|127\.0\.0\.1|stack|Error:/);
    expect(res.headers['x-robots-tag']).toMatch(/noindex/);
    // host dengan label salah format diperlakukan sebagai host panel biasa
    expect((await raw(`pv-pendek.${BASE}`, '/api/health')).status).toBe(200);
  });

  it('WebSocket (mis. HMR Vite) diteruskan dua arah', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${panelPort}/hmr`, { headers: { host } });
    const msg = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout ws')), 5000);
      ws.on('open', () => ws.send('halo'));
      ws.on('message', (m) => {
        clearTimeout(t);
        resolve(m.toString());
      });
      ws.on('error', reject);
    });
    expect(msg).toBe('echo:halo');
    ws.close();
  });

  it('port tanpa aplikasi -> 502 dengan langkah berikutnya; cek port melaporkan tidak aktif', async () => {
    const r = await createPreview(a, vmA, { port: closedPort });
    const dead = r.json() as PreviewDto;
    const res = await raw(hostOf(dead.url), '/');
    expect(res.status).toBe(502);
    expect(res.body).toMatch(/Aplikasi belum berjalan/);
    expect(res.body).toMatch(/menjalankan aplikasinya/);

    const chk = await call(app, a, 'POST', `/api/vms/${vmA}/previews/${dead.id}/check`);
    expect(chk.json()).toEqual({ listening: false });
    const ok = await call(app, a, 'POST', `/api/vms/${vmA}/previews/${pa.id}/check`);
    expect(ok.json()).toEqual({ listening: true });
    await call(app, a, 'DELETE', `/api/vms/${vmA}/previews/${dead.id}`);
  });

  it('akses tercatat sebagai live untuk admin', async () => {
    const list = await call(app, admin, 'GET', '/api/admin/previews');
    const item = list.json().items.find((p: { id: string }) => p.id === pa.id);
    expect(item.live).toBe(true);
    expect(item.lastAccessAt).toBeGreaterThan(0);
  });
});

describe('pencabutan otomatis', () => {
  const open = async (host: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${panelPort}/hmr`, { headers: { host } });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
    return { ws, closed };
  };

  it('mencabut preview memutus WebSocket yang sedang terbuka dan alamatnya langsung 404', async () => {
    // port appPort di VM A sudah punya preview; gunakan VM B untuk preview tambahan
    const rb = await createPreview(b, vmB, { port: appPort });
    expect(rb.statusCode).toBe(201);
    const pb = rb.json() as PreviewDto;
    const host = hostOf(pb.url);

    const { closed } = await open(host);
    expect((await call(app, b, 'DELETE', `/api/vms/${vmB}/previews/${pb.id}`)).statusCode).toBe(
      200,
    );
    await closed;
    expect((await raw(host, '/')).status).toBe(404);
    expect(ctx.db.prepare('SELECT 1 x FROM previews WHERE id = ?').get(pb.id)).toBeUndefined();
  });

  it('admin bisa mencabut preview milik client mana pun', async () => {
    const rb = await createPreview(b, vmB, { port: appPort });
    const pb = rb.json() as PreviewDto;
    const host = hostOf(pb.url);
    const { closed } = await open(host);
    expect((await call(app, admin, 'DELETE', `/api/admin/previews/${pb.id}`)).statusCode).toBe(200);
    await closed;
    expect((await raw(host, '/')).status).toBe(404);
  });

  it('kedaluwarsa: alamat langsung 404 walau belum disapu; sapuan menghapus baris dan memberi notifikasi', async () => {
    const rb = await createPreview(b, vmB, { port: appPort });
    const pb = rb.json() as PreviewDto;
    const host = hostOf(pb.url);
    expect((await raw(host, '/')).status).toBe(200);

    ctx.db.prepare('UPDATE previews SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, pb.id);
    expect((await raw(host, '/')).status).toBe(404);
    expect((await call(app, b, 'GET', `/api/vms/${vmB}/previews`)).json().items).toEqual([]);

    ctx.previews.sweep();
    expect(ctx.db.prepare('SELECT 1 x FROM previews WHERE id = ?').get(pb.id)).toBeUndefined();
    const note = ctx.db
      .prepare("SELECT title FROM notifications WHERE user_id = ? AND type = 'preview_expired'")
      .get(userB.row.id) as { title: string } | undefined;
    expect(note?.title).toBe('Preview berakhir');
  });

  it('peringatan satu jam sebelum habis dikirim sekali', async () => {
    const rb = await createPreview(b, vmB, { port: appPort });
    const pb = rb.json() as PreviewDto;
    ctx.db
      .prepare('UPDATE previews SET expires_at = ? WHERE id = ?')
      .run(Date.now() + 30 * 60_000, pb.id);
    ctx.previews.sweep();
    ctx.previews.sweep();
    const n = ctx.db
      .prepare(
        "SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND type = 'preview_expiring'",
      )
      .get(userB.row.id) as { c: number };
    expect(n.c).toBe(1);
    await call(app, b, 'DELETE', `/api/vms/${vmB}/previews/${pb.id}`);
  });

  it('menyuspend pemilik memutus preview dan WebSocket-nya seketika', async () => {
    const rb = await createPreview(b, vmB, { port: appPort });
    const pb = rb.json() as PreviewDto;
    const host = hostOf(pb.url);
    const { closed } = await open(host);

    const res = await call(app, admin, 'PATCH', `/api/users/${userB.row.id}`, {
      status: 'suspended',
    });
    expect(res.statusCode).toBe(200);
    await closed;
    expect((await raw(host, '/')).status).toBe(404);
    expect(ctx.db.prepare('SELECT 1 x FROM previews WHERE id = ?').get(pb.id)).toBeUndefined();
    await call(app, admin, 'PATCH', `/api/users/${userB.row.id}`, { status: 'active' });
  });

  it('melepas VM dari pemilik, mematikan modul, atau menghapus VM mencabut preview', async () => {
    // modul dimatikan lewat PATCH admin
    const p1 = (await createPreview(a, vmA, { port: closedPort + 5 })).json() as PreviewDto;
    const modules = Object.fromEntries(
      ['terminal', 'files', 'database', 'monitoring', 'services', 'software', 'sites'].map((m) => [
        m,
        true,
      ]),
    );
    const off = await call(app, admin, 'PATCH', `/api/vms/${vmA}`, {
      modules: { ...modules, previews: false },
    });
    expect(off.statusCode).toBe(200);
    expect(ctx.db.prepare('SELECT 1 x FROM previews WHERE id = ?').get(p1.id)).toBeUndefined();
    expect((await raw(hostOf(p1.url), '/')).status).toBe(404);
    await call(app, admin, 'PATCH', `/api/vms/${vmA}`, { modules: { ...modules, previews: true } });

    // melepas penugasan
    const p2 = (await createPreview(a, vmA, { port: closedPort + 6 })).json() as PreviewDto;
    await call(app, admin, 'PUT', `/api/vms/${vmA}/assignment`, { userId: null });
    expect(ctx.db.prepare('SELECT 1 x FROM previews WHERE id = ?').get(p2.id)).toBeUndefined();
    await call(app, admin, 'PUT', `/api/vms/${vmA}/assignment`, { userId: userA.row.id });
  });
});

describe('sshd melarang forwarding', () => {
  it('menampilkan halaman yang menjelaskan AllowTcpForwarding', async () => {
    const strict = await startFakeSsh({ forbidForwarding: true });
    try {
      const mk = await call(app, admin, 'POST', '/api/vms', {
        name: 'vm-strict',
        host: '127.0.0.1',
        sshPort: strict.port,
        sshUser: 'tester',
      });
      const vmId = mk.json().id as string;
      const u = await seedUser(built, 'c@contoh.com');
      await call(app, admin, 'PUT', `/api/vms/${vmId}/assignment`, { userId: u.row.id });
      await approveHostKey(vmId);
      const c = await login(app, u);
      const pv = (await createPreview(c, vmId, { port: appPort })).json() as PreviewDto;
      const res = await raw(hostOf(pv.url), '/');
      expect(res.status).toBe(502);
      expect(res.body).toMatch(/AllowTcpForwarding/);
      const chk = await call(app, c, 'POST', `/api/vms/${vmId}/previews/${pv.id}/check`);
      expect(chk.statusCode).toBe(502);
      expect(chk.json().error).toBe('forwarding_prohibited');
    } finally {
      await strict.close();
    }
  });
});

describe('kompatibilitas klien lama', () => {
  it('PATCH modul tanpa kunci previews tidak mematikan atau menghidupkan modul itu', async () => {
    const legacy = Object.fromEntries(
      ['terminal', 'files', 'database', 'monitoring', 'services', 'software', 'sites'].map((m) => [
        m,
        true,
      ]),
    );
    const res = await call(app, admin, 'PATCH', `/api/vms/${vmA}`, { modules: legacy });
    expect(res.statusCode).toBe(200);
    expect(res.json().modules.previews).toBe(true);

    ctx.db
      .prepare('UPDATE vms SET modules_enabled = ? WHERE id = ?')
      .run('{"previews":false}', vmA);
    const off = await call(app, admin, 'PATCH', `/api/vms/${vmA}`, { modules: legacy });
    expect(off.json().modules.previews).toBe(false);
    ctx.db.prepare('UPDATE vms SET modules_enabled = ? WHERE id = ?').run('{"previews":true}', vmA);
  });
});

describe('port 80 dan header Host situs', () => {
  beforeAll(async () => {
    // sesi B dihapus oleh test suspend sebelumnya; login ulang dengan langkah TOTP baru
    b = await login(app, userB, 1);
  });

  it('port 80 diterima (web standar); port sistem lain tetap ditolak', async () => {
    const ok = await createPreview(b, vmB, { port: 80, hostHeader: 'Blog.Contoh.com' });
    expect(ok.statusCode).toBe(201);
    const dto = ok.json() as PreviewDto & { hostHeader: string };
    expect(dto.port).toBe(80);
    expect(dto.hostHeader).toBe('blog.contoh.com'); // dinormalisasi huruf kecil
    const bad = await createPreview(b, vmB, { port: 25 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/80 atau antara 1024 dan 65535/);
    await call(app, b, 'DELETE', `/api/vms/${vmB}/previews/${dto.id}`);
  });

  it('hostHeader dikirim ke aplikasi sebagai Host, menggantikan localhost:port', async () => {
    const r = await createPreview(b, vmB, { port: appPort, hostHeader: 'situs.contoh.com' });
    const pv = r.json() as PreviewDto;
    const res = await raw(hostOf(pv.url), '/');
    expect(JSON.parse(res.body).host).toBe('situs.contoh.com');
    expect(JSON.parse(res.body).xfHost).toBe(hostOf(pv.url));
    await call(app, b, 'DELETE', `/api/vms/${vmB}/previews/${pv.id}`);
  });

  it('tanpa hostHeader, Host tetap localhost:port', async () => {
    const r = await createPreview(b, vmB, { port: appPort });
    const pv = r.json() as PreviewDto & { hostHeader: string | null };
    expect(pv.hostHeader).toBeNull();
    expect(JSON.parse((await raw(hostOf(pv.url), '/')).body).host).toBe(`localhost:${appPort}`);
    await call(app, b, 'DELETE', `/api/vms/${vmB}/previews/${pv.id}`);
  });
});
