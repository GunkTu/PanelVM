import type { Readable } from 'node:stream';
import type { Client as SshClient, ClientChannel } from 'ssh2';
import { AppError } from '../errors.js';
import { buildCommand, type CommandOptions } from './shell.js';

export interface ExecOptions extends CommandOptions {
  stdin?: string | Buffer | Readable;
  timeoutMs?: number;
  /** Batas byte stdout/stderr yang ditampung di memori. */
  maxBytes?: number;
  /** Bila diisi, stdout dialirkan ke sini dan tidak ditampung. */
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

export interface Spawned {
  channel: ClientChannel;
  done: Promise<ExecResult>;
}

/** Jalankan perintah (argv) di VM. Mengembalikan channel (untuk streaming) dan hasil akhir. */
export function spawnRemote(
  client: SshClient,
  argv: string[],
  opts: ExecOptions = {},
): Promise<Spawned> {
  const command = buildCommand(argv, opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  return new Promise((resolve, reject) => {
    client.exec(command, (err, channel) => {
      if (err) {
        return reject(
          new AppError(
            502,
            'ssh_exec_failed',
            'Panel gagal menjalankan perintah di VM. Periksa koneksi VM lalu coba lagi.',
          ),
        );
      }
      let out = '';
      let errOut = '';
      let truncated = false;
      const take = (acc: string, chunk: Buffer): string => {
        if (acc.length >= maxBytes) {
          truncated = true;
          return acc;
        }
        return acc + chunk.toString('utf8');
      };

      if (opts.onStdout) channel.on('data', opts.onStdout);
      else channel.on('data', (c: Buffer) => (out = take(out, c)));
      if (opts.onStderr) channel.stderr.on('data', opts.onStderr);
      else channel.stderr.on('data', (c: Buffer) => (errOut = take(errOut, c)));

      const done = new Promise<ExecResult>((res, rej) => {
        const timer = setTimeout(() => {
          channel.close();
          rej(
            new AppError(
              504,
              'ssh_exec_timeout',
              `Perintah di VM berjalan lebih dari ${Math.round(timeoutMs / 1000)} detik dan dihentikan. Coba lagi, atau kerjakan lewat terminal bila prosesnya memang lama.`,
            ),
          );
        }, timeoutMs);
        channel.on('close', (code: number | null) => {
          clearTimeout(timer);
          res({ code: code ?? -1, stdout: out, stderr: errOut, truncated });
        });
        channel.on('error', (e: Error) => {
          clearTimeout(timer);
          rej(e);
        });
      });
      // Hindari unhandled rejection bila pemanggil hanya memakai channel.
      done.catch(() => {});

      const stdin = opts.stdin;
      if (stdin === undefined) channel.end();
      else if (typeof stdin === 'string' || Buffer.isBuffer(stdin)) channel.end(stdin);
      else {
        stdin.on('error', () => channel.close());
        stdin.pipe(channel);
      }
      resolve({ channel, done });
    });
  });
}

export async function execRemote(
  client: SshClient,
  argv: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const { done } = await spawnRemote(client, argv, opts);
  return done;
}
