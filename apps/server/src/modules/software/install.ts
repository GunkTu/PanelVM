import type { Client as SshClient } from 'ssh2';
import { AppError } from '../../errors.js';
import { execRemote, type ExecOptions } from '../../ssh/exec.js';
import {
  CATALOG,
  PHP_OPTIONAL_EXTENSIONS,
  PHP_VERSION,
  PG_VERSION,
  phpPackages,
  type ItemId,
} from './catalog.js';
import type { JobControl } from '../jobs/service.js';
import type { OsInfo } from './status.js';

export interface Step {
  title: string;
  argv: string[];
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  /** Bila gagal hanya dicatat sebagai peringatan (mis. systemctl di VM tanpa systemd). */
  tolerateFail?: boolean;
  /** Jangan cetak perintah lengkap di log (mis. skrip panjang atau URL). */
  hideCommand?: boolean;
  /** Pemeriksaan prasyarat sebelum langkah ini; bila belum terpenuhi, job berhenti menunggu pengguna. */
  gate?: Gate;
}

export interface Gate {
  title: string;
  /** Perintah pemeriksa: kode keluar 0 = prasyarat terpenuhi. Keluarannya ikut ke pesan untuk pengguna. */
  argv: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Pesan tindakan untuk pengguna (Bahasa Indonesia: apa yang terjadi + langkah berikutnya). */
  message: (detail: string) => string;
  /** Pesan galat bila pengguna membatalkan. */
  cancelMessage: string;
}

export interface InstallRequest {
  item: ItemId;
  version?: string;
  extensions?: string[];
}

const APT_ENV = {
  DEBIAN_FRONTEND: 'noninteractive',
  NEEDRESTART_MODE: 'a',
  APT_LISTCHANGES_FRONTEND: 'none',
};
const APT_TIMEOUT = 30 * 60_000;

const apt = (title: string, args: string[]): Step => ({
  title,
  argv: ['apt-get', ...args],
  env: APT_ENV,
  timeoutMs: APT_TIMEOUT,
});
export const aptUpdate = (): Step =>
  apt('Perbarui daftar paket', ['update', '-q', '-o', 'Dpkg::Progress-Fancy=0']);
export const aptInstall = (title: string, pkgs: string[]): Step =>
  apt(title, [
    'install',
    '-y',
    '-q',
    '-o',
    'Dpkg::Progress-Fancy=0',
    '-o',
    'Dpkg::Options::=--force-confold',
    ...pkgs,
  ]);
const enableService = (service: string): Step => ({
  title: `Aktifkan layanan ${service}`,
  argv: ['systemctl', 'enable', '--now', service],
  tolerateFail: true,
});

/** Skrip statis installer Composer resmi dengan verifikasi checksum SHA-384 (tanpa interpolasi). */
export const COMPOSER_SCRIPT = `set -e
cd /tmp
EXPECTED="$(curl -fsSL https://composer.github.io/installer.sig)"
curl -fsSL -o composer-setup.php https://getcomposer.org/installer
ACTUAL="$(php -r "echo hash_file('sha384', 'composer-setup.php');")"
if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "Checksum installer Composer tidak cocok, dibatalkan." >&2
  rm -f composer-setup.php
  exit 1
fi
php composer-setup.php --quiet --install-dir=/usr/local/bin --filename=composer
rm -f composer-setup.php
composer --version
`;

/** Paket yang harus ada setelah langkah selesai (diperiksa ulang lewat dpkg). */
export interface Plan {
  steps: Step[];
  verifyPackages: string[];
}

