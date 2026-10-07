import { mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { consumeRecoveryCode, regenerateRecoveryCodes } from '../src/auth/recovery.js';
import { rotateMasterKey } from '../src/crypto/rotate.js';
import { SecretBox } from '../src/crypto/secrets.js';
import { backupDb } from '../src/db/backup.js';
import { migrate, openDb } from '../src/db/index.js';
import { makeApp, ORIGIN, seedUser } from './helpers.js';

const work = mkdtempSync(join(tmpdir(), 'panel-hard-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('guard sebelum parsing body', () => {
  it('permintaan tanpa sesi ditolak 401 walau body-nya rusak (body tidak diproses)', async () => {
    const { app } = await makeApp();
    for (const url of [
      '/api/vms',
      '/api/users',
      '/api/vms/11111111-1111-4111-8111-111111111111/databases',
      '/api/auth/password',
    ]) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        payload: '{bukan json',
      });
      expect(res.statusCode, url).toBe(401);
    }
    await app.close();
  });
});

describe('recovery code', () => {
  it('hanya satu dari dua permintaan bersamaan yang berhasil, dan hash bukan HMAC kunci panel', async () => {
    const built = await makeApp();
    const u = await seedUser(built, 'rc@contoh.com', 'client', false);
    const codes = await regenerateRecoveryCodes(built.ctx.db, u.row.id);
    const stored = (
      built.ctx.db.prepare('SELECT code_hash FROM recovery_codes').all() as { code_hash: string }[]
    ).map((r) => r.code_hash);
    expect(stored.every((h) => h.startsWith('$argon2id$'))).toBe(true);
    const results = await Promise.all([
      consumeRecoveryCode(built.ctx.db, u.row.id, codes[0]!),
      consumeRecoveryCode(built.ctx.db, u.row.id, codes[0]!),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await consumeRecoveryCode(built.ctx.db, u.row.id, 'AAAAA-BBBBB')).toBe(false);
    expect(await consumeRecoveryCode(built.ctx.db, u.row.id, codes[1]!.toLowerCase())).toBe(true); // tidak peka huruf besar/kecil
    await built.app.close();
  });
});

describe('rotasi master key', () => {
  const oldBox = new SecretBox(Buffer.alloc(32, 1));
  const newBox = new SecretBox(Buffer.alloc(32, 2));
  const mkdb = () => {
    const db = openDb(':memory:');
    migrate(db);
    return db;
  };
  const addVm = (db: ReturnType<typeof mkdb>, id: string, secret: string, box = oldBox) =>
    db
      .prepare(
        "INSERT INTO vms (id, name, host, ssh_user, ssh_private_key_enc, ssh_public_key, created_at) VALUES (?, ?, 'h', 'root', ?, 'pub', 1)",
      )
      .run(id, `vm-${id}`, box.encrypt(secret, `vms.ssh_private_key:${id}`));

  it('mengenkripsi ulang kunci SSH dan secret 2FA, membuang sesi', () => {
    const db = mkdb();
    addVm(db, 'a', 'KUNCI-A');
    db.prepare(
      "INSERT INTO users (id, email, password_hash, role, totp_secret_enc, totp_enabled, created_at) VALUES ('u1', 'x@y.zz', 'h', 'client', ?, 1, 1)",
    ).run(oldBox.encrypt('TOTP', 'users.totp:u1'));
    db.prepare(
      "INSERT INTO sessions (id, user_id, token_hash, stage, created_at, last_seen_at, expires_at) VALUES ('s', 'u1', 't', 'active', 1, 1, 9)",
    ).run();
    expect(rotateMasterKey(db, oldBox, newBox)).toEqual({ vmKeys: 1, totpSecrets: 1 });
    const vm = db.prepare('SELECT ssh_private_key_enc AS e FROM vms').get() as { e: string };
    expect(newBox.decrypt(vm.e, 'vms.ssh_private_key:a')).toBe('KUNCI-A');
    expect(() => oldBox.decrypt(vm.e, 'vms.ssh_private_key:a')).toThrow();
    const u = db.prepare('SELECT totp_secret_enc AS e FROM users').get() as { e: string };
    expect(newBox.decrypt(u.e, 'users.totp:u1')).toBe('TOTP');
    expect((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(0);
  });

  it('atomik: satu data yang tidak bisa didekripsi membatalkan seluruh rotasi', () => {
    const db = mkdb();
    addVm(db, 'a', 'KUNCI-A');
    addVm(db, 'b', 'KUNCI-B', newBox); // sudah dienkripsi kunci lain -> gagal didekripsi dengan oldBox
    const before = db.prepare('SELECT id, ssh_private_key_enc FROM vms ORDER BY id').all();
    expect(() => rotateMasterKey(db, oldBox, newBox)).toThrow();
    expect(db.prepare('SELECT id, ssh_private_key_enc FROM vms ORDER BY id').all()).toEqual(before);
  });
});

describe('backup DB', () => {
  it('membuat cadangan konsisten berizin 0600 dan menyisakan N terbaru', async () => {
    const db = openDb(join(work, 'panel.db'));
    migrate(db);
    db.prepare("INSERT INTO audit_logs (ts, action, result) VALUES (1, 'x', 'ok')").run();
    const dir = join(work, 'backups');
    let last = '';
    for (let i = 0; i < 4; i++) last = await backupDb(db, dir, 2, new Date(2026, 0, 1, 0, 0, i));
    expect(readdirSync(dir)).toHaveLength(2);
    expect(statSync(last).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const copy = new Database(last, { readonly: true });
    expect((copy.prepare('SELECT COUNT(*) AS n FROM audit_logs').get() as { n: number }).n).toBe(1);
    copy.close();
    expect(statSync(join(work, 'panel.db')).mode & 0o777).toBe(0o600); // file DB utama juga 0600
    db.close();
  });
});
