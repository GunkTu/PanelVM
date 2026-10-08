import type { Db } from '../db/index.js';
import type { SecretBox } from './secrets.js';

export interface RotateResult {
  vmKeys: number;
  totpSecrets: number;
  proxmoxTokens: number;
}

/**
 * Enkripsi ulang semua secret dengan master key baru dalam SATU transaksi (gagal = tidak ada yang berubah).
 * Dekripsi memakai AAD yang sama dengan saat enkripsi, jadi data yang rusak/salah kunci menghentikan proses.
 * Sesi dan perangkat dikenal dibuang karena HMAC-nya diturunkan dari master key lama.
 * Recovery code memakai argon2 sehingga tidak terpengaruh.
 */
export function rotateMasterKey(db: Db, oldBox: SecretBox, newBox: SecretBox): RotateResult {
  return db.transaction(() => {
    let vmKeys = 0;
    for (const r of db.prepare('SELECT id, ssh_private_key_enc AS enc FROM vms').all() as {
      id: string;
      enc: string;
    }[]) {
      const ctx = `vms.ssh_private_key:${r.id}`;
      db.prepare('UPDATE vms SET ssh_private_key_enc = ? WHERE id = ?').run(
        newBox.encrypt(oldBox.decrypt(r.enc, ctx), ctx),
        r.id,
      );
      vmKeys += 1;
    }
    let totpSecrets = 0;
    for (const r of db
      .prepare('SELECT id, totp_secret_enc AS enc FROM users WHERE totp_secret_enc IS NOT NULL')
      .all() as { id: string; enc: string }[]) {
      const ctx = `users.totp:${r.id}`;
      db.prepare('UPDATE users SET totp_secret_enc = ? WHERE id = ?').run(
        newBox.encrypt(oldBox.decrypt(r.enc, ctx), ctx),
        r.id,
      );
      totpSecrets += 1;
    }
    let proxmoxTokens = 0;
    for (const r of db
      .prepare('SELECT id, token_secret_enc AS enc FROM proxmox_connections')
      .all() as { id: string; enc: string }[]) {
      const ctx = `proxmox.token:${r.id}`;
      db.prepare('UPDATE proxmox_connections SET token_secret_enc = ? WHERE id = ?').run(
        newBox.encrypt(oldBox.decrypt(r.enc, ctx), ctx),
        r.id,
      );
      proxmoxTokens += 1;
    }
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM known_devices').run();
    return { vmKeys, totpSecrets, proxmoxTokens };
  })();
}
