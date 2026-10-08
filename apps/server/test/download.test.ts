import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import {
  archiveKindOrThrow,
  DETECT_SCRIPT,
  DOWNLOAD_SCRIPT,
  normalizeDownloadUrl,
} from '../src/modules/sites/download.js';

const ID = '1AbCdEfGhIjKlMnOpQrStUv';
const DRIVE = `https://drive.usercontent.google.com/download?id=${ID}&export=download&confirm=t`;

describe('normalizeDownloadUrl', () => {
  it('Google Drive: semua bentuk link file diubah ke link unduh langsung', () => {
    for (const url of [
      `https://drive.google.com/file/d/${ID}/view?usp=sharing`,
      `https://drive.google.com/file/d/${ID}/view`,
      `https://drive.google.com/open?id=${ID}`,
      `https://drive.google.com/uc?export=download&id=${ID}`,
      `https://drive.usercontent.google.com/download?id=${ID}&export=download`,
    ]) {
      const t = normalizeDownloadUrl(url);
      expect(t.url, url).toBe(DRIVE);
      expect(t.provider).toBe('gdrive');
      expect(t.host).toBe('drive.google.com');
    }
  });

  it('Google Drive: folder, Docs, dan link tanpa ID ditolak dengan langkah berikutnya', () => {
    const folder = () => normalizeDownloadUrl('https://drive.google.com/drive/folders/' + ID);
    expect(folder).toThrow(/folder Google Drive tidak didukung/);
    expect(() =>
      normalizeDownloadUrl('https://docs.google.com/document/d/' + ID + '/edit'),
    ).toThrow(/bukan file arsip/);
    expect(() => normalizeDownloadUrl('https://drive.google.com/open?id=pendek')).toThrow(
      /tidak dikenali/,
    );
    expect(() => normalizeDownloadUrl('https://drive.google.com/')).toThrow(/tidak dikenali/);
  });

  it('Dropbox: dl=0 menjadi dl=1; link lain diteruskan apa adanya', () => {
    const d = normalizeDownloadUrl('https://www.dropbox.com/s/abc123/kode.zip?dl=0');
    expect(d.url).toBe('https://www.dropbox.com/s/abc123/kode.zip?dl=1');
    expect(d.provider).toBe('dropbox');
    const direct = normalizeDownloadUrl('https://contoh.com/rilis/app.tar.gz');
    expect(direct).toEqual({
      url: 'https://contoh.com/rilis/app.tar.gz',
      provider: 'direct',
      host: 'contoh.com',
    });
  });

  it('menolak skema selain https, kredensial, spasi, dan URL terlalu panjang', () => {
    for (const bad of [
      'http://contoh.com/a.zip',
      'ftp://contoh.com/a.zip',
      'file:///etc/passwd',
      'javascript:alert(1)',
      '//contoh.com/a.zip',
      'https://',
      'https://user:sandi@contoh.com/a.zip',
      'https://contoh.com/a b.zip',
      'https://contoh.com/a.zip\nhttps://lain.com',
      'https://-contoh.com/a.zip',
      `https://contoh.com/${'a'.repeat(2100)}`,
      '',
    ]) {
      expect(() => normalizeDownloadUrl(bad), JSON.stringify(bad.slice(0, 40))).toThrow(AppError);
    }
  });
});

describe('archiveKindOrThrow', () => {
  it('menerima zip/gzip/tar dan memberi pesan jelas untuk halaman web atau format tak dikenal', () => {
    expect(archiveKindOrThrow('zip\n', 'direct')).toBe('zip');
    expect(archiveKindOrThrow('gzip', 'direct')).toBe('gzip');
    expect(archiveKindOrThrow('tar', 'gdrive')).toBe('tar');
    expect(() => archiveKindOrThrow('html', 'gdrive')).toThrow(/Siapa saja yang memiliki link/);
    expect(() => archiveKindOrThrow('html', 'direct')).toThrow(/halaman web/);
    expect(() => archiveKindOrThrow('empty', 'direct')).toThrow(/kosong/);
    expect(() => archiveKindOrThrow('unknown', 'direct')).toThrow(/tidak dikenali/);
  });
});

