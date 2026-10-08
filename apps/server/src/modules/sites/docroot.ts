import { DOC_ROOT_RE, defaultDocRootRel, type SiteKind } from './nginx.js';

export interface DirEntry {
  /** Path relatif terhadap folder situs; "." = folder utama. */
  path: string;
  /** Apakah folder itu berisi index.php, index.html, atau index.htm. */
  hasIndex: boolean;
}

/** Folder yang tidak pernah ditawarkan sebagai folder dokumen (dependensi, cache, data aplikasi). */
const SKIP_NAMES = ['vendor', 'node_modules', 'storage', 'cache'];
/** Urutan preferensi bila ada beberapa folder berisi index (nama umum folder publik). */
const PREFERRED = ['public', 'public_html', 'www', 'web', 'htdocs', 'dist', 'build'];

/** Perintah `find` tetap (tanpa shell): daftar folder sedalam 3 tingkat plus file index di dalamnya. */
export function findDirsArgv(root: string): string[] {
  const argv = ['find', root, '-mindepth', '1', '-maxdepth', '3', '('];
  SKIP_NAMES.forEach((n, i) => argv.push(...(i ? ['-o'] : []), '-name', n));
  argv.push('-o', '-name', '.git', ')', '-prune', '-o', '(');
  argv.push('-type', 'd', '-o', '-name', 'index.php', '-o', '-name', 'index.html');
  argv.push('-o', '-name', 'index.htm', ')', '-printf', '%y %P\n');
  return argv;
}

const INDEX_FILE = /(?:^|\/)index\.(?:php|html|htm)$/;

/**
 * Ubah keluaran `find ... -printf '%y %P\n'` menjadi daftar folder. Hanya path yang lolos DOC_ROOT_RE dan tidak
 * mengandung segmen tersembunyi yang dipakai; keluaran dibatasi agar respons tidak membengkak.
 */
export function parseDirListing(stdout: string, limit = 200): DirEntry[] {
  const dirs = new Set<string>();
  const withIndex = new Set<string>();
  for (const line of stdout.split('\n')) {
    const type = line[0];
    const path = line.slice(2).trim();
    if (!path || line[1] !== ' ') continue;
    if (type === 'd') {
      if (DOC_ROOT_RE.test(path) && path !== '.') dirs.add(path);
    } else if ((type === 'f' || type === 'l') && INDEX_FILE.test(path)) {
      const slash = path.lastIndexOf('/');
      withIndex.add(slash < 0 ? '.' : path.slice(0, slash));
    }
  }
  const entries: DirEntry[] = [
    { path: '.', hasIndex: withIndex.has('.') },
    ...[...dirs].map((path) => ({ path, hasIndex: withIndex.has(path) })),
  ];
  return entries
    .sort((a, b) =>
      a.path === '.'
        ? -1
        : b.path === '.'
          ? 1
          : Number(b.hasIndex) - Number(a.hasIndex) || a.path.localeCompare(b.path),
    )
    .slice(0, limit);
}

/**
 * Folder dokumen yang disarankan setelah deploy, atau null bila tidak perlu/tidak bisa ditentukan.
 * Tidak mengubah apa pun bila folder bawaan jenis situs sudah berisi index. Bila bawaan kosong dan hanya ada
 * satu folder berisi index, itu yang dipilih; bila ada beberapa, dipilih yang namanya umum (public, dist, ...).
 */
export function suggestDocRoot(kind: SiteKind, entries: DirEntry[]): string | null {
  const fallback = defaultDocRootRel(kind);
  if (entries.find((e) => e.path === fallback)?.hasIndex) return null;
  const candidates = entries.filter((e) => e.hasIndex).map((e) => e.path);
  if (candidates.length === 1) return candidates[0]!;
  return PREFERRED.find((n) => candidates.includes(n)) ?? null;
}
