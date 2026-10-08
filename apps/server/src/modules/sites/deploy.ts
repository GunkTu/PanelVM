import type { Step } from '../software/install.js';
import { inDir } from '../../ssh/shell.js';
import { siteRoot, type SiteKind } from './nginx.js';

export const ARTISAN_COMMANDS = {
  migrate: ['migrate', '--force'],
  'migrate:status': ['migrate:status'],
  'db:seed': ['db:seed', '--force'],
  optimize: ['optimize'],
  'optimize:clear': ['optimize:clear'],
  'cache:clear': ['cache:clear'],
  'config:clear': ['config:clear'],
  'storage:link': ['storage:link'],
  'queue:restart': ['queue:restart'],
  'key:generate': ['key:generate', '--force'],
} as const satisfies Record<string, readonly string[]>;
export type ArtisanCommand = keyof typeof ARTISAN_COMMANDS;

/**
 * Pemeriksa koneksi database untuk proyek Laravel (kode PHP statis, dijalankan dengan `php -r` di folder aplikasi).
 * Membaca .env sendiri, jadi tidak bergantung pada vendor/ atau cache konfigurasi. Kode keluar 0 = siap;
 * keluaran hanya memuat host, port, nama database, dan user (tidak pernah password).
 */
export const DB_CHECK_PHP = `
$env = [];
$lines = @file('.env', FILE_IGNORE_NEW_LINES);
if ($lines === false) { fwrite(STDERR, 'Gagal: file .env tidak ditemukan di folder aplikasi.' . PHP_EOL); exit(2); }
foreach ($lines as $line) {
  $line = trim($line);
  if ($line === '' || $line[0] === '#' || strpos($line, '=') === false) continue;
  [$k, $v] = explode('=', $line, 2);
  $k = trim($k); $v = trim($v);
  if (strpos($k, 'export ') === 0) $k = trim(substr($k, 7));
  if ($k === '') continue;
  if ($v !== '' && ($v[0] === '"' || $v[0] === "'")) {
    $q = $v[0]; $end = strrpos($v, $q);
    $v = ($end !== false && $end > 0) ? substr($v, 1, $end - 1) : substr($v, 1);
  } else {
    $h = strpos($v, ' #');
    if ($h !== false) $v = rtrim(substr($v, 0, $h));
  }
  $env[$k] = $v;
}
$g = function ($k, $d = '') use ($env) { return (isset($env[$k]) && $env[$k] !== '') ? $env[$k] : $d; };
$drv = strtolower($g('DB_CONNECTION', 'mysql'));
$pass = $g('DB_PASSWORD');
$fail = function ($msg) use ($pass) {
  if ($pass !== '') $msg = str_replace($pass, '***', $msg);
  fwrite(STDERR, 'Gagal: ' . substr($msg, 0, 400) . PHP_EOL);
  exit(1);
};
if ($drv === 'sqlite') {
  $f = $g('DB_DATABASE', 'database/database.sqlite');
  if ($f === ':memory:') { echo 'DB_CONNECTION=sqlite (memori)' . PHP_EOL; exit(0); }
  if ($f[0] !== '/') $f = getcwd() . '/' . $f;
  echo 'DB_CONNECTION=sqlite file=' . $f . PHP_EOL;
  if (!is_file($f)) $fail('File SQLite tidak ada: ' . $f . '. Buat file kosong itu atau ubah DB_DATABASE.');
  exit(0);
}
if (!in_array($drv, ['mysql', 'mariadb', 'pgsql'], true)) { echo 'DB_CONNECTION=' . $drv . ' (tidak diperiksa otomatis)' . PHP_EOL; exit(0); }
$host = $g('DB_HOST', '127.0.0.1'); $port = $g('DB_PORT', $drv === 'pgsql' ? '5432' : '3306');
$db = $g('DB_DATABASE'); $user = $g('DB_USERNAME', $drv === 'pgsql' ? 'postgres' : 'root');
echo 'DB_CONNECTION=' . $drv . ' host=' . $host . ' port=' . $port . ' database=' . ($db === '' ? '(kosong)' : $db) . ' user=' . $user . PHP_EOL;
if ($db === '') $fail('DB_DATABASE masih kosong di .env.');
$ext = $drv === 'pgsql' ? 'pdo_pgsql' : 'pdo_mysql';
if (!extension_loaded($ext)) $fail('Ekstensi PHP ' . $ext . ' belum terpasang untuk versi PHP ini.');
$dsn = $drv === 'pgsql' ? 'pgsql:host=' . $host . ';port=' . $port . ';dbname=' . $db : 'mysql:host=' . $host . ';port=' . $port . ';dbname=' . $db . ';charset=utf8mb4';
try {
  new PDO($dsn, $user, $pass, [PDO::ATTR_TIMEOUT => 5, PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
  echo 'Koneksi database berhasil.' . PHP_EOL; exit(0);
} catch (Throwable $e) { $fail($e->getMessage()); }
`;

