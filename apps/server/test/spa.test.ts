import { describe, expect, it } from 'vitest';
import { cacheControlFor, isSpaRoute } from '../src/spa.js';

describe('isSpaRoute', () => {
  it('rute SPA dijawab index.html', () => {
    for (const url of ['/', '/vms', '/vms/abc/terminal', '/admin/previews?x=1', '/login/2fa']) {
      expect(isSpaRoute('GET', url), url).toBe(true);
    }
    expect(isSpaRoute('HEAD', '/vms')).toBe(true);
  });

  it('aset, file berekstensi, dan /api tidak pernah dijawab index.html', () => {
    for (const url of [
      '/assets/index-ABC123.js',
      '/assets/hilang.css',
      '/assets/',
      '/favicon.ico',
      '/robots.txt',
      '/vms/abc/app.js.map',
      '/api/vms',
      '/api',
      '/api/tidak-ada?x=1',
    ]) {
      expect(isSpaRoute('GET', url), url).toBe(false);
    }
  });

  it('metode selain GET/HEAD ditolak', () => {
    expect(isSpaRoute('POST', '/vms')).toBe(false);
    expect(isSpaRoute('DELETE', '/vms')).toBe(false);
  });
});

describe('cacheControlFor', () => {
  it('index.html tidak di-cache, aset ber-hash di-cache lama', () => {
    expect(cacheControlFor('/srv/web/dist/index.html')).toBe('no-cache');
    expect(cacheControlFor(String.raw`D:\web\dist\index.html`)).toBe('no-cache');
    expect(cacheControlFor('/srv/web/dist/assets/index-ABC.js')).toMatch(/immutable/);
    expect(cacheControlFor(String.raw`D:\web\dist\assets\index-ABC.css`)).toMatch(
      /max-age=31536000/,
    );
    expect(cacheControlFor('/srv/web/dist/robots.txt')).toBe('public, max-age=3600');
  });
});
