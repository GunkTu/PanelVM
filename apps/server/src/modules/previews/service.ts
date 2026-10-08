import { randomBytes } from 'node:crypto';
import type { Ctx } from '../../context.js';
import { parseModules, type VmRow } from '../../rbac/index.js';
import { notify } from '../notifications/service.js';
import { accessKey, LABEL_RE, RateWindow } from './access.js';

export const PREVIEW_MIN_PORT = 1024;
export const PREVIEW_MAX_PORT = 65535;
/** Port di bawah 1024 umumnya layanan sistem (ssh, smtp, dll.); satu-satunya pengecualian adalah web standar. */
export const PREVIEW_EXTRA_PORTS: readonly number[] = [80];
export const isPreviewPort = (p: number): boolean =>
  Number.isInteger(p) &&
  ((p >= PREVIEW_MIN_PORT && p <= PREVIEW_MAX_PORT) || PREVIEW_EXTRA_PORTS.includes(p));
export const MAX_PREVIEWS_PER_VM = 3;
export const DEFAULT_TTL_HOURS = 24;
export const MAX_TTL_HOURS = 168;
/** Preview permanen (hanya bisa diatur admin) memakai tanggal jauh di masa depan: 9999-12-31. */
export const PERMANENT_EXPIRES_AT = 253_402_300_799_000;
export const isPermanent = (expiresAt: number): boolean => expiresAt >= PERMANENT_EXPIRES_AT;
/** Pilihan masa berlaku untuk admin, dihitung dari sekarang. */
export const ADMIN_EXPIRY_DAYS = { '30d': 30, '90d': 90, '180d': 180, '365d': 365 } as const;
export const MAX_CONNECTIONS_PER_PREVIEW = 64;

const SWEEP_MS = 60_000;
const WARN_BEFORE_MS = 60 * 60 * 1000;
const TOUCH_EVERY_MS = 30_000;
/** Preview dianggap "live" bila ada koneksi terbuka atau diakses dalam rentang ini. */
export const LIVE_WINDOW_MS = 5 * 60 * 1000;

export interface PreviewRow {
  id: string;
  vm_id: string;
  user_id: string;
  subdomain: string;
  port: number;
  label: string;
  host_header: string | null;
  created_at: number;
  expires_at: number;
  last_access_at: number | null;
  warned_at: number | null;
  access: 'public' | 'password';
  password_hash: string | null;
  access_version: number;
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Subdomain acak: "pv-" + 26 karakter base32 (130 bit). Ini sekaligus kunci akses preview. */
export function newSubdomain(): string {
  const bytes = randomBytes(26);
  let out = 'pv-';
  for (const b of bytes) out += B32[b & 31];
  return out;
}

/** Ambil label preview dari header Host, atau null bila host bukan alamat preview untuk domain dasar ini. */
export function previewLabel(hostHeader: string | undefined, baseDomain: string): string | null {
  if (!hostHeader) return null;
  const host = hostHeader.toLowerCase().replace(/:\d+$/, '');
  const suffix = `.${baseDomain}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return LABEL_RE.test(label) ? label : null;
}

export interface ResolvedPreview {
  preview: PreviewRow;
  vm: VmRow;
}

/**
 * Mengelola preview aktif: validasi tiap request, pelacakan koneksi terbuka (agar bisa diputus seketika saat
 * dicabut/kedaluwarsa/akun disuspend), dan pembersihan berkala.
 */
export class PreviewManager {
  private readonly conns = new Map<string, Set<() => void>>();
  private readonly lastTouch = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private readonly attempts = new RateWindow();
  private readonly misses = new RateWindow();
  /** Kunci penandatangan cookie akses preview (terpisah dari cookie sesi panel). */
  readonly accessKey: Buffer;

  constructor(private readonly ctx: Ctx) {
    this.accessKey = accessKey(ctx.env.SESSION_SECRET);
  }

  /** Batas tebakan kata sandi: per (preview, IP) dan per preview secara total. */
  allowLogin(previewId: string, ip: string): boolean {
    const w = 10 * 60_000;
    return this.attempts.allow(`${previewId}|${ip}`, 8, w) && this.attempts.allow(previewId, 60, w);
  }

  /** Batas tebakan alias: setiap IP hanya boleh membuka sejumlah alamat preview tak dikenal per menit. */
  allowMiss(ip: string): boolean {
    return this.misses.allow(ip, 40, 60_000);
  }

  get enabled(): boolean {
    return !!this.ctx.env.PREVIEW_BASE_DOMAIN;
  }

  urlFor(subdomain: string): string {
    return `https://${subdomain}.${this.ctx.env.PREVIEW_BASE_DOMAIN}`;
  }

