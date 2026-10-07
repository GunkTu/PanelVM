import { describe, expect, it } from 'vitest';
import { sanitizeMeta } from '../src/audit/index.js';
import { SecretBox } from '../src/crypto/secrets.js';
import { fingerprintOf, generateKeyPair } from '../src/ssh/connect.js';

const box = new SecretBox(Buffer.alloc(32, 3));

describe('SecretBox', () => {
  it('enkripsi bolak-balik dan nonce unik', () => {
    const a = box.encrypt('rahasia', 'ctx');
    const b = box.encrypt('rahasia', 'ctx');
    expect(a).not.toBe(b);
    expect(a).not.toContain('rahasia');
    expect(box.decrypt(a, 'ctx')).toBe('rahasia');
  });
  it('menolak context berbeda (AAD) dan data yang dimodifikasi', () => {
    const a = box.encrypt('rahasia', 'vms:1');
    expect(() => box.decrypt(a, 'vms:2')).toThrow();
    const raw = Buffer.from(a.slice(3), 'base64');
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
    expect(() => box.decrypt(`v1:${raw.toString('base64')}`, 'vms:1')).toThrow();
  });
  it('menolak master key dengan panjang salah', () => {
    expect(() => new SecretBox(Buffer.alloc(16))).toThrow();
  });
});

describe('audit sanitize', () => {
  it('membuang kunci sensitif dan memotong string panjang', () => {
    const out = JSON.parse(
      sanitizeMeta({ password: 'x', token: 'y', apiKey: 'z', ok: 'aman', long: 'a'.repeat(500) })!,
    );
    expect(out.password).toBeUndefined();
    expect(out.token).toBeUndefined();
    expect(out.apiKey).toBeUndefined();
    expect(out.ok).toBe('aman');
    expect(out.long.length).toBeLessThan(210);
  });
});

describe('ssh util', () => {
  it('membuat keypair ed25519 dan fingerprint berformat OpenSSH', () => {
    const k = generateKeyPair('test');
    expect(k.publicKey.startsWith('ssh-ed25519 ')).toBe(true);
    expect(k.privateKey).toContain('PRIVATE KEY');
    expect(fingerprintOf(Buffer.from('abc'))).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });
});
