import { randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { hashPassword, verifyPassword } from './passwords.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const RECOVERY_COUNT = 10;
export const RECOVERY_PATTERN = /^[A-Z2-9]{5}-[A-Z2-9]{5}$/;

function randomChunk(n: number): string {
  const bytes = randomBytes(n);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export const normalizeRecovery = (code: string): string => code.trim().toUpperCase();

/**
 * Ganti semua recovery code user. Kode asli hanya dikembalikan sekali di sini.
 * Disimpan sebagai hash argon2id (bukan HMAC kunci panel) supaya rotasi master key tidak merusaknya
 * dan kebocoran DB tidak memudahkan tebak offline.
 */
export async function regenerateRecoveryCodes(db: Db, userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_COUNT }, () => `${randomChunk(5)}-${randomChunk(5)}`);
  const hashes = await Promise.all(codes.map((c) => hashPassword(c)));
  db.transaction(() => {
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
    const ins = db.prepare('INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)');
    hashes.forEach((h) => ins.run(randomUUID(), userId, h));
  })();
  return codes;
}

/** Pakai satu recovery code. Berhasil hanya sekali per kode. */
export async function consumeRecoveryCode(db: Db, userId: string, code: string): Promise<boolean> {
  const normalized = normalizeRecovery(code);
  const rows = db
    .prepare('SELECT id, code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL')
    .all(userId) as { id: string; code_hash: string }[];
  for (const row of rows) {
    if (await verifyPassword(row.code_hash, normalized)) {
      // Penanda atomik: dua permintaan bersamaan dengan kode yang sama tidak boleh sama-sama lolos.
      const res = db
        .prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL')
        .run(Date.now(), row.id);
      return res.changes === 1;
    }
  }
  return false;
}
