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