export function buildPlan(
  req: InstallRequest,
  os: OsInfo,
  ctx: { phpVersions: string[]; pgVersions: string[]; phpOptionalAvailable?: Set<string> },
): Plan {
  if (!os.supported) {
    throw new AppError(
      400,
      'os_unsupported',
      `OS VM ini (${os.pretty || 'tidak dikenal'}) belum didukung installer panel. Yang didukung: Debian dan Ubuntu.`,
    );
  }
  switch (req.item) {
    case 'base-tools':
      return {
        steps: [aptUpdate(), aptInstall('Pasang alat dasar', CATALOG['base-tools'].packages)],
        verifyPackages: ['unzip', 'zip', 'curl', 'git', 'rsync'],
      };

    case 'nginx':
      return {
        steps: [aptUpdate(), aptInstall('Pasang Nginx', ['nginx']), enableService('nginx')],
        verifyPackages: ['nginx'],
      };

    case 'apache':
      return {
        steps: [aptUpdate(), aptInstall('Pasang Apache', ['apache2']), enableService('apache2')],
        verifyPackages: ['apache2'],
      };

    case 'redis':
      return {
        steps: [
          aptUpdate(),
          aptInstall('Pasang Redis', ['redis-server']),
          enableService('redis-server'),
        ],
        verifyPackages: ['redis-server'],
      };

    case 'mariadb':
      return {
        steps: [
          aptUpdate(),
          aptInstall('Pasang MariaDB', CATALOG.mariadb.packages),
          enableService('mariadb'),
        ],
        verifyPackages: ['mariadb-server'],
      };

    case 'mysql':
      return {
        steps: [
          aptUpdate(),
          aptInstall('Pasang MySQL', CATALOG.mysql.packages),
          enableService('mysql'),
        ],
        verifyPackages: ['mysql-server'],
      };

    case 'postgresql': {
      if (!req.version || !PG_VERSION.test(req.version) || !ctx.pgVersions.includes(req.version)) {
        throw new AppError(
          400,
          'pg_version',
          `Versi PostgreSQL tidak tersedia di repositori VM ini. Pilih salah satu: ${ctx.pgVersions.join(', ') || '(tidak ada)'}.`,
        );
      }
      return {
        steps: [
          aptUpdate(),
          aptInstall(`Pasang PostgreSQL ${req.version}`, [`postgresql-${req.version}`]),
          enableService('postgresql'),
        ],
        verifyPackages: [`postgresql-${req.version}`],
      };
    }

    case 'php': {
      const v = req.version ?? '';
      if (!PHP_VERSION.test(v) || !ctx.phpVersions.includes(v)) {
        throw new AppError(
          400,
          'php_version',
          `Versi PHP ${v || '(kosong)'} tidak tersedia di repositori VM ini. Tersedia: ${ctx.phpVersions.join(', ') || '(tidak ada)'}. Untuk versi lain, aktifkan repositori PHP tambahan dulu.`,
        );
      }
      const extras = [...new Set(req.extensions ?? [])];
      for (const e of extras) {
        if (!(PHP_OPTIONAL_EXTENSIONS as readonly string[]).includes(e))
          throw new AppError(400, 'php_ext', `Ekstensi "${e}" tidak ada di daftar yang didukung.`);
        if (ctx.phpOptionalAvailable && !ctx.phpOptionalAvailable.has(e))
          throw new AppError(
            400,
            'php_ext_missing',
            `Ekstensi php${v}-${e} tidak tersedia di repositori VM ini. Hapus dari pilihan atau aktifkan repositori PHP tambahan.`,
          );
      }
      const pkgs = phpPackages(v, extras);
      return {
        steps: [
          aptUpdate(),
          aptInstall(`Pasang PHP ${v} dan ekstensi`, pkgs),
          enableService(`php${v}-fpm`),
        ],
        verifyPackages: [`php${v}-fpm`, `php${v}-cli`],
      };
    }

    case 'composer':
      return {
        steps: [
          {
            title: 'Periksa PHP CLI',
            argv: [
              'sh',
              '-c',
              'command -v php >/dev/null 2>&1 || { echo "PHP belum terpasang. Pasang PHP dulu." >&2; exit 1; }; command -v curl >/dev/null 2>&1 || { echo "curl belum terpasang. Pasang Alat dasar dulu." >&2; exit 1; }',
            ],
          },
          {
            title: 'Pasang Composer (installer resmi + verifikasi checksum)',
            argv: ['sh', '-s'],
            stdin: COMPOSER_SCRIPT,
            timeoutMs: 5 * 60_000,
          },
        ],
        verifyPackages: [],
      };

    case 'php-repo': {
      if (os.id === 'ubuntu') {
        return {
          steps: [
            aptUpdate(),
            aptInstall('Pasang software-properties-common', [
              'software-properties-common',
              'ca-certificates',
            ]),
            {
              title: 'Tambahkan PPA ondrej/php',
              argv: ['add-apt-repository', '-y', 'ppa:ondrej/php'],
              env: APT_ENV,
              timeoutMs: 5 * 60_000,
            },
            aptUpdate(),
          ],
          verifyPackages: [],
        };
      }
      if (!/^[a-z]+$/.test(os.codename))
        throw new AppError(
          400,
          'codename',
          'Codename rilis Debian VM tidak terdeteksi, jadi repositori PHP tidak bisa ditambahkan otomatis.',
        );
      const list = '/etc/apt/sources.list.d/php.list';
      const keyring = '/usr/share/keyrings/deb.sury.org-php.gpg';
      return {
        steps: [
          aptUpdate(),
          aptInstall('Pasang prasyarat', ['lsb-release', 'ca-certificates', 'curl']),
          {
            title: 'Unduh paket keyring repositori',
            argv: [
              'curl',
              '-fsSL',
              '-o',
              '/tmp/debsuryorg-archive-keyring.deb',
              'https://packages.sury.org/debsuryorg-archive-keyring.deb',
            ],
            timeoutMs: 120_000,
          },
          { title: 'Pasang keyring', argv: ['dpkg', '-i', '/tmp/debsuryorg-archive-keyring.deb'] },
          { title: 'Periksa keyring terpasang', argv: ['test', '-f', keyring] },
          {
            title: 'Tulis daftar sumber paket',
            argv: ['tee', list],
            stdin: `deb [signed-by=${keyring}] https://packages.sury.org/php/ ${os.codename} main\n`,
          },
          aptUpdate(),
        ],
        verifyPackages: [],
      };
    }
  }
}

