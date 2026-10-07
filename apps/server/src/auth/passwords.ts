import argon2 from 'argon2';
import { z } from 'zod';

export const MIN_PASSWORD_LENGTH = 12;

export const passwordSchema = z
  .string()
  .min(
    MIN_PASSWORD_LENGTH,
    `Password minimal ${MIN_PASSWORD_LENGTH} karakter. Gunakan frasa yang lebih panjang.`,
  )
  .max(256, 'Password terlalu panjang (maksimal 256 karakter).');

export const hashPassword = (password: string): Promise<string> =>
  argon2.hash(password, { type: argon2.argon2id });

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;
/** Verifikasi palsu agar waktu respons untuk email yang tidak ada setara dengan email yang ada. */
export async function burnPasswordTime(password: string): Promise<void> {
  dummy ??= hashPassword('dummy-password-untuk-menyamakan-waktu');
  await verifyPassword(await dummy, password);
}
