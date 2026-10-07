import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

const env = loadEnv({
  NODE_ENV: 'test',
  APP_ORIGIN: 'https://panel.contoh.com',
  DATABASE_PATH: ':memory:',
  SECRETS_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
  SESSION_SECRET: 'x'.repeat(40),
});
const app = await buildApp(env);
afterAll(() => app.close());

describe('app', () => {
  it('health check berjalan', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('CSP tidak mengizinkan unsafe-inline untuk script', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    const csp = String(res.headers['content-security-policy']);
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
