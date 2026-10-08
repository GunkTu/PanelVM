/**
 * Apakah request ini boleh dijawab dengan index.html (rute SPA seperti /vms/abc/terminal)?
 * Aset (/assets/*), file berekstensi (.js, .css, .map, ...), dan /api TIDAK boleh: aset yang hilang harus 404
 * sungguhan. Kalau dijawab index.html berstatus 200, browser menganggap HTML itu sebagai JavaScript/CSS (layar putih)
 * dan CDN bisa menyimpannya berjam-jam.
 */
export function isSpaRoute(method: string, url: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const path = url.split('?')[0] ?? '/';
  if (path.startsWith('/api/') || path === '/api') return false;
  if (path.startsWith('/assets/')) return false;
  const last = path.slice(path.lastIndexOf('/') + 1);
  return !last.includes('.');
}

/**
 * Cache-Control untuk berkas statis web. index.html tidak boleh di-cache karena merujuk ke nama aset ber-hash yang
 * berubah tiap build; aset ber-hash di /assets aman di-cache lama.
 */
export function cacheControlFor(filePath: string): string {
  const p = filePath.replace(/\\/g, '/');
  if (p.endsWith('/index.html')) return 'no-cache';
  if (p.includes('/assets/')) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}
