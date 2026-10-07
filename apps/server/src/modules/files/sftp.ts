import type { FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2';
import { AppError } from '../../errors.js';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

export type EntryType = 'dir' | 'file' | 'link' | 'other';

export const typeOfMode = (mode: number): EntryType => {
  const t = mode & S_IFMT;
  return t === S_IFDIR ? 'dir' : t === S_IFREG ? 'file' : t === S_IFLNK ? 'link' : 'other';
};

export const modeString = (mode: number): string => (mode & 0o7777).toString(8).padStart(4, '0');

/** Terjemahkan error SFTP ke pesan Indonesia yang menyebut langkah berikutnya. */
export function sftpError(e: unknown, path: string): AppError {
  const err = e as { code?: number; message?: string };
  const msg = err.message ?? '';
  if (err.code === 2 || /no such file/i.test(msg))
    return new AppError(
      404,
      'no_such_file',
      `"${path}" tidak ditemukan di VM. Muat ulang daftar file lalu coba lagi.`,
    );
  if (err.code === 3 || /permission denied/i.test(msg))
    return new AppError(
      403,
      'permission_denied',
      `VM menolak akses ke "${path}" (izin tidak cukup). Pakai user SSH root, atau ubah izin file lewat menu Izin.`,
    );
  if (/failure/i.test(msg) || err.code === 4)
    return new AppError(
      409,
      'sftp_failure',
      `VM gagal memproses "${path}". Pastikan nama belum dipakai dan folder tujuan ada.`,
    );
  return new AppError(
    502,
    'sftp_error',
    'Operasi file di VM gagal. Coba lagi; bila berulang, periksa koneksi VM.',
  );
}

const wrap = <T>(
  path: string,
  fn: (cb: (err: Error | null | undefined, v?: T) => void) => void,
): Promise<T> =>
  new Promise((resolve, reject) => {
    fn((err, v) => (err ? reject(sftpError(err, path)) : resolve(v as T)));
  });

/** Versi promise dari operasi SFTP yang dipakai file manager. */
export class Sftp {
  constructor(readonly raw: SFTPWrapper) {}

  readdir(path: string): Promise<FileEntryWithStats[]> {
    return wrap(path, (cb) => this.raw.readdir(path, cb));
  }
  stat(path: string): Promise<Stats> {
    return wrap(path, (cb) => this.raw.stat(path, cb));
  }
  lstat(path: string): Promise<Stats> {
    return wrap(path, (cb) => this.raw.lstat(path, cb));
  }
  async exists(path: string): Promise<boolean> {
    try {
      await this.lstat(path);
      return true;
    } catch (e) {
      if (e instanceof AppError && e.code === 'no_such_file') return false;
      throw e;
    }
  }
  mkdir(path: string): Promise<void> {
    return wrap<void>(path, (cb) => this.raw.mkdir(path, (e) => cb(e)));
  }
  unlink(path: string): Promise<void> {
    return wrap<void>(path, (cb) => this.raw.unlink(path, (e) => cb(e)));
  }
  rename(from: string, to: string): Promise<void> {
    return wrap<void>(from, (cb) => this.raw.rename(from, to, (e) => cb(e)));
  }
  chmod(path: string, mode: number): Promise<void> {
    return wrap<void>(path, (cb) => this.raw.chmod(path, mode, (e) => cb(e)));
  }
  chown(path: string, uid: number, gid: number): Promise<void> {
    return wrap<void>(path, (cb) => this.raw.chown(path, uid, gid, (e) => cb(e)));
  }
}
