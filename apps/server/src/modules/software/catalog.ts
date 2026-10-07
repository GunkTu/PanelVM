/**
 * Katalog software yang boleh dipasang dari panel. SEMUA nama paket berasal dari daftar tetap ini
 * (atau template dengan versi yang divalidasi ketat), tidak pernah dari input bebas pengguna.
 */
export type ItemId =
  | 'base-tools'
  | 'nginx'
  | 'php-repo'
  | 'php'
  | 'composer'
  | 'mariadb'
  | 'mysql'
  | 'postgresql'
  | 'redis';

export interface CatalogItem {
  id: ItemId;
  title: string;
  description: string;
  /** Paket apt untuk item tanpa versi. */
  packages: string[];
  service?: string;
}

export const CATALOG: Record<ItemId, CatalogItem> = {
  'base-tools': {
    id: 'base-tools',
    title: 'Alat dasar',
    description: 'unzip, zip, curl, git, rsync. Dibutuhkan untuk arsip, deploy, dan composer.',
    packages: ['unzip', 'zip', 'curl', 'git', 'ca-certificates', 'rsync'],
  },
  nginx: {
    id: 'nginx',
    title: 'Nginx',
    description: 'Web server untuk situs web di VM ini.',
    packages: ['nginx'],
    service: 'nginx',
  },
  'php-repo': {
    id: 'php-repo',
    title: 'Repositori PHP tambahan (Ondřej Surý)',
    description:
      'Sumber paket pihak ketiga yang banyak dipakai untuk memasang beberapa versi PHP sekaligus di Debian/Ubuntu. Tanpa ini, hanya versi PHP bawaan OS yang tersedia.',
    packages: [],
  },
  php: {
    id: 'php',
    title: 'PHP (FPM)',
    description:
      'PHP-FPM beserta ekstensi umum untuk Laravel dan framework lain. Beberapa versi bisa dipasang berdampingan.',
    packages: [],
  },
  composer: {
    id: 'composer',
    title: 'Composer',
    description:
      'Pengelola dependensi PHP (dipasang dari installer resmi dengan verifikasi checksum).',
    packages: [],
  },
  mariadb: {
    id: 'mariadb',
    title: 'MariaDB',
    description: 'Server database kompatibel MySQL. Versi mengikuti repositori OS.',
    packages: ['mariadb-server', 'mariadb-client'],
    service: 'mariadb',
  },
  mysql: {
    id: 'mysql',
    title: 'MySQL',
    description:
      'Server MySQL (Oracle). Tidak tersedia di semua distro; versi mengikuti repositori OS.',
    packages: ['mysql-server', 'mysql-client'],
    service: 'mysql',
  },
  postgresql: {
    id: 'postgresql',
    title: 'PostgreSQL',
    description:
      'Server PostgreSQL. Versi yang tersedia mengikuti repositori OS. Pengelolaan lewat panel menyusul.',
    packages: [],
    service: 'postgresql',
  },
  redis: {
    id: 'redis',
    title: 'Redis',
    description: 'Cache dan antrean (queue) untuk Laravel.',
    packages: ['redis-server'],
    service: 'redis-server',
  },
};

/** Ekstensi PHP standar yang ada di semua versi PHP umum. */
export const PHP_BASE_EXTENSIONS = [
  'cli',
  'fpm',
  'common',
  'mysql',
  'pgsql',
  'sqlite3',
  'xml',
  'mbstring',
  'curl',
  'zip',
  'gd',
  'bcmath',
  'intl',
  'readline',
] as const;
/** Ekstensi opsional (dicek ketersediaannya sebelum dipasang). */
export const PHP_OPTIONAL_EXTENSIONS = ['redis', 'imagick', 'soap', 'gmp', 'ldap'] as const;

export const PHP_VERSION = /^[5-9]\.\d$/;
export const PG_VERSION = /^\d{1,2}$/;

export const phpPackages = (version: string, optional: readonly string[] = []): string[] => [
  ...PHP_BASE_EXTENSIONS.map((e) => `php${version}-${e}`),
  ...optional.map((e) => `php${version}-${e}`),
];

export const SUPPORTED_OS = new Set(['debian', 'ubuntu']);
