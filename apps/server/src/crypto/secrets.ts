import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const NONCE_LEN = 12;
const TAG_LEN = 16;

/**
 * Enkripsi AES-256-GCM dengan nonce unik per enkripsi. `context` dipakai sebagai AAD
 * sehingga ciphertext satu kolom/baris tidak bisa dipindah ke tempat lain.
 * Subkey enkripsi dan HMAC diturunkan terpisah dari master key (HKDF).
 */
export class SecretBox {
  private readonly encKey: Buffer;
  private readonly macKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error('Master key harus 32 byte');
    this.encKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'panel:enc', 32));
    this.macKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'panel:mac', 32));
  }

  static fromBase64(b64: string): SecretBox {
    return new SecretBox(Buffer.from(b64, 'base64'));
  }

  encrypt(plaintext: string, context: string): string {
    const nonce = randomBytes(NONCE_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, nonce);
    cipher.setAAD(Buffer.from(context));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${VERSION}:${Buffer.concat([nonce, ct, tag]).toString('base64')}`;
  }

  decrypt(payload: string, context: string): string {
    const [version, b64] = payload.split(':');
    if (version !== VERSION || !b64) throw new Error('Format data terenkripsi tidak dikenal');
    const raw = Buffer.from(b64, 'base64');
    if (raw.length < NONCE_LEN + TAG_LEN) throw new Error('Data terenkripsi rusak');
    const nonce = raw.subarray(0, NONCE_LEN);
    const tag = raw.subarray(raw.length - TAG_LEN);
    const ct = raw.subarray(NONCE_LEN, raw.length - TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, nonce);
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  /** HMAC-SHA256 untuk hash token/kode berentropi tinggi (kunci terpisah dari enkripsi). */
  mac(purpose: string, value: string): string {
    return createHmac('sha256', this.macKey).update(`${purpose}:${value}`).digest('hex');
  }
}