export interface DeployOptions {
  composer: boolean;
  migrate: boolean;
  optimize: boolean;
}

/** Jalankan perintah di folder situs dengan PHP versi tertentu (versi sudah divalidasi). */
export const phpIn = (root: string, version: string, args: string[]): string[] =>
  inDir(root, [`php${version}`, ...args]);

export const composerIn = (root: string, version: string, args: string[]): string[] => [
  'bash',
  '-c',
  'cd "$1" && v="$2" && shift 2 && exec "php$v" "$(command -v composer)" "$@"',
  'bash',
  root,
  version,
  ...args,
];

/**
 * Salin isi source ke folder situs. Pipa tar dengan pipefail agar kegagalan pembuatan arsip terdeteksi.
 * Argumen tambahan hanya opsi --exclude dari daftar tetap di kode.
 */
export const syncDirs = (src: string, dst: string, excludes: string[]): string[] => [
  'bash',
  '-c',
  'set -eo pipefail; src="$1"; dst="$2"; shift 2; tar -C "$src" "$@" -cf - . | tar -C "$dst" -xf -',
  'bash',
  src,
  dst,
  ...excludes.map((e) => `--exclude=${e}`),
];

export interface DeployPlanInput {
  domain: string;
  kind: SiteKind;
  phpVersion: string | null;
  /** Folder berisi source yang sudah siap disalin (setelah ekstrak/clone dan flatten). */
  sourceDir: string;
  stageDir: string;
  isUpdate: boolean;
  envExists: boolean;
  opts: DeployOptions;
  /** Tambahan pengecualian saat menyalin (mis. .git untuk deploy dari Git). */
  extraExcludes?: string[];
}

