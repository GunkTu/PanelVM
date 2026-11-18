import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, login, makeApp, PASSWORD, seedUser, type Client } from './helpers.js';

const built = await makeApp();
const { app } = built;
let a1: Client, a2: Client, other: Client;

beforeAll(async () => {
  const u = await seedUser(built, 'pengguna@contoh.com');
  a1 = await login(app, u);
  a2 = await login(app, u, 1); // sesi kedua (perangkat lain)
  other = await login(app, await seedUser(built, 'lain@contoh.com'));
});
afterAll(async () => {
  await app.close();
});

const change = (c: Client | null, body: unknown) =>
  call(app, c, 'POST', '/api/auth/password', body);

describe('ganti password login', () => {
  it('tanpa login ditolak', async () => {
    expect(
      (await change(null, { currentPassword: PASSWORD, newPassword: 'x'.repeat(14) })).statusCode,
    ).toBe(401);
  });

  it('password lama salah, password baru terlalu pendek, atau isian kurang: ditolak', async () => {
    const wrong = await change(a1, {
      currentPassword: 'salah-salah-salah',
      newPassword: 'password-baru-123',
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe('wrong_password');
    expect(
      (await change(a1, { currentPassword: PASSWORD, newPassword: 'pendek' })).statusCode,
    ).toBe(400);
    expect((await change(a1, { currentPassword: PASSWORD })).statusCode).toBe(400);
  });

  it('berhasil: sesi ini tetap hidup, sesi lain diputus, akun lain tidak terpengaruh', async () => {
    const r = await change(a1, { currentPassword: PASSWORD, newPassword: 'password-baru-123' });
    expect(r.statusCode).toBe(200);
    expect((await call(app, a1, 'GET', '/api/auth/me')).statusCode).toBe(200);
    expect((await call(app, a2, 'GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await call(app, other, 'GET', '/api/auth/me')).statusCode).toBe(200);
  });

  it('login dengan password lama gagal, dengan password baru lolos tahap pertama', async () => {
    const tryLogin = (password: string) =>
      call(app, null, 'POST', '/api/auth/login', { email: 'pengguna@contoh.com', password });
    expect((await tryLogin(PASSWORD)).statusCode).toBe(401);
    expect((await tryLogin('password-baru-123')).statusCode).toBe(200);
  });

  it('audit mencatat tanpa menyimpan password', async () => {
    const rows = JSON.stringify(
      built.ctx.db
        .prepare("SELECT * FROM audit_logs WHERE action = 'account.password_change'")
        .all(),
    );
    expect(rows).toContain('account.password_change');
    expect(rows).not.toContain('password-baru-123');
    expect(rows).not.toContain(PASSWORD);
  });
});
