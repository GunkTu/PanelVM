import { createHmac, timingSafeEqual } from 'node:crypto';

/** Alias: 3-30 karakter huruf kecil/angka/tanda hubung, tidak diawali atau diakhiri tanda hubung. */
export const ALIAS_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
/** Label host preview = "pv-" + alias (atau 26 karakter acak). Maksimal 33 karakter, jauh di bawah batas DNS 63. */
export const LABEL_RE = /^pv-[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;

/** Kata yang menyesatkan di domain milik pemilik panel (mis. halaman palsu "login"). */
const RESERVED_ALIASES = new Set([
  'admin',
  'administrator',
  'account',
  'auth',
  'bank',
  'billing',
  'cpanel',
  'dashboard',
  'ftp',
  'login',
  'logout',
  'mail',
  'oauth',
  'pay',
  'payment',
  'panel',
  'panelvm',
  'root',
  'secure',
  'signin',
  'signup',
  'sso',
  'support',
  'verify',
  'webmail',
  'www',
]);

/** Pesan kesalahan alias dalam Bahasa Indonesia, atau null bila alias valid (sudah dalam huruf kecil). */
export function aliasError(alias: string): string | null {
  if (!ALIAS_RE.test(alias) || alias.includes('--')) {
    return 'Alias 3-30 karakter: huruf kecil, angka, dan tanda hubung (tidak di awal/akhir, tidak dobel). Contoh: tugas-akhir.';
  }
  if (RESERVED_ALIASES.has(alias)) {
    return 'Alias itu dicadangkan dan tidak bisa dipakai karena bisa menyesatkan pengunjung. Pilih nama lain.';
  }
  return null;
}

export const ACCESS_COOKIE = 'pv_access';
export const MIN_PREVIEW_PASSWORD = 8;
export const MAX_PREVIEW_PASSWORD = 128;

/** Kunci penandatangan cookie akses, diturunkan dari SESSION_SECRET dan terpisah dari cookie sesi panel. */
export const accessKey = (sessionSecret: string): Buffer =>
  createHmac('sha256', sessionSecret).update('preview-access-v1').digest();

const mac = (key: Buffer, payload: string): string =>
  createHmac('sha256', key).update(payload).digest('base64url');

/** Token terikat ke satu preview dan versi aksesnya; mengganti kata sandi/mode menaikkan versi sehingga token lama mati. */
export function signAccess(key: Buffer, previewId: string, version: number, expMs: number): string {
  const payload = `${previewId}.${version}.${expMs}`;
  return `${payload}.${mac(key, payload)}`;
}

export function verifyAccess(
  key: Buffer,
  token: string | undefined,
  previewId: string,
  version: number,
  now: number,
): boolean {
  if (!token || token.length > 300) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  const given = Buffer.from(token.slice(i + 1));
  const want = Buffer.from(mac(key, payload));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return false;
  const [id, ver, exp] = payload.split('.');
  return id === previewId && Number(ver) === version && Number(exp) > now;
}

/**
 * Tiket sekali pakai dari panel untuk membuka preview milik sistem (mis. phpMyAdmin) di host preview, yang
 * berbeda origin dari panel sehingga cookie sesi panel tidak terkirim. Berlaku singkat, terikat ke satu preview,
 * dan nonce-nya hanya boleh ditukar sekali (lihat PreviewManager.consumeTicket).
 */
export function signTicket(key: Buffer, previewId: string, expMs: number, nonce: string): string {
  const payload = `t.${previewId}.${expMs}.${nonce}`;
  return `${payload}.${mac(key, payload)}`;
}

export function verifyTicket(
  key: Buffer,
  token: string | null | undefined,
  previewId: string,
  now: number,
): { nonce: string; expMs: number } | null {
  if (!token || token.length > 300) return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i);
  const given = Buffer.from(token.slice(i + 1));
  const want = Buffer.from(mac(key, payload));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  const [tag, id, exp, nonce] = payload.split('.');
  if (tag !== 't' || id !== previewId || !nonce || !(Number(exp) > now)) return null;
  return { nonce, expMs: Number(exp) };
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Buang cookie akses panel dari header Cookie sebelum diteruskan ke aplikasi pengguna. */
export function stripCookie(header: string, name: string): string {
  return header
    .split(';')
    .filter((p) => p.slice(0, Math.max(0, p.indexOf('='))).trim() !== name)
    .map((p) => p.trim())
    .filter(Boolean)
    .join('; ');
}

/** Pembatas jendela geser sederhana di memori (cukup untuk satu proses panel). */
export class RateWindow {
  private readonly hits = new Map<string, number[]>();

  /** True bila percobaan diizinkan; false bila `key` sudah mencapai `max` dalam `windowMs`. */
  allow(key: string, max: number, windowMs: number, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  prune(windowMs: number, now = Date.now()): void {
    for (const [k, v] of this.hits) {
      if (v.every((t) => now - t >= windowMs)) this.hits.delete(k);
    }
  }
}
