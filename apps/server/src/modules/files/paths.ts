import { posix } from 'node:path';
import { z } from 'zod';
import { AppError } from '../../errors.js';

/** Path absolut POSIX yang dinormalisasi di server. Menolak NUL, path relatif, dan terlalu panjang. */
export const remotePath = z
  .string()
  .min(1, 'Path tidak boleh kosong.')
  .max(4096, 'Path terlalu panjang.')
  .refine((p) => !p.includes('\0'), 'Path memuat karakter tidak valid.')
  .refine((p) => p.startsWith('/'), 'Path harus absolut (diawali /).')
  .transform((p) => {
    const n = posix.normalize(p);
    return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
  });

/**
 * Direktori sistem tingkat atas. Client memang root di VM-nya, tapi menghapus/memindah/chmod rekursif
 * direktori ini hampir pasti salah klik, jadi diblokir untuk mencegah kebingungan.
 */
const PROTECTED = new Set([
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lib32',
  '/lib64',
  '/lib/x86_64-linux-gnu',
  '/media',
  '/mnt',
  '/opt',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/srv',
  '/sys',
  '/tmp',
  '/usr',
  '/var',
]);

export const isProtectedPath = (p: string): boolean => PROTECTED.has(p);

export function assertNotProtected(p: string): void {
  if (isProtectedPath(p)) {
    throw new AppError(
      400,
      'protected_path',
      `Folder sistem "${p}" dilindungi dan tidak bisa dihapus, dipindah, atau diubah rekursif dari panel. Pilih folder di dalamnya.`,
    );
  }
}

export const baseName = (p: string): string => posix.basename(p);
export const dirName = (p: string): string => posix.dirname(p);

/** Nama file/folder tunggal (tanpa slash). */
export const entryName = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (n) => !n.includes('/') && !n.includes('\0') && n !== '.' && n !== '..',
    'Nama tidak valid (tanpa "/" dan bukan "." atau "..").',
  );
