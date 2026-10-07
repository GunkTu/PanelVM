import { generateSync } from 'otplib';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuiltApp } from '../src/app.js';
import { newTotpSecret } from '../src/auth/totp.js';
import { createUser, type Role, type UserRow } from '../src/auth/users.js';
import { loadEnv } from '../src/config/env.js';

export const ORIGIN = 'https://panel.contoh.com';
export const PASSWORD = 'kata-sandi-panjang-123';

export function testEnv() {
  return loadEnv({
    NODE_ENV: 'test',
    APP_ORIGIN: ORIGIN,
    DATABASE_PATH: ':memory:',
    SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    SESSION_SECRET: 'x'.repeat(40),
  });
}

export async function makeApp(rateLimit = false): Promise<BuiltApp> {
  const built = await buildApp(testEnv(), { rateLimit });
  await built.app.ready();
  return built;
}

export interface TestUser {
  row: UserRow;
  email: string;
  totpSecret: string;
}

/** Buat user langsung di DB dengan 2FA sudah aktif. */
export async function seedUser(
  built: BuiltApp,
  email: string,
  role: Role = 'client',
  withTotp = true,
): Promise<TestUser> {
  const row = await createUser(built.ctx.db, { email, password: PASSWORD, role });
  const secret = newTotpSecret();
  if (withTotp) {
    built.ctx.db
      .prepare('UPDATE users SET totp_secret_enc = ?, totp_enabled = 1 WHERE id = ?')
      .run(built.ctx.box.encrypt(secret, `users.totp:${row.id}`), row.id);
  }
  return { row, email, totpSecret: secret };
}

export interface Client {
  cookie: string;
  csrf: string;
  stage: string;
}

export function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return String(first).split(';')[0]!;
}

/** Login penuh (password + 2FA) dan kembalikan cookie + CSRF. `stepOffset` untuk menghindari replay antar login. */
export async function login(app: FastifyInstance, u: TestUser, stepOffset = 0): Promise<Client> {
  const r1 = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: ORIGIN },
    payload: { email: u.email, password: PASSWORD },
  });
  if (r1.statusCode !== 200) throw new Error(`login gagal: ${r1.body}`);
  let cookie = cookieFrom(r1);
  let csrf = r1.json().csrfToken as string;
  const code = generateSync({
    secret: u.totpSecret,
    epoch: Math.floor(Date.now() / 1000) + stepOffset * 30,
  });
  const r2 = await app.inject({
    method: 'POST',
    url: '/api/auth/2fa/verify',
    headers: { origin: ORIGIN, cookie, 'x-csrf-token': csrf },
    payload: { code },
  });
  if (r2.statusCode !== 200) throw new Error(`2fa gagal: ${r2.body}`);
  cookie = cookieFrom(r2);
  csrf = r2.json().csrfToken as string;
  return { cookie, csrf, stage: 'active' };
}

export const call = (
  app: FastifyInstance,
  c: Client | null,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) =>
  app.inject({
    method,
    url,
    headers: { origin: ORIGIN, ...(c ? { cookie: c.cookie, 'x-csrf-token': c.csrf } : {}) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
