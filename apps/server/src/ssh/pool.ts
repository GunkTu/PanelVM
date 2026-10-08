import type { Client as SshClient, ClientChannel, SFTPWrapper } from 'ssh2';
import { AppError } from '../errors.js';
import { openSsh, type SshTarget } from './connect.js';

const IDLE_MS = 60_000;
const MAX_CONCURRENT_PER_VM = 8;
/** Tunnel port-forward (preview) dihitung terpisah dari channel biasa agar tidak mengganggu terminal/file manager. */
export const MAX_TUNNELS_PER_VM = 64;

/** Kode CHANNEL_OPEN_FAILURE (RFC 4254 §5.1) yang dikirim sshd saat port-forward gagal. ssh2 menaruhnya di err.reason (angka). */
const OPEN_FAILURE_PROHIBITED = 1;
const OPEN_FAILURE_CONNECT_FAILED = 2;

export type ForwardFailure = 'refused' | 'prohibited' | 'other';

/** 'refused' = tidak ada aplikasi di port itu; 'prohibited' = sshd melarang forwarding; selain itu 'other'. */
export function classifyForwardError(err: unknown): ForwardFailure {
  const reason = (err as { reason?: unknown } | null)?.reason;
  if (reason === OPEN_FAILURE_CONNECT_FAILED) return 'refused';
  if (reason === OPEN_FAILURE_PROHIBITED) return 'prohibited';
  return 'other';
}

interface Entry {
  signature: string;
  client: SshClient;
  sftp?: Promise<SFTPWrapper>;
  refs: number;
  /** Jumlah tunnel port-forward yang sedang terbuka; koneksi tidak ditutup selama > 0. */
  tunnels: number;
  idle?: NodeJS.Timeout;
  waiters: (() => void)[];
}

export interface Lease {
  client: SshClient;
  sftp(): Promise<SFTPWrapper>;
  release(): void;
}

/**
 * Pool koneksi SSH per VM. Koneksi dipakai bersama oleh file manager, database manager, dan installer
 * (banyak channel dalam satu koneksi), ditutup otomatis saat idle, dan dibuang saat konfigurasi VM berubah.
 */
export class SshPool {
  private readonly entries = new Map<string, Entry>();
  private readonly connecting = new Map<string, Promise<Entry>>();

  constructor(private readonly onStatus?: (vmId: string, online: boolean) => void) {}

  private signature(t: SshTarget): string {
    return `${t.host}|${t.port}|${t.username}|${t.expectedFingerprint ?? ''}`;
  }

  private drop(vmId: string, entry: Entry): void {
    if (this.entries.get(vmId) === entry) this.entries.delete(vmId);
    if (entry.idle) clearTimeout(entry.idle);
    entry.client.end();
  }

  private async connect(vmId: string, target: SshTarget, log?: (e: Error) => void): Promise<Entry> {
    try {
      const client = await openSsh(target, log);
      const entry: Entry = {
        signature: this.signature(target),
        client,
        refs: 0,
        tunnels: 0,
        waiters: [],
      };
      client.on('close', () => this.drop(vmId, entry));
      client.on('error', () => this.drop(vmId, entry));
      this.entries.set(vmId, entry);
      this.onStatus?.(vmId, true);
      return entry;
    } catch (e) {
      this.onStatus?.(vmId, false);
      throw e;
    }
  }

  async acquire(vmId: string, target: SshTarget, log?: (e: Error) => void): Promise<Lease> {
    let entry = this.entries.get(vmId);
    if (entry && entry.signature !== this.signature(target)) {
      this.drop(vmId, entry);
      entry = undefined;
    }
    if (!entry) {
      let p = this.connecting.get(vmId);
      if (!p) {
        p = this.connect(vmId, target, log).finally(() => this.connecting.delete(vmId));
        this.connecting.set(vmId, p);
      }
      entry = await p;
    }
    const e = entry;
    if (e.idle) clearTimeout(e.idle);
    while (e.refs >= MAX_CONCURRENT_PER_VM) await new Promise<void>((r) => e.waiters.push(r));
    e.refs += 1;

    let released = false;
    return {
      client: e.client,
      sftp: () => {
        e.sftp ??= new Promise<SFTPWrapper>((resolve, reject) => {
          e.client.sftp((err, s) =>
            err
              ? reject(
                  new AppError(
                    502,
                    'sftp_failed',
                    'VM tidak menyediakan layanan SFTP. Pastikan sshd di VM mengaktifkan subsystem sftp.',
                  ),
                )
              : resolve(s),
          );
        });
        e.sftp.catch(() => {
          e.sftp = undefined;
        });
        return e.sftp;
      },
      release: () => {
        if (released) return;
        released = true;
        e.refs -= 1;
        e.waiters.shift()?.();
        if (e.refs === 0 && e.tunnels === 0) e.idle = setTimeout(() => this.drop(vmId, e), IDLE_MS);
      },
    };
  }

  /**
   * Buka channel direct-tcpip ke 127.0.0.1:dstPort DI DALAM VM (seperti `ssh -L`). Tujuan selalu loopback VM itu
   * sendiri, tidak pernah alamat lain. Error asli ssh2 diteruskan (field `reason` membedakan "port tidak
   * mendengarkan" dari "forwarding dilarang sshd").
   */
  async forward(
    vmId: string,
    target: SshTarget,
    dstPort: number,
    log?: (e: Error) => void,
  ): Promise<ClientChannel> {
    const known = this.entries.get(vmId);
    if (known && known.tunnels >= MAX_TUNNELS_PER_VM) {
      throw new AppError(
        503,
        'tunnel_limit',
        'Terlalu banyak koneksi preview yang terbuka ke VM ini. Tutup tab preview yang tidak dipakai lalu coba lagi.',
      );
    }
    const lease = await this.acquire(vmId, target, log);
    const entry = this.entries.get(vmId);
    if (!entry) {
      lease.release();
      throw new AppError(502, 'ssh_failed', 'Koneksi SSH ke VM terputus. Coba lagi.');
    }
    entry.tunnels += 1;
    lease.release();
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      entry.tunnels -= 1;
      if (entry.refs === 0 && entry.tunnels === 0 && this.entries.get(vmId) === entry)
        entry.idle = setTimeout(() => this.drop(vmId, entry), IDLE_MS);
    };
    try {
      const channel = await new Promise<ClientChannel>((resolve, reject) =>
        entry.client.forwardOut('127.0.0.1', 0, '127.0.0.1', dstPort, (err, s) =>
          err ? reject(err) : resolve(s),
        ),
      );
      channel.once('close', end);
      return channel;
    } catch (e) {
      end();
      throw e;
    }
  }

  /** Buang koneksi VM (konfigurasi berubah, host key disetujui ulang, VM dihapus). */
  invalidate(vmId: string): void {
    const e = this.entries.get(vmId);
    if (e) this.drop(vmId, e);
  }

  closeAll(): void {
    for (const [id, e] of [...this.entries]) this.drop(id, e);
  }
}
