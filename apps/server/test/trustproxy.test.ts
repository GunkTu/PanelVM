import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ORIGIN, testEnv } from './helpers.js';

async function ipRecordedFor(trustProxy: string): Promise<string> {
  const { app, ctx } = await buildApp(testEnv({ TRUST_PROXY: trustProxy }), { rateLimit: false });
  await app.ready();
  await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: '127.0.0.1',
    headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.9' },
    payload: { email: 'x@y.zz', password: 'salah' },
  });
  const row = ctx.db
    .prepare("SELECT ip FROM audit_logs WHERE action = 'auth.password' ORDER BY id DESC")
    .get() as { ip: string };
  await app.close();
  return row.ip;
}

describe('IP klien di belakang proxy', () => {
  it('header X-Forwarded-For HANYA dipercaya dari proxy yang terdaftar', async () => {
    expect(await ipRecordedFor('false')).toBe('127.0.0.1'); // tidak percaya proxy: header diabaikan
    expect(await ipRecordedFor('10.0.0.0/8')).toBe('127.0.0.1'); // pengirim bukan proxy terdaftar: header palsu diabaikan
    expect(await ipRecordedFor('127.0.0.1')).toBe('203.0.113.9'); // pengirim adalah proxy terdaftar
    expect(await ipRecordedFor('true')).toBe('203.0.113.9');
  });
});
