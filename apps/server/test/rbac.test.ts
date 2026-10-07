import type WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, login, makeApp, ORIGIN, seedUser, type Client, type TestUser } from './helpers.js';
import { startFakeSsh } from './fakeSsh.js';

const built = await makeApp();
const { app, ctx } = built;
let fake: Awaited<ReturnType<typeof startFakeSsh>>;
let admin: Client, a: Client, b: Client;
let userA: TestUser, userB: TestUser;
let vmA: string, vmB: string;

beforeAll(async () => {
  fake = await startFakeSsh();
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
  expect(
    (await call(app, admin, 'PUT', `/api/vms/${vmA}/assignment`, { userId: userA.row.id }))
      .statusCode,
  ).toBe(200);
  expect(
    (await call(app, admin, 'PUT', `/api/vms/${vmB}/assignment`, { userId: userB.row.id }))
      .statusCode,
  ).toBe(200);
});

afterAll(async () => {
  await app.close();
  await fake.close();
});

const openWs = (url: string, init: { headers: Record<string, string> }) =>
  app.injectWS(url, { ...init, socket: { remoteAddress: '127.0.0.1' } } as never);

const nextMessage = (ws: WebSocket, match: (m: string) => boolean, ms = 5000) =>
  new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout menunggu pesan WS')), ms);
    ws.on('message', (data: Buffer) => {
      const s = data.toString('utf8');
      if (match(s)) {
        clearTimeout(t);
        resolve(s);
      }
    });
  });

