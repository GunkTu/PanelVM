import { isIP } from 'node:net';
import { z } from 'zod';

const base64Key32 = z.string().refine((v) => Buffer.from(v, 'base64').length === 32, {
  message: 'harus 32 byte dalam base64 (contoh: openssl rand -base64 32)',
});

/** IP atau CIDR (IPv4/IPv6) yang valid. */
export function isIpOrCidr(v: string): boolean {
  const [addr, bits, ...rest] = v.split('/');
  if (rest.length || !addr) return false;
  const ver = isIP(addr);
  if (!ver) return false;
  if (bits === undefined) return true;
  const n = Number(bits);
  return /^\d{1,3}$/.test(bits) && n >= 0 && n <= (ver === 4 ? 32 : 128);
}

/**
 * TRUST_PROXY: "false", "true" (percaya semua hop, hanya aman bila panel TIDAK bisa dijangkau selain lewat proxy),
 * atau daftar IP/CIDR proxy tepercaya dipisah koma (disarankan: IP Nginx Proxy Manager).
 */
export const trustProxySchema = z
  .string()
  .default('false')
  .transform((raw, ctx): boolean | string[] => {
    const v = raw.trim();
    if (v === 'true') return true;
    if (v === 'false' || v === '') return false;
    const list = v.split(',').map((x) => x.trim());
    if (!list.every(isIpOrCidr)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'harus "true", "false", atau daftar IP/CIDR proxy dipisah koma (contoh: 192.168.1.10,10.0.0.0/8)',
      });
      return z.NEVER;
    }
    return list;
  });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_ORIGIN: z.url(),
  DATABASE_PATH: z.string().min(1),
  SECRETS_MASTER_KEY: base64Key32,
  SESSION_SECRET: z.string().min(32, 'minimal 32 karakter'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  TRUST_PROXY: trustProxySchema,
  /**
   * HANYA untuk uji lewat IP lokal tanpa HTTPS. Cookie sesi tidak lagi `Secure`/`__Host-`, jadi password dan
   * sesi berjalan sebagai teks biasa di jaringan. JANGAN dipakai bila panel bisa dijangkau dari internet.
   */
  INSECURE_HTTP: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Retensi audit log (hari). Catatan lebih lama dihapus otomatis. */
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
  /** Interval pemeriksaan status VM (detik). 0 = nonaktif. */
  VM_CHECK_INTERVAL_SEC: z.coerce.number().int().min(0).max(3600).default(60),
  /** Batas ukuran satu upload file/SQL/source code (MB). */
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(10240).default(512),
});

export type Env = z.infer<typeof schema>;

export class EnvError extends Error {}

/** Validasi env saat startup. Pesan hanya memuat NAMA variabel, tidak pernah nilainya. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`);
    throw new EnvError(
      `Konfigurasi environment tidak valid. Perbaiki variabel berikut di .env:\n${lines.join('\n')}`,
    );
  }
  if (
    result.success &&
    result.data.INSECURE_HTTP &&
    !result.data.APP_ORIGIN.startsWith('http://')
  ) {
    throw new EnvError(
      'Konfigurasi environment tidak valid. Perbaiki variabel berikut di .env:\n- INSECURE_HTTP: hanya boleh dipakai bila APP_ORIGIN diawali http:// (contoh http://192.168.1.50:3000). Untuk https:// hapus INSECURE_HTTP.',
    );
  }
  return result.data;
}
