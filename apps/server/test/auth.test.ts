import { generateSync } from 'otplib';
import { afterAll, describe, expect, it } from 'vitest';
import { call, cookieFrom, login, makeApp, ORIGIN, PASSWORD, seedUser } from './helpers.js';

const built = await makeApp();
const { app, ctx } = built;
afterAll(() => app.close());

const rawLogin = (email: string, password: string) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: ORIGIN },
    payload: { email, password },
  });

describe('login', () => {
  it('pesan error sama untuk email tidak ada dan password salah', async () => {
    await seedUser(built, 'ada@contoh.com');
    const a = await rawLogin('tidakada@contoh.com', PASSWORD);
    const b = await rawLogin('ada@contoh.com', 'password-salah-sekali');
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json()).toEqual(b.json());
  });

  it('terkunci setelah 5 percobaan gagal, walau password benar', async () => {
    await seedUser(built, 'kunci@contoh.com');
    for (let i = 0; i < 5; i++) await rawLogin('kunci@contoh.com', 'salah-salah-salah');
    const res = await rawLogin('kunci@contoh.com', PASSWORD);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_credentials');
  });

  it('cookie sesi HttpOnly + SameSite=Strict dan token disimpan sebagai hash', async () => {
    const u = await seedUser(built, 'cookie@contoh.com');
    const res = await rawLogin(u.email, PASSWORD);
    const raw = String(res.headers['set-cookie']);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    const token = cookieFrom(res).split('=')[1]!;
    const stored = ctx.db.prepare('SELECT token_hash FROM sessions').all() as {
      token_hash: string;
    }[];
    expect(stored.some((s) => s.token_hash === token)).toBe(false);
  });

  it('menolak origin asing dan permintaan tanpa CSRF', async () => {
    const u = await seedUser(built, 'csrf@contoh.com');
    const c = await login(app, u);
    const badOrigin = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { origin: 'https://jahat.example', cookie: c.cookie, 'x-csrf-token': c.csrf },
    });
    expect(badOrigin.statusCode).toBe(403);
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { origin: ORIGIN, cookie: c.cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
    const ok = await call(app, c, 'POST', '/api/auth/logout');
    expect(ok.statusCode).toBe(200);
    expect((await call(app, c, 'GET', '/api/auth/me')).statusCode).toBe(401);
  });
});

