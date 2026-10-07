import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../errors.js';

export const IDENT = /^[a-z][a-z0-9_]{2,31}$/;

/** Nama yang tidak boleh dipakai sebagai database/user (sistem atau terlalu rawan membingungkan). */
export const RESERVED_NAMES = new Set([
  'mysql',
  'information_schema',
  'performance_schema',
  'sys',
  'root',
  'postgres',
  'template0',
  'template1',
  'mariadb',
  'test',
  'admin',
  'public',
  'default',
  'debian',
  'replication',
  'repl',
]);

export const SYSTEM_DATABASES = [
  'information_schema',
  'performance_schema',
  'mysql',
  'sys',
] as const;

export const dbIdentifier = z
  .string()
  .regex(
    IDENT,
    'Nama harus 3-32 karakter: huruf kecil di awal, lalu huruf kecil, angka, atau garis bawah.',
  )
  .refine((n) => !RESERVED_NAMES.has(n), 'Nama ini dicadangkan untuk sistem. Pilih nama lain.');

const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/** Password acak (alfanumerik, 24 karakter) yang dibuat panel; tidak pernah diterima dari browser. */
export function generateDbPassword(): string {
  const bytes = randomBytes(24);
  let out = '';
  for (const b of bytes) out += PW_ALPHABET[b % PW_ALPHABET.length];
  return out;
}

/** Escape literal string SQL MySQL/MariaDB. Dipakai hanya untuk nilai yang sudah divalidasi/dibuat panel. */
export function sqlString(value: string): string {
  if (value.includes('\0')) throw new Error('String SQL tidak boleh memuat NUL');
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Quote identifier (hanya setelah lolos IDENT). */
export function sqlIdent(name: string): string {
  if (!IDENT.test(name)) throw new Error('Identifier tidak valid');
  return `\`${name}\``;
}

/**
 * Nama user (role) per engine. PostgreSQL mencadangkan awalan "pg_" untuk role bawaan sistem,
 * jadi CREATE ROLE dengan awalan itu pasti ditolak; beri pesan jelas sebelum sampai ke server database.
 */
export function assertRoleName(engine: 'mysql' | 'postgres', name: string): void {
  if (engine === 'postgres' && name.startsWith('pg_')) {
    throw new AppError(
      400,
      'reserved_role_prefix',
      'Nama user PostgreSQL tidak boleh diawali "pg_" (dicadangkan oleh PostgreSQL). Gunakan nama lain, misalnya awali dengan "u_".',
    );
  }
}
