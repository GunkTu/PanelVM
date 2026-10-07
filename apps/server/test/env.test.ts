import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv } from '../src/config/env.js';

const key = Buffer.alloc(32, 1).toString('base64');
const valid = {
  APP_ORIGIN: 'https://panel.contoh.com',
  DATABASE_PATH: '/tmp/panel.db',
  SECRETS_MASTER_KEY: key,
  SESSION_SECRET: 'x'.repeat(40),
};

describe('loadEnv', () => {
  it('menerima konfigurasi valid dan memberi default', () => {
    const env = loadEnv(valid);
    expect(env.PORT).toBe(3000);
    expect(env.TRUST_PROXY).toBe(false);
  });

  it('gagal cepat bila variabel wajib kosong', () => {
    expect(() => loadEnv({ ...valid, SESSION_SECRET: '' })).toThrow(EnvError);
  });

  it('menolak master key yang bukan 32 byte', () => {
    expect(() => loadEnv({ ...valid, SECRETS_MASTER_KEY: 'pendek' })).toThrow(/32 byte/);
  });

  it('tidak membocorkan nilai secret di pesan error', () => {
    const secret = 'rahasia-pendek';
    try {
      loadEnv({ ...valid, SESSION_SECRET: secret });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });
});
