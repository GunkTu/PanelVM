import { AppError } from '../../errors.js';

export type DownloadProvider = 'gdrive' | 'dropbox' | 'direct';

export interface DownloadTarget {
  /** URL yang benar-benar diunduh (sudah dinormalkan untuk Google Drive/Dropbox). */
  url: string;
  provider: DownloadProvider;
  /** Host untuk catatan audit (tanpa path/query yang bisa memuat token). */
  host: string;
}

/** https saja, tanpa kredensial di URL, tanpa spasi. Argumen diteruskan sebagai argv ke curl (bukan lewat shell). */
export const DOWNLOAD_URL_RE =
  /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?(?:\/[^\s]*)?$/;

const DRIVE_ID = /^[A-Za-z0-9_-]{10,100}$/;

const unsupported = (message: string) => new AppError(400, 'download_unsupported', message);

/**
 * Normalkan link berbagi menjadi link unduh langsung. Google Drive: link file (/file/d/ID/view, open?id=, uc?id=)
 * diubah ke drive.usercontent.google.com dengan confirm=t agar file besar tidak berhenti di halaman peringatan
 * "tidak bisa memindai virus". Dropbox: dl=0 diubah ke dl=1.
 */
export function normalizeDownloadUrl(raw: string): DownloadTarget {
  if (raw.length > 2000 || !DOWNLOAD_URL_RE.test(raw)) {
    throw new AppError(
      400,
      'bad_url',
      'URL harus diawali https:// dan tidak boleh memuat kredensial atau spasi. Contoh: https://drive.google.com/file/d/ID/view',
    );
  }
  const u = new URL(raw);
  const host = u.hostname.toLowerCase();

  if (host === 'drive.google.com' || host === 'drive.usercontent.google.com') {
    if (u.pathname.startsWith('/drive/folders/') || u.pathname.startsWith('/drive/u/')) {
      throw unsupported(
        'Link folder Google Drive tidak didukung. Kompres folder menjadi satu file .zip atau .tar.gz, unggah ke Drive, lalu bagikan link file-nya.',
      );
    }
    const fromPath = /^\/file\/d\/([^/]+)/.exec(u.pathname)?.[1];
    const id = fromPath ?? u.searchParams.get('id') ?? '';
    if (!DRIVE_ID.test(id)) {
      throw unsupported(
        'Link Google Drive tidak dikenali. Buka file di Drive, klik Bagikan, atur "Siapa saja yang memiliki link", lalu salin link file-nya.',
      );
    }
    return {
      url: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`,
      provider: 'gdrive',
      host: 'drive.google.com',
    };
  }
  if (host === 'docs.google.com') {
    throw unsupported(
      'Link Google Docs/Sheets/Slides bukan file arsip. Gunakan file .zip atau .tar.gz yang diunggah ke Google Drive.',
    );
  }
  if (host === 'www.dropbox.com' || host === 'dropbox.com') {
    u.searchParams.set('dl', '1');
    return { url: u.toString(), provider: 'dropbox', host: 'dropbox.com' };
  }
  return { url: raw, provider: 'direct', host };
}

/**
 * Skrip unduh (statis, argumen: URL, berkas keluaran, batas byte). Hanya https (termasuk setelah redirect).
 * Memakai pipa ke `head -c` agar ukuran dibatasi walau server tidak mengirim Content-Length; ukuran dicatat
 * tiap 10 detik ke log job. Kode keluar: 0 ok, 3 melebihi batas, 4 unduhan gagal.
 */
export const DOWNLOAD_SCRIPT = `url="$1"; out="$2"; max="$3"
: > "$out"
( while sleep 10; do echo "  ... terunduh $(stat -c %s "$out" 2>/dev/null || echo 0) byte"; done ) &
ticker=$!
set -o pipefail
curl -fsSL --proto '=https' --proto-redir '=https' --max-redirs 8 --connect-timeout 30 --max-time 3600 --retry 2 -A 'Mozilla/5.0 (PanelVM deploy)' -- "$url" | head -c "$((max + 1))" > "$out"
rc=$?
kill "$ticker" 2>/dev/null
size=$(stat -c %s "$out")
if [ "$size" -gt "$max" ]; then echo "Berkas melebihi batas $max byte." >&2; rm -f "$out"; exit 3; fi
if [ "$rc" -ne 0 ]; then echo "Unduhan gagal (kode curl $rc). Periksa link dan pastikan dapat diakses publik." >&2; rm -f "$out"; exit 4; fi
echo "Unduhan selesai: $size byte."
`;

/** Deteksi jenis arsip dari isi berkas (bukan ekstensi): zip, gzip, tar, html (halaman web), atau unknown. */
export const DETECT_SCRIPT = `f="$1"
[ -s "$f" ] || { echo empty; exit 0; }
magic="$(head -c 4 "$f" | od -An -tx1 | tr -d ' \\n')"
case "$magic" in
  504b0304|504b0506) echo zip; exit 0;;
  1f8b*) echo gzip; exit 0;;
esac
if tar -tf "$f" >/dev/null 2>&1; then echo tar; exit 0; fi
if head -c 600 "$f" | grep -qiE '<html|<!doctype'; then echo html; exit 0; fi
echo unknown
`;

export type ArchiveKind = 'zip' | 'gzip' | 'tar';

/** Terjemahkan hasil DETECT_SCRIPT menjadi jenis arsip, atau galat dengan langkah berikutnya. */
export function archiveKindOrThrow(detected: string, provider: DownloadProvider): ArchiveKind {
  const k = detected.trim();
  if (k === 'zip' || k === 'gzip' || k === 'tar') return k;
  if (k === 'html') {
    throw new AppError(
      422,
      'download_html',
      provider === 'gdrive'
        ? 'Google Drive mengembalikan halaman web, bukan file. Pastikan akses file diatur "Siapa saja yang memiliki link" dan formatnya .zip atau .tar.gz, lalu coba lagi.'
        : 'Link itu mengembalikan halaman web, bukan file arsip. Gunakan link unduh langsung ke file .zip atau .tar.gz.',
    );
  }
  if (k === 'empty')
    throw new AppError(422, 'download_empty', 'Berkas yang diunduh kosong. Periksa link-nya.');
  throw new AppError(
    422,
    'download_unknown',
    'Format berkas tidak dikenali. Yang didukung: .zip, .tar.gz, .tgz, dan .tar.',
  );
}
