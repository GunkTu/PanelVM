import { chmodSync } from 'node:fs';
import { loadEnv } from '../config/env.js';
import { rotateMasterKey } from '../crypto/rotate.js';
import { SecretBox } from '../crypto/secrets.js';
import { migrate, openDb } from '../db/index.js';

/**
 * Rotasi SECRETS_MASTER_KEY.
 *   SECRETS_MASTER_KEY      = kunci LAMA (yang sedang dipakai di .env)
 *   NEW_SECRETS_MASTER_KEY  = kunci BARU (base64, 32 byte; buat dengan: openssl rand -base64 32)
 * Kunci dibaca dari environment saja (tidak dari argumen) agar tidak terlihat di daftar proses.
 * Hentikan panel sebelum menjalankan, lalu ganti kunci di .env dan jalankan ulang.
 */
const env = loadEnv();
const next = process.env.NEW_SECRETS_MASTER_KEY ?? '';
if (Buffer.from(next, 'base64').length !== 32) {
  console.error('NEW_SECRETS_MASTER_KEY harus diisi: 32 byte base64 (openssl rand -base64 32).');
  process.exit(1);
}
// Bandingkan byte (bukan string): base64 yang sama bisa tertulis dengan atau tanpa padding.
if (Buffer.from(next, 'base64').equals(Buffer.from(env.SECRETS_MASTER_KEY, 'base64'))) {
  console.error('Kunci baru sama dengan kunci lama. Buat kunci baru yang berbeda.');
  process.exit(1);
}

const db = openDb(env.DATABASE_PATH);
migrate(db);
const backup = `${env.DATABASE_PATH}.pre-rotate-${Date.now()}.bak`;
await db.backup(backup);
chmodSync(backup, 0o600);
try {
  const r = rotateMasterKey(
    db,
    SecretBox.fromBase64(env.SECRETS_MASTER_KEY),
    SecretBox.fromBase64(next),
  );
  console.log(
    `Selesai: ${r.vmKeys} kunci SSH VM, ${r.totpSecrets} secret 2FA, dan ${r.proxmoxTokens} token Proxmox dienkripsi ulang.`,
  );
  console.log(
    `Backup sebelum rotasi: ${backup} (berisi data lama; hapus setelah memastikan panel berjalan dengan kunci baru).`,
  );
  console.log(
    'Langkah berikutnya: ganti SECRETS_MASTER_KEY di .env dengan kunci baru, lalu jalankan ulang panel. Semua pengguna harus login ulang.',
  );
} catch {
  console.error(
    'Rotasi dibatalkan dan tidak ada yang berubah. Pastikan SECRETS_MASTER_KEY adalah kunci yang sedang dipakai.',
  );
  process.exitCode = 1;
} finally {
  db.close();
}