export interface RunLog {
  (text: string): void;
}

/** Ulangi pemeriksaan sampai terpenuhi; tiap kegagalan menghentikan job menunggu pengguna (Lanjutkan/Batalkan). */
async function passGate(
  ssh: SshClient,
  opts: Pick<ExecOptions, 'sudo'>,
  gate: Gate,
  log: RunLog,
  ctl?: JobControl,
): Promise<void> {
  for (;;) {
    log(`\n[Periksa] ${gate.title}\n`);
    const r = await execRemote(ssh, gate.argv, {
      ...opts,
      env: gate.env,
      timeoutMs: gate.timeoutMs ?? 60_000,
    });
    if (r.code === 0) {
      log(`${r.stdout.trim()}\nPemeriksaan lolos.\n`);
      return;
    }
    const detail = `${r.stdout}${r.stderr}`.trim().slice(0, 800);
    log(`${detail}\n`);
    if (!ctl) {
      throw new AppError(422, 'gate_failed', gate.message(detail));
    }
    const outcome = await ctl.waitForUser(gate.message(detail));
    if (outcome === 'cancel') throw new AppError(409, 'job_cancelled', gate.cancelMessage);
    log('\nMelanjutkan: memeriksa ulang...\n');
  }
}

export async function runSteps(
  ssh: SshClient,
  opts: Pick<ExecOptions, 'sudo'>,
  steps: Step[],
  log: RunLog,
  ctl?: JobControl,
): Promise<void> {
  for (const [i, st] of steps.entries()) {
    if (st.gate) await passGate(ssh, opts, st.gate, log, ctl);
    log(
      `\n[${i + 1}/${steps.length}] ${st.title}\n${st.hideCommand ? '' : `$ ${st.argv.join(' ')}\n`}`,
    );
    const r = await execRemote(ssh, st.argv, {
      ...opts,
      env: st.env,
      stdin: st.stdin,
      timeoutMs: st.timeoutMs ?? 120_000,
      onStdout: (c) => log(c.toString('utf8')),
      onStderr: (c) => log(c.toString('utf8')),
    });
    if (r.code !== 0) {
      if (st.tolerateFail) {
        log(
          `[peringatan] langkah ini gagal (kode ${r.code}) tetapi proses dilanjutkan. Periksa layanan secara manual bila perlu.\n`,
        );
        continue;
      }
      throw new AppError(
        422,
        'step_failed',
        `Langkah "${st.title}" gagal (kode ${r.code}). Lihat log di atas untuk penyebabnya.`,
      );
    }
  }
}