describe('2FA', () => {
  it('sesi sebelum 2FA tidak bisa mengakses data', async () => {
    const u = await seedUser(built, 'pending@contoh.com');
    const r = await rawLogin(u.email, PASSWORD);
    const cookie = cookieFrom(r);
    const res = await app.inject({ method: 'GET', url: '/api/vms', headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });

  it('akun tanpa 2FA wajib setup dulu, lalu dapat recovery code', async () => {
    const u = await seedUser(built, 'baru@contoh.com', 'client', false);
    const r1 = await rawLogin(u.email, PASSWORD);
    expect(r1.json().stage).toBe('pending_setup');
    const cookie = cookieFrom(r1);
    const csrf = r1.json().csrfToken as string;
    expect(
      (await app.inject({ method: 'GET', url: '/api/vms', headers: { cookie } })).statusCode,
    ).toBe(401);

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/2fa/setup',
      headers: { origin: ORIGIN, cookie, 'x-csrf-token': csrf },
      payload: {},
    });
    expect(setup.statusCode).toBe(200);
    const { secret } = setup.json() as { secret: string };

    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/2fa/enable',
      headers: { origin: ORIGIN, cookie, 'x-csrf-token': csrf },
      payload: { code: '000000' },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/2fa/enable',
      headers: { origin: ORIGIN, cookie, 'x-csrf-token': csrf },
      payload: { code: generateSync({ secret }) },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().recoveryCodes).toHaveLength(10);
    expect(
      (await app.inject({ method: 'GET', url: '/api/vms', headers: { cookie: cookieFrom(ok) } }))
        .statusCode,
    ).toBe(200);
    // secret TOTP tersimpan terenkripsi
    const row = ctx.db.prepare('SELECT totp_secret_enc FROM users WHERE id = ?').get(u.row.id) as {
      totp_secret_enc: string;
    };
    expect(row.totp_secret_enc).not.toContain(secret);
  });

  it('kode TOTP yang sama tidak bisa dipakai dua kali (replay)', async () => {
    const u = await seedUser(built, 'replay@contoh.com');
    await login(app, u); // memakai kode langkah saat ini
    const r = await rawLogin(u.email, PASSWORD);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/2fa/verify',
      headers: { origin: ORIGIN, cookie: cookieFrom(r), 'x-csrf-token': r.json().csrfToken },
      payload: { code: generateSync({ secret: u.totpSecret }) },
    });
    expect(res.statusCode).toBe(401);
  });

  it('recovery code hanya berlaku sekali', async () => {
    const u = await seedUser(built, 'recovery@contoh.com', 'client', false);
    const r1 = await rawLogin(u.email, PASSWORD);
    const h = {
      origin: ORIGIN,
      cookie: cookieFrom(r1),
      'x-csrf-token': r1.json().csrfToken as string,
    };
    const { secret } = (
      await app.inject({ method: 'POST', url: '/api/auth/2fa/setup', headers: h, payload: {} })
    ).json();
    const en = await app.inject({
      method: 'POST',
      url: '/api/auth/2fa/enable',
      headers: h,
      payload: { code: generateSync({ secret }) },
    });
    const [code] = en.json().recoveryCodes as string[];

    const tryCode = async () => {
      const r = await rawLogin(u.email, PASSWORD);
      return app.inject({
        method: 'POST',
        url: '/api/auth/2fa/verify',
        headers: { origin: ORIGIN, cookie: cookieFrom(r), 'x-csrf-token': r.json().csrfToken },
        payload: { code },
      });
    };
    expect((await tryCode()).statusCode).toBe(200);
    expect((await tryCode()).statusCode).toBe(401);
  });

  it('sesi pending dihancurkan setelah terlalu banyak kode salah', async () => {
    const u = await seedUser(built, 'brute@contoh.com');
    const r = await rawLogin(u.email, PASSWORD);
    const h = {
      origin: ORIGIN,
      cookie: cookieFrom(r),
      'x-csrf-token': r.json().csrfToken as string,
    };
    let last = 0;
    for (let i = 0; i < 5; i++)
      last = (
        await app.inject({
          method: 'POST',
          url: '/api/auth/2fa/verify',
          headers: h,
          payload: { code: '123456' },
        })
      ).statusCode;
    expect(last).toBe(401);
    const after = await app.inject({
      method: 'POST',
      url: '/api/auth/2fa/verify',
      headers: h,
      payload: { code: generateSync({ secret: u.totpSecret }) },
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().error).toBe('unauthorized');
  });
});

describe('password', () => {
  it('menolak password pendek saat admin membuat client', async () => {
    const admin = await seedUser(built, 'admin-pw@contoh.com', 'admin');
    const c = await login(app, admin);
    const res = await call(app, c, 'POST', '/api/users', {
      email: 'x@contoh.com',
      password: 'pendek',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('12');
  });
});

describe('rate limit', () => {
  it('login dibatasi per IP (10/menit)', async () => {
    const limited = await makeApp(true);
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (
        await limited.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { origin: ORIGIN },
          payload: { email: 'a@b.co', password: 'x' },
        })
      ).statusCode;
    }
    expect(last).toBe(429);
    await limited.app.close();
  });
});

describe('anti-replay TOTP', () => {
  it('dua verifikasi bersamaan dengan kode yang sama: hanya satu yang lolos', async () => {
    const u = await seedUser(built, 'konkuren@contoh.com');
    const code = generateSync({ secret: u.totpSecret });
    const start = async () => {
      const r = await rawLogin(u.email, PASSWORD);
      return { cookie: cookieFrom(r), csrf: r.json().csrfToken as string };
    };
    const [a, b] = await Promise.all([start(), start()]);
    const verify = (s: { cookie: string; csrf: string }) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/2fa/verify',
        headers: { origin: ORIGIN, cookie: s.cookie, 'x-csrf-token': s.csrf },
        payload: { code },
      });
    const results = await Promise.all([verify(a), verify(b)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
  });
});
