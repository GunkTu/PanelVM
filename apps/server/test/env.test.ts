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

describe('TRUST_PROXY', () => {
  it('menerima true/false dan daftar IP/CIDR proxy tepercaya', () => {
    expect(loadEnv({ ...valid, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
    expect(loadEnv({ ...valid, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    expect(
      loadEnv({ ...valid, TRUST_PROXY: '192.168.1.10, 10.0.0.0/8,::1,fd00::/8' }).TRUST_PROXY,
    ).toEqual(['192.168.1.10', '10.0.0.0/8', '::1', 'fd00::/8']);
  });
  it('menolak nilai yang bukan IP/CIDR', () => {
    for (const v of [
      'yes',
      '1',
      'proxy.local',
      '10.0.0.0/33',
      '10.0.0.1/',
      '300.1.1.1',
      '10.0.0.1,abc',
    ]) {
      expect(() => loadEnv({ ...valid, TRUST_PROXY: v }), v).toThrow(/TRUST_PROXY|IP\/CIDR/);
    }
  });
});