const hasBash =
  spawnSync('bash', ['-c', 'command -v head od tr tar stat'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!hasBash)('skrip unduh dan deteksi (bash sungguhan)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const bash = (script: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync('bash', ['-c', script, 'bash', ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });

  // Path relatif: tar GNU di Windows menganggap "D:/..." sebagai host jarak jauh (di VM Linux path tidak berisi ":").
  const runDetect = (name: string) =>
    spawnSync('sh', ['-c', DETECT_SCRIPT, 'sh', name], {
      encoding: 'utf8',
      cwd: dir,
    }).stdout.trim();

  describe('deteksi jenis arsip dari isi berkas', () => {
    const detect = (name: string, body: Buffer | string) => {
      writeFileSync(join(dir, name), body);
      return runDetect(name);
    };

    it('zip, gzip, tar, html, kosong, dan tak dikenal', () => {
      expect(detect('a.bin', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toBe('zip');
      expect(detect('b.bin', Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]))).toBe('gzip');
      expect(detect('c.bin', '<!DOCTYPE html><html><body>Masuk ke Google</body></html>')).toBe(
        'html',
      );
      expect(detect('d.bin', '')).toBe('empty');
      expect(detect('e.bin', 'bukan arsip apa pun, hanya teks biasa')).toBe('unknown');

      const src = join(dir, 'isi.txt');
      writeFileSync(src, 'halo');
      const tarFile = join(dir, 'f.bin');
      const posix = (p: string) => p.replace(/\\/g, '/');
      const r = spawnSync('bash', [
        '-c',
        'cd "$2" && tar -cf f.bin isi.txt',
        'bash',
        posix(tarFile),
        posix(dir),
      ]);
      expect(r.status).toBe(0);
      expect(runDetect('f.bin')).toBe('tar');
    });
  });

  describe('unduh dengan batas ukuran', () => {
    const shim = join(dir, 'bin');
    mkdirSync(shim, { recursive: true });
    const argvLog = join(dir, 'curl-args.txt');
    // curl tiruan: mencetak FAKE_BYTES karakter ke stdout (atau gagal dengan FAKE_EXIT) dan mencatat argumennya.
    writeFileSync(
      join(shim, 'curl'),
      `#!/bin/sh
printf '%s\\n' "$@" > "${argvLog.replace(/\\/g, '/')}"
[ -n "$FAKE_EXIT" ] && exit "$FAKE_EXIT"
head -c "$FAKE_BYTES" /dev/zero | tr '\\0' 'x'
`,
    );
    chmodSync(join(shim, 'curl'), 0o755);
    const env = (extra: Record<string, string>) => ({
      PATH: `${shim}${delimiter}${process.env.PATH}`,
      ...extra,
    });

    it('berkas di bawah batas: tersimpan utuh dan hanya https yang diizinkan', () => {
      const out = join(dir, 'ok.bin');
      const r = bash(
        DOWNLOAD_SCRIPT,
        ['https://contoh.com/a.zip', out, '1000'],
        env({ FAKE_BYTES: '500' }),
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Unduhan selesai: 500 byte.');
      expect(statSync(out).size).toBe(500);
      const args = readFileSync(argvLog, 'utf8').split('\n');
      expect(args).toContain('--proto');
      expect(args).toContain('=https');
      expect(args).toContain('--proto-redir');
      expect(args.slice(-3)[0]).toBe('--'); // URL setelah "--" sebagai argumen, bukan opsi
      expect(args).toContain('https://contoh.com/a.zip');
    });

    it('berkas melebihi batas: dihentikan (kode 3) dan berkas dihapus', () => {
      const out = join(dir, 'besar.bin');
      const r = bash(
        DOWNLOAD_SCRIPT,
        ['https://contoh.com/a.zip', out, '1000'],
        env({ FAKE_BYTES: '20000' }),
      );
      expect(r.status).toBe(3);
      expect(r.stderr).toMatch(/melebihi batas 1000 byte/);
      expect(existsSync(out)).toBe(false);
    });

    it('curl gagal: kode 4 dengan pesan langkah berikutnya, tanpa berkas sisa', () => {
      const out = join(dir, 'gagal.bin');
      const r = bash(
        DOWNLOAD_SCRIPT,
        ['https://contoh.com/a.zip', out, '1000'],
        env({ FAKE_EXIT: '22' }),
      );
      expect(r.status).toBe(4);
      expect(r.stderr).toMatch(/Unduhan gagal \(kode curl 22\)/);
      expect(existsSync(out)).toBe(false);
    });

    it('URL berisi karakter shell tidak dieksekusi (argumen, bukan interpolasi)', () => {
      const out = join(dir, 'inj.bin');
      const marker = join(dir, 'terinjeksi.txt').replace(/\\/g, '/');
      const url = `https://contoh.com/a.zip?x=$(touch ${marker})&y=\`touch ${marker}\`;touch ${marker}`;
      bash(DOWNLOAD_SCRIPT, [url, out, '1000'], env({ FAKE_BYTES: '10' }));
      expect(existsSync(marker)).toBe(false);
    });
  });
});
