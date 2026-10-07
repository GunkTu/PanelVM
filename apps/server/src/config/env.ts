import { z } from 'zod';

const base64Key32 = z.string().refine((v) => Buffer.from(v, 'base64').length === 32, {
  message: 'harus 32 byte dalam base64 (contoh: openssl rand -base64 32)',
});

const boolString = z.enum(['true', 'false']).transform((v) => v === 'true');

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
  TRUST_PROXY: boolString.default(false),
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
  return result.data;
}
