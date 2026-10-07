import { createHash } from 'node:crypto';
import ssh2, { type Client as SshClient } from 'ssh2';
import { AppError } from '../errors.js';

// ssh2 adalah modul CommonJS: named import gagal di Node ESM, jadi pakai default import.
const { Client, utils } = ssh2;

const READY_TIMEOUT_MS = 10_000;

export function generateKeyPair(comment: string): { privateKey: string; publicKey: string } {
  const pair = utils.generateKeyPairSync('ed25519', { comment });
  return { privateKey: pair.private, publicKey: pair.public.trim() };
}

/** Format fingerprint sama dengan OpenSSH: "SHA256:" + base64 tanpa padding. */
export function fingerprintOf(hostKey: Buffer): string {
  return `SHA256:${createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '')}`;
}

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  /** Fingerprint yang sudah disetujui admin. Wajib; koneksi ditolak bila berbeda. */
  expectedFingerprint: string | null;
}

export class HostKeyError extends AppError {
  constructor(
    public readonly presented: string,
    expected: string | null,
  ) {
    super(
      409,
      expected ? 'host_key_changed' : 'host_key_unapproved',
      expected
        ? 'Host key VM berubah dari yang disetujui. Ini bisa berarti VM dibangun ulang atau ada pihak yang menyamar. Periksa VM, lalu setujui ulang fingerprint baru di halaman VM bila memang sah.'
        : 'Host key VM ini belum disetujui. Buka halaman VM, pindai host key, cocokkan fingerprint-nya, lalu setujui.',
    );
  }
}

function describeSshError(
  err: Error & { level?: string },
  t: { host: string; port: number; username: string },
): AppError {
  const msg = err.message ?? '';
  if (err.level === 'client-authentication' || /authentication/i.test(msg)) {
    return new AppError(
      502,
      'ssh_auth_failed',
      `VM menolak kunci SSH panel untuk user "${t.username}". Pasang public key panel di ~/.ssh/authorized_keys user tersebut di VM, lalu coba lagi.`,
    );
  }
  if (/timed out|timeout/i.test(msg)) {
    return new AppError(
      504,
      'ssh_timeout',
      `Panel tidak bisa menjangkau ${t.host}:${t.port} dalam ${READY_TIMEOUT_MS / 1000} detik. Pastikan VM menyala dan firewall mengizinkan SSH dari VM panel.`,
    );
  }
  if (/ECONNREFUSED/.test(msg)) {
    return new AppError(
      502,
      'ssh_refused',
      `${t.host}:${t.port} menolak koneksi. Pastikan layanan SSH berjalan dan port-nya benar.`,
    );
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) {
    return new AppError(
      502,
      'ssh_dns',
      `Alamat ${t.host} tidak ditemukan. Periksa penulisan host atau gunakan IP.`,
    );
  }
  return new AppError(
    502,
    'ssh_failed',
    'Koneksi SSH ke VM gagal. Periksa status VM dan jaringan, lalu coba lagi. Detail teknis ada di log server.',
  );
}

/** Buka koneksi SSH terautentikasi dengan verifikasi host key yang ketat. */
export function openSsh(target: SshTarget, log?: (e: Error) => void): Promise<SshClient> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let presented: string | null = null;
    let settled = false;
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(e);
    };

    client
      .on('ready', () => {
        if (settled) return;
        settled = true;
        resolve(client);
      })
      .on('error', (err: Error & { level?: string }) => {
        if (presented !== null && target.expectedFingerprint !== presented) {
          return fail(new HostKeyError(presented, target.expectedFingerprint));
        }
        log?.(err);
        fail(
          describeSshError(err, {
            host: target.host,
            port: target.port,
            username: target.username,
          }),
        );
      })
      .connect({
        host: target.host,
        port: target.port,
        username: target.username,
        privateKey: target.privateKey,
        readyTimeout: READY_TIMEOUT_MS,
        keepaliveInterval: 15_000,
        hostVerifier: (key: Buffer) => {
          presented = fingerprintOf(key);
          return target.expectedFingerprint !== null && presented === target.expectedFingerprint;
        },
      });
  });
}

/** Ambil fingerprint host key tanpa mengautentikasi (untuk persetujuan admin). */
export function scanHostKey(host: string, port: number, log?: (e: Error) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let found: string | null = null;
    client
      .on('error', (err: Error) => {
        if (found) return resolve(found);
        log?.(err);
        reject(describeSshError(err, { host, port, username: '-' }));
      })
      .on('close', () => {
        if (found) resolve(found);
      })
      .connect({
        host,
        port,
        username: 'panel-scan',
        readyTimeout: READY_TIMEOUT_MS,
        hostVerifier: (key: Buffer) => {
          found = fingerprintOf(key);
          return false; // hentikan handshake; kita hanya butuh fingerprint
        },
      });
  });
}
