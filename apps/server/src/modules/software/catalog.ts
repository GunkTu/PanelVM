/**
 * Katalog software yang boleh dipasang dari panel. SEMUA nama paket berasal dari daftar tetap ini
 * (atau template dengan versi yang divalidasi ketat), tidak pernah dari input bebas pengguna.
 */
export type ItemId =
  | 'base-tools'
  | 'nginx'
  | 'apache'
  | 'php-repo'
  | 'php'
  | 'composer'
  | 'mariadb'
  | 'mysql'
  | 'postgresql'
  | 'redis'
  | 'cron'
  | 'nodejs'
  | 'python'
  | 'fail2ban';

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
    description:
      'Web server untuk situs web di VM ini. Pilih salah satu: Nginx atau Apache tidak bisa terpasang bersamaan.',
    packages: ['nginx'],
    service: 'nginx',
  },
  apache: {
    id: 'apache',
    title: 'Apache',
    description:
      'Web server alternatif untuk situs web di VM ini. Pilih salah satu: Apache atau Nginx tidak bisa terpasang bersamaan.',
    packages: ['apache2'],
    service: 'apache2',
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
  cron: {
    id: 'cron',
    title: 'Cron',
    description:
      'Penjadwal tugas. Dibutuhkan untuk menu Jadwal & Worker (mis. Laravel Scheduler). Ada di sebagian besar VM, tetapi tidak di image minimal.',
    packages: ['cron'],
    service: 'cron',
  },
  nodejs: {
    id: 'nodejs',
    title: 'Node.js + npm',
    description:
      'Runtime JavaScript untuk menu App Node/Python. Versi mengikuti repositori OS (bisa lebih lama dari versi terbaru); bila butuh versi tertentu, pasang manual lewat terminal.',
    packages: ['nodejs', 'npm'],
  },
  python: {
    id: 'python',
    title: 'Python 3 (venv + pip)',
    description:
      'Python 3 dengan virtualenv dan pip untuk Flask, Django, FastAPI di menu App Node/Python.',
    packages: ['python3', 'python3-venv', 'python3-pip'],
  },
  fail2ban: {
    id: 'fail2ban',
    title: 'Fail2ban',
    description:
      'Memblokir sementara IP yang berulang kali gagal login SSH. Dipasang dengan pengaturan bawaan Debian/Ubuntu (SSH dilindungi).',
    packages: ['fail2ban'],
    service: 'fail2ban',
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