export function deploySteps(i: DeployPlanInput): Step[] {
  const root = siteRoot(i.domain);
  const laravel = i.kind === 'laravel';
  const v = i.phpVersion;
  // Pembaruan tidak boleh menimpa konfigurasi dan data milik aplikasi.
  const excludes = [
    './.env',
    ...(laravel && i.isUpdate ? ['./storage/app', './storage/logs'] : []),
    ...(i.extraExcludes ?? []),
  ];

  const steps: Step[] = [
    { title: 'Siapkan folder situs', argv: ['mkdir', '-p', '--', root] },
    {
      title: 'Salin source code ke folder situs',
      argv: syncDirs(i.sourceDir, root, excludes),
      timeoutMs: 15 * 60_000,
    },
    {
      title: 'Bersihkan file sementara',
      argv: ['rm', '-rf', '--', i.stageDir],
      tolerateFail: true,
    },
  ];

  if (laravel && v) {
    steps.push({
      title: 'Pastikan folder tulis Laravel ada',
      argv: inDir(root, [
        'mkdir',
        '-p',
        'storage/app/public',
        'storage/framework/cache/data',
        'storage/framework/sessions',
        'storage/framework/views',
        'storage/logs',
        'bootstrap/cache',
      ]),
    });
    if (!i.envExists) {
      steps.push({
        title: 'Buat .env dari .env.example',
        argv: inDir(root, [
          'sh',
          '-c',
          '[ -f .env ] || { [ -f .env.example ] && cp .env.example .env; } || true',
        ]),
      });
    }
    if (i.opts.composer) {
      steps.push({
        title: 'Composer install (tanpa dev, autoload dioptimalkan)',
        argv: [
          'sh',
          '-c',
          'cd "$1" && [ -f composer.json ] || { echo "composer.json tidak ada, dilewati."; exit 0; }; shift; exec "$@"',
          'sh',
          root,
          ...composerIn(root, v, [
            'install',
            '--no-dev',
            '--optimize-autoloader',
            '--no-interaction',
            '--no-progress',
          ]),
        ],
        env: { COMPOSER_ALLOW_SUPERUSER: '1' },
        timeoutMs: 20 * 60_000,
      });
    }
    steps.push(
      {
        title: 'Buat APP_KEY bila belum ada',
        argv: inDir(root, [
          'sh',
          '-c',
          `[ -f artisan ] && [ -f .env ] || { echo "artisan atau .env tidak ada, dilewati."; exit 0; }; grep -q '^APP_KEY=.\\+' .env && { echo "APP_KEY sudah ada."; exit 0; }; exec php${v} artisan key:generate --force`,
        ]),
      },
      {
        title: 'Buat symlink storage',
        argv: phpIn(root, v, ['artisan', 'storage:link']),
        tolerateFail: true,
      },
    );
    if (i.opts.migrate)
      steps.push({
        title: 'Jalankan migrasi database',
        argv: phpIn(root, v, ['artisan', 'migrate', '--force']),
        timeoutMs: 20 * 60_000,
        // Berhenti menunggu pengguna memperbaiki .env alih-alih gagal dengan kesalahan SQL yang membingungkan.
        gate: {
          title: 'Koneksi database dari .env',
          argv: phpIn(root, v, ['-r', DB_CHECK_PHP]),
          timeoutMs: 30_000,
          message: (detail) =>
            `Migrasi ditunda karena aplikasi belum bisa terhubung ke database.
${detail}

Langkah: (1) buka menu Database lalu buat database dan user untuk aplikasi ini, (2) di halaman Situs Web klik Edit .env dan isi DB_CONNECTION, DB_HOST, DB_PORT, DB_DATABASE, DB_USERNAME, DB_PASSWORD, (3) kembali ke sini lalu klik Lanjutkan. Klik Batalkan bila ingin berhenti.`,
          cancelMessage:
            'Dibatalkan sebelum migrasi. Kode sudah ter-deploy; perbaiki .env lalu jalankan migrasi dari tombol Artisan atau deploy ulang.',
        },
      });
    if (i.opts.optimize)
      steps.push({
        title: 'Cache konfigurasi, route, dan view',
        argv: phpIn(root, v, ['artisan', 'optimize']),
        tolerateFail: true,
      });
  }

  steps.push({
    title: 'Atur pemilik file ke www-data',
    argv: ['chown', '-R', 'www-data:www-data', '--', root],
    timeoutMs: 5 * 60_000,
  });
  if (laravel) {
    steps.push({
      title: 'Izinkan tulis di storage dan bootstrap/cache',
      argv: inDir(root, ['chmod', '-R', 'ug+rwX', 'storage', 'bootstrap/cache']),
      tolerateFail: true,
    });
  }
  if (v) {
    // systemd bila ada; VM tanpa systemd (mis. container) memakai sinyal USR2 ke master php-fpm.
    steps.push({
      title: `Muat ulang PHP-FPM ${v}`,
      argv: [
        'sh',
        '-c',
        'systemctl reload "php$1-fpm" 2>/dev/null || kill -USR2 "$(cat "/run/php/php$1-fpm.pid")"',
        'sh',
        v,
      ],
      tolerateFail: true,
    });
  }
  return steps;
}