  start(): void {
    if (this.timer || !this.enabled) return;
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const set of this.conns.values()) for (const close of [...set]) close();
    this.conns.clear();
  }

  /** Daftarkan koneksi terbuka. Mengembalikan fungsi pelepas, atau null bila batas koneksi tercapai. */
  track(previewId: string, close: () => void): (() => void) | null {
    let set = this.conns.get(previewId);
    if (!set) this.conns.set(previewId, (set = new Set()));
    if (set.size >= MAX_CONNECTIONS_PER_PREVIEW) return null;
    set.add(close);
    return () => {
      set.delete(close);
      if (set.size === 0 && this.conns.get(previewId) === set) this.conns.delete(previewId);
    };
  }

  connectionCount(previewId: string): number {
    return this.conns.get(previewId)?.size ?? 0;
  }

  /** Alasan preview tidak lagi sah, atau null bila masih sah. VM dikembalikan agar tidak query dua kali. */
  private validate(p: PreviewRow): { vm: VmRow } | { reason: string } {
    if (p.expires_at <= Date.now()) return { reason: 'expired' };
    const vm = this.ctx.db.prepare('SELECT * FROM vms WHERE id = ?').get(p.vm_id) as
      VmRow | undefined;
    if (!vm) return { reason: 'vm_gone' };
    if (!parseModules(vm.modules_enabled).previews) return { reason: 'module_off' };
    const owner = this.ctx.db
      .prepare(
        `SELECT 1 AS ok FROM users u JOIN vm_access a ON a.user_id = u.id
         WHERE u.id = ? AND u.status = 'active' AND a.vm_id = ?`,
      )
      .get(p.user_id, p.vm_id);
    if (!owner) return { reason: 'owner_gone' };
    return { vm };
  }

  /** Cari preview dari label host. Memeriksa ulang kelayakan di SETIAP request, bukan hanya saat dibuat. */
  resolve(subdomain: string): ResolvedPreview | null {
    const p = this.ctx.db.prepare('SELECT * FROM previews WHERE subdomain = ?').get(subdomain) as
      PreviewRow | undefined;
    if (!p) return null;
    const v = this.validate(p);
    return 'vm' in v ? { preview: p, vm: v.vm } : null;
  }

  /** Catat akses terakhir (dibatasi agar tidak menulis DB di setiap request). */
  touch(previewId: string): void {
    const now = Date.now();
    if (now - (this.lastTouch.get(previewId) ?? 0) < TOUCH_EVERY_MS) return;
    this.lastTouch.set(previewId, now);
    this.ctx.db.prepare('UPDATE previews SET last_access_at = ? WHERE id = ?').run(now, previewId);
  }

  /** Hapus preview dan putuskan semua koneksinya seketika. */
  remove(previewId: string): boolean {
    const set = this.conns.get(previewId);
    if (set) for (const close of [...set]) close();
    this.conns.delete(previewId);
    this.lastTouch.delete(previewId);
    return this.ctx.db.prepare('DELETE FROM previews WHERE id = ?').run(previewId).changes > 0;
  }

  removeByVm(vmId: string): number {
    const rows = this.ctx.db.prepare('SELECT id FROM previews WHERE vm_id = ?').all(vmId) as {
      id: string;
    }[];
    for (const r of rows) this.remove(r.id);
    return rows.length;
  }

  removeByUser(userId: string): number {
    const rows = this.ctx.db.prepare('SELECT id FROM previews WHERE user_id = ?').all(userId) as {
      id: string;
    }[];
    for (const r of rows) this.remove(r.id);
    return rows.length;
  }

  /** Bersihkan preview kedaluwarsa/tidak sah, dan beri peringatan satu jam sebelum habis. */
  sweep(): void {
    this.attempts.prune(10 * 60_000);
    this.misses.prune(60_000);
    const { db, audit } = this.ctx;
    const now = Date.now();
    const all = db.prepare('SELECT * FROM previews').all() as PreviewRow[];
    for (const p of all) {
      const v = this.validate(p);
      if ('reason' in v) {
        this.remove(p.id);
        if (v.reason === 'expired') {
          notify(
            db,
            p.user_id,
            'preview_expired',
            'Preview berakhir',
            `Preview untuk port ${p.port}${p.label ? ` (${p.label})` : ''} sudah kedaluwarsa dan dihapus. Buat preview baru bila masih dibutuhkan.`,
          );
          audit.record({
            userId: p.user_id,
            vmId: p.vm_id,
            action: 'preview.expire',
            target: `port:${p.port}`,
            result: 'ok',
          });
        } else {
          audit.record({
            userId: p.user_id,
            vmId: p.vm_id,
            action: 'preview.purge',
            target: `port:${p.port}`,
            result: 'ok',
            meta: { reason: v.reason },
          });
        }
      } else if (p.warned_at === null && p.expires_at - now <= WARN_BEFORE_MS) {
        db.prepare('UPDATE previews SET warned_at = ? WHERE id = ?').run(now, p.id);
        notify(
          db,
          p.user_id,
          'preview_expiring',
          'Preview hampir berakhir',
          `Preview untuk port ${p.port}${p.label ? ` (${p.label})` : ''} berakhir kurang dari satu jam lagi. Perpanjang dari menu Preview bila masih dibutuhkan.`,
        );
      }
    }
  }
}
