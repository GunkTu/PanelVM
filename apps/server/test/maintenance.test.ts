import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, login, makeApp, seedUser, type Client } from './helpers.js';

const built = await makeApp();
const { app, ctx } = built;
let admin: Client, client: Client;

beforeAll(async () => {
  admin = await login(app, await seedUser(built, 'admin@contoh.com', 'admin'));
  client = await login(app, await seedUser(built, 'klien@contoh.com'));
});
afterAll(async () => {
  await app.close();
});

const put = (c: Client | null, body: unknown) =>
  call(app, c, 'PUT', '/api/admin/maintenance', body);

describe('mode maintenance', () => {
  it('bawaan nonaktif dan statusnya publik', async () => {
    const r = await call(app, null, 'GET', '/api/maintenance');
    expect(r.statusCode).toBe(200);
    expect(r.json().enabled).toBe(false);
    expect((await call(app, client, 'GET', '/api/vms')).statusCode).toBe(200);
  });

  it('hanya admin yang boleh mengubah; masukan salah ditolak', async () => {
    expect((await put(null, { enabled: true })).statusCode).toBe(401);
    expect((await put(client, { enabled: true })).statusCode).toBe(403);
    expect((await put(admin, {})).statusCode).toBe(400);
    expect((await put(admin, { enabled: true, message: 'x'.repeat(301) })).statusCode).toBe(400);
    expect((await call(app, null, 'GET', '/api/maintenance')).json().enabled).toBe(false);
  });

  it('aktif: client mendapat 503 dengan pesan, admin tetap normal, login dan status tetap terbuka', async () => {
    const r = await put(admin, { enabled: true, message: 'Sedang update versi baru.' });
    expect(r.statusCode).toBe(200);

    const blocked = await call(app, client, 'GET', '/api/vms');
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json()).toEqual({ error: 'maintenance', message: 'Sedang update versi baru.' });
    expect((await call(app, client, 'GET', '/api/notifications')).statusCode).toBe(503);
    expect((await call(app, null, 'GET', '/api/users')).statusCode).toBe(503); // sebelum auth ditolak pun 503

    expect((await call(app, admin, 'GET', '/api/vms')).statusCode).toBe(200);
    expect((await call(app, admin, 'GET', '/api/users')).statusCode).toBe(200);
    expect((await call(app, client, 'GET', '/api/auth/me')).statusCode).toBe(200);
    expect((await call(app, null, 'GET', '/api/health')).statusCode).toBe(200);
    const pub = (await call(app, null, 'GET', '/api/maintenance')).json();
    expect(pub).toMatchObject({ enabled: true, message: 'Sedang update versi baru.' });
  });

  it('status tersimpan di database (bertahan melewati restart)', () => {
    const row = ctx.db
      .prepare("SELECT value FROM app_settings WHERE key = 'maintenance'")
      .get() as {
      value: string;
    };
    expect(JSON.parse(row.value)).toMatchObject({ enabled: true });
  });

  it('dimatikan: client normal lagi; audit mencatat on dan off', async () => {
    expect((await put(admin, { enabled: false })).statusCode).toBe(200);
    expect((await call(app, client, 'GET', '/api/vms')).statusCode).toBe(200);
    const actions = (
      ctx.db
        .prepare("SELECT action FROM audit_logs WHERE action LIKE 'maintenance.%' ORDER BY id")
        .all() as { action: string }[]
    ).map((x) => x.action);
    expect(actions).toEqual(['maintenance.on', 'maintenance.off']);
  });
});
