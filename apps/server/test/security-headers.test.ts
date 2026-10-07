import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { PASSWORD, ORIGIN, seedUser, testEnv } from './helpers.js';

describe('mode produksi', () => {
  it('cookie sesi memakai __Host-, Secure, HttpOnly, SameSite=Strict, tanpa Domain', async () => {
    const built = await buildApp(
      testEnv({
        NODE_ENV: 'production',
        APP_ORIGIN: 'https://vm.thegt.my.id',
        TRUST_PROXY: 'true',
      }),
      { rateLimit: false },
    );
    await built.app.ready();
    const u = await seedUser(built, 'prod@contoh.com');
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://vm.thegt.my.id', 'x-forwarded-proto': 'https' },
      payload: { email: u.email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^__Host-sid=/);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/i);
    // origin dev tidak berlaku di produksi
    const bad = await built.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN },
      payload: { email: u.email, password: PASSWORD },
    });
    expect(bad.statusCode).toBe(403);
    await built.app.close();
  });
});

describe('header dan kebocoran informasi', () => {
  it('header keamanan ada dan tidak membocorkan teknologi server', async () => {
    const built = await buildApp(testEnv(), { rateLimit: false });
    await built.app.ready();
    const res = await built.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(String(res.headers['content-security-policy'])).toContain("object-src 'none'");
    expect(res.headers['access-control-allow-origin']).toBeUndefined(); // CORS tertutup
    const preflight = await built.app.inject({
      method: 'OPTIONS',
      url: '/api/vms',
      headers: { origin: 'https://jahat.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    await built.app.close();
  });

  it('error tak terduga tidak membocorkan stack, path, atau pesan internal', async () => {
    const built = await buildApp(testEnv(), { rateLimit: false });
    built.app.get('/api/boom', async () => {
      throw new Error('rahasia: /home/panel/.env password=abc123');
    });
    await built.app.ready();
    const res = await built.app.inject({ method: 'GET', url: '/api/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(/rahasia|abc123|\.env|Error:|at \w+|node_modules/);
    expect(res.json().message).toContain('hubungi admin');
    // 404 juga generik
    const nf = await built.app.inject({ method: 'GET', url: '/api/tidak-ada' });
    expect(nf.statusCode).toBe(404);
    await built.app.close();
  });

  it('variasi URL tidak menghindari pengecekan Origin pada metode yang mengubah state', async () => {
    const built = await buildApp(testEnv(), { rateLimit: false });
    await built.app.ready();
    for (const url of ['//api/vms', '/api//vms', '/x/api/vms', '/api/vms/']) {
      const res = await built.app.inject({
        method: 'POST',
        url,
        headers: { origin: 'https://jahat.example' },
        payload: {},
      });
      expect(res.statusCode, url).toBe(403);
    }
    await built.app.close();
  });
});
