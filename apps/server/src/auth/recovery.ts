import { randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { SecretBox } from '../crypto/secrets.js';

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

/** Ganti semua recovery code user. Kode asli hanya dikembalikan sekali di sini. */
export function regenerateRecoveryCodes(db: Db, box: SecretBox, userId: string): string[] {
  const codes = Array.from({ length: RECOVERY_COUNT }, () => `${randomChunk(5)}-${randomChunk(5)}`);
  db.transaction(() => {
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
    const ins = db.prepare('INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)');
    for (const c of codes) ins.run(randomUUID(), userId, box.mac('recovery', c));
  })();
  return codes;
}

/** Pakai satu recovery code. Berhasil hanya sekali per kode. */
export function consumeRecoveryCode(db: Db, box: SecretBox, userId: string, code: string): boolean {
  const hash = box.mac('recovery', normalizeRecovery(code));
  const res = db
    .prepare(
      'UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
    )
    .run(Date.now(), userId, hash);
  return res.changes === 1;
}