describe('otorisasi VM (IDOR)', () => {
  it('client hanya melihat VM miliknya', async () => {
    const res = await call(app, a, 'GET', '/api/vms');
    expect(res.json().items.map((v: { id: string }) => v.id)).toEqual([vmA]);
  });

  it('client A tidak bisa membaca VM milik B (404, tidak 403)', async () => {
    expect((await call(app, a, 'GET', `/api/vms/${vmB}`)).statusCode).toBe(404);
    expect((await call(app, b, 'GET', `/api/vms/${vmA}`)).statusCode).toBe(404);
    expect((await call(app, a, 'GET', `/api/vms/${vmA}`)).statusCode).toBe(200);
  });

  it('client tidak bisa melakukan aksi admin', async () => {
    expect(
      (await call(app, a, 'POST', '/api/vms', { name: 'x1', host: '1.1.1.1', sshUser: 'u' }))
        .statusCode,
    ).toBe(403);
    expect((await call(app, a, 'DELETE', `/api/vms/${vmA}`)).statusCode).toBe(403);
    expect((await call(app, a, 'PATCH', `/api/vms/${vmA}`, { name: 'hack' })).statusCode).toBe(403);
    expect(
      (await call(app, a, 'PUT', `/api/vms/${vmB}/assignment`, { userId: userA.row.id }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await call(app, a, 'POST', `/api/vms/${vmA}/host-key/approve`, {
          fingerprint: 'SHA256:' + 'A'.repeat(43),
        })
      ).statusCode,
    ).toBe(403);
    expect((await call(app, a, 'GET', '/api/users')).statusCode).toBe(403);
    expect((await call(app, a, 'GET', '/api/audit')).statusCode).toBe(403);
  });

  it('respons VM tidak pernah memuat private key; client juga tidak melihat public key/pemilik', async () => {
    const asAdmin = (await call(app, admin, 'GET', `/api/vms/${vmA}`)).body;
    const asClient = (await call(app, a, 'GET', `/api/vms/${vmA}`)).body;
    for (const body of [asAdmin, asClient]) {
      expect(body).not.toMatch(/PRIVATE KEY/);
      expect(body).not.toMatch(/ssh_private_key/);
    }
    expect(JSON.parse(asClient).publicKey).toBeUndefined();
    expect(JSON.parse(asClient).assignedTo).toBeUndefined();
    expect(JSON.parse(asAdmin).publicKey).toMatch(/^ssh-ed25519/);
  });

  it('satu VM hanya untuk satu client, satu client hanya satu VM', async () => {
    const r1 = await call(app, admin, 'PUT', `/api/vms/${vmA}/assignment`, {
      userId: userB.row.id,
    });
    expect(r1.statusCode).toBe(409);
  });

  it('notifikasi milik user lain tidak bisa disentuh', async () => {
    const mine = ctx.db
      .prepare('SELECT id FROM notifications WHERE user_id = ? LIMIT 1')
      .get(userA.row.id) as { id: string };
    expect((await call(app, b, 'POST', `/api/notifications/${mine.id}/read`)).statusCode).toBe(404);
    expect((await call(app, a, 'POST', `/api/notifications/${mine.id}/read`)).statusCode).toBe(200);
  });

  it('modul dimatikan -> terminal ditolak (403)', async () => {
    ctx.db
      .prepare('UPDATE vms SET modules_enabled = ? WHERE id = ?')
      .run('{"terminal":false}', vmB);
    await expect(
      openWs(`/api/vms/${vmB}/terminal`, { headers: { origin: ORIGIN, cookie: b.cookie } }),
    ).rejects.toThrow(/403/);
    ctx.db.prepare('UPDATE vms SET modules_enabled = ? WHERE id = ?').run('{"terminal":true}', vmB);
  });
});

describe('host key SSH', () => {
  it('koneksi ditolak sebelum host key disetujui, diterima setelah disetujui', async () => {
    const before = await call(app, admin, 'POST', `/api/vms/${vmA}/test`);
    expect(before.statusCode).toBe(409);
    expect(before.json().error).toBe('host_key_unapproved');

    const scan = await call(app, admin, 'POST', `/api/vms/${vmA}/host-key/scan`);
    expect(scan.statusCode).toBe(200);
    const fingerprint = scan.json().fingerprint as string;

    const wrong = await call(app, admin, 'POST', `/api/vms/${vmA}/host-key/approve`, {
      fingerprint: 'SHA256:' + 'A'.repeat(43),
    });
    expect(wrong.statusCode).toBe(409);
    expect(
      (await call(app, admin, 'POST', `/api/vms/${vmA}/host-key/approve`, { fingerprint }))
        .statusCode,
    ).toBe(200);

    const after = await call(app, admin, 'POST', `/api/vms/${vmA}/test`);
    expect(after.statusCode).toBe(200);
    expect(after.json().status).toBe('online');
  });

  it('koneksi ditolak bila host key berubah', async () => {
    ctx.db
      .prepare('UPDATE vms SET host_key_fingerprint = ? WHERE id = ?')
      .run('SHA256:' + 'B'.repeat(43), vmB);
    const res = await call(app, admin, 'POST', `/api/vms/${vmB}/test`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('host_key_changed');
  });
});

describe('terminal', () => {
  it('menolak origin asing dan pengguna tanpa sesi', async () => {
    await expect(
      openWs(`/api/vms/${vmA}/terminal`, {
        headers: { origin: 'https://jahat.example', cookie: a.cookie },
      }),
    ).rejects.toThrow(/403/);
    await expect(
      openWs(`/api/vms/${vmA}/terminal`, { headers: { origin: ORIGIN } }),
    ).rejects.toThrow(/401/);
  });

  it('client B tidak bisa membuka terminal VM milik A', async () => {
    await expect(
      openWs(`/api/vms/${vmA}/terminal`, { headers: { origin: ORIGIN, cookie: b.cookie } }),
    ).rejects.toThrow(/404/);
  });

  it('terminal berfungsi end-to-end, menolak pesan tidak valid, dan putus saat akun disuspend', async () => {
    const ws = (await openWs(`/api/vms/${vmA}/terminal?cols=100&rows=30`, {
      headers: { origin: ORIGIN, cookie: a.cookie },
    })) as unknown as WebSocket;
    await nextMessage(ws, (m) => m.includes('"connected"'));
    await nextMessage(ws, (m) => m.includes('hello'));
    expect(ctx.terminals.size).toBe(1);

    ws.send(JSON.stringify({ t: 'input', d: 'halo\r' }));
    await nextMessage(ws, (m) => m.includes('halo'));
    ws.send(JSON.stringify({ t: 'resize', cols: 120, rows: 40 }));

    const closed = new Promise<void>((r) => ws.on('close', () => r()));
    const res = await call(app, admin, 'PATCH', `/api/users/${userA.row.id}`, {
      status: 'suspended',
    });
    expect(res.statusCode).toBe(200);
    await closed;
    expect(ctx.terminals.size).toBe(0);
    // sesi client yang disuspend langsung tidak berlaku
    expect((await call(app, a, 'GET', '/api/vms')).statusCode).toBe(401);
    const audit = ctx.db
      .prepare("SELECT action FROM audit_logs WHERE vm_id = ? AND action LIKE 'terminal.%'")
      .all(vmA) as { action: string }[];
    expect(audit.map((r) => r.action)).toEqual(['terminal.open', 'terminal.close']);
  });

  it('pesan tidak valid memutus sesi terminal', async () => {
    const adminWs = (await openWs(`/api/vms/${vmA}/terminal`, {
      headers: { origin: ORIGIN, cookie: admin.cookie },
    })) as unknown as WebSocket;
    await nextMessage(adminWs, (m) => m.includes('"connected"'));
    const closed = new Promise<void>((r) => adminWs.on('close', () => r()));
    adminWs.send(JSON.stringify({ t: 'input', d: 'x'.repeat(70 * 1024) }));
    await closed;
    expect(ctx.terminals.size).toBe(0);

    const ws2 = (await openWs(`/api/vms/${vmA}/terminal`, {
      headers: { origin: ORIGIN, cookie: admin.cookie },
    })) as unknown as WebSocket;
    await nextMessage(ws2, (m) => m.includes('"connected"'));
    const closed2 = new Promise<void>((r) => ws2.on('close', () => r()));
    ws2.send(JSON.stringify({ t: 'resize', cols: -5, rows: 'a' }));
    await closed2;
  });
});
