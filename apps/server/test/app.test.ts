import { afterAll, describe, expect, it } from 'vitest';
import { makeApp } from './helpers.js';

const { app } = await makeApp();
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

  it('endpoint terlindungi menolak tanpa sesi', async () => {
    for (const url of [
      '/api/vms',
      '/api/users',
      '/api/audit',
      '/api/notifications',
      '/api/auth/me',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('tidak ada endpoint registrasi publik', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { origin: 'https://panel.contoh.com' },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});
