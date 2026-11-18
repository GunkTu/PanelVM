import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import { buildPlan, COMPOSER_SCRIPT } from '../src/modules/software/install.js';
import { parseDpkg, parseOsRelease, parsePolicy } from '../src/modules/software/status.js';

const ubuntu = parseOsRelease(
  'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\nPRETTY_NAME="Ubuntu 24.04.5 LTS"',
);
const debian = parseOsRelease(
  'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\nVERSION_ID="12"\nVERSION_CODENAME=bookworm',
);
const ctx = { phpVersions: ['8.3', '8.2'], pgVersions: ['16'] };

describe('parser', () => {
  it('os-release', () => {
    expect(ubuntu).toMatchObject({ id: 'ubuntu', codename: 'noble', supported: true });
    expect(debian).toMatchObject({ id: 'debian', versionId: '12', supported: true });
    expect(parseOsRelease('ID=alpine').supported).toBe(false);
  });
  it('dpkg hanya menghitung status ii', () => {
    const m = parseDpkg('nginx\tii \t1.24\nzip\trc \t3.0\nphp8.3-fpm\tii \t8.3.6\n');
    expect([...m.keys()]).toEqual(['nginx', 'php8.3-fpm']);
  });
  it('apt-cache policy', () => {
    const m = parsePolicy(
      'nginx:\n  Installed: (none)\n  Candidate: 1.24.0-2\nmysql-server:\n  Installed: (none)\n  Candidate: (none)\n',
    );
    expect(m.get('nginx')).toBe('1.24.0-2');
    expect(m.get('mysql-server')).toBeNull();
  });
});

describe('buildPlan', () => {
  it('menolak OS yang tidak didukung', () => {
    expect(() => buildPlan({ item: 'nginx' }, parseOsRelease('ID=alpine'), ctx)).toThrow(AppError);
  });

  it('cron, Node.js, Python, Fail2ban: paket tetap dari katalog, layanan diaktifkan bila ada', () => {
    const install = (item: 'cron' | 'nodejs' | 'python' | 'fail2ban') =>
      buildPlan({ item }, ubuntu, ctx).steps.find((s) => s.argv[1] === 'install')!.argv;
    expect(install('cron')).toContain('cron');
    expect(install('nodejs')).toEqual(expect.arrayContaining(['nodejs', 'npm']));
    expect(install('python')).toEqual(
      expect.arrayContaining(['python3', 'python3-venv', 'python3-pip']),
    );
    expect(install('fail2ban')).toContain('fail2ban');
    expect(buildPlan({ item: 'cron' }, ubuntu, ctx).steps.at(-1)!.argv).toEqual([
      'systemctl',
      'enable',
      '--now',
      'cron',
    ]);
  });

  it('PHP: hanya versi yang ditemukan di repositori VM, format ketat', () => {
    for (const v of ['8.3; rm -rf /', '$(id)', '8.9', '8', '', '../../x', "8.3'"]) {
      expect(() => buildPlan({ item: 'php', version: v }, ubuntu, ctx), v).toThrow(AppError);
    }
    const p = buildPlan({ item: 'php', version: '8.2' }, ubuntu, ctx);
    const install = p.steps.find((s) => s.argv[1] === 'install')!;
    expect(install.argv).toContain('php8.2-fpm');
    expect(install.argv).toContain('php8.2-mbstring');
    expect(install.env).toMatchObject({ DEBIAN_FRONTEND: 'noninteractive' });
    expect(p.steps.at(-1)!.argv).toEqual(['systemctl', 'enable', '--now', 'php8.2-fpm']);
  });

  it('ekstensi opsional divalidasi daftar dan ketersediaan', () => {
    expect(() =>
      buildPlan({ item: 'php', version: '8.3', extensions: ['evil; id'] }, ubuntu, ctx),
    ).toThrow(/tidak ada di daftar/);
    expect(() =>
      buildPlan({ item: 'php', version: '8.3', extensions: ['redis'] }, ubuntu, {
        ...ctx,
        phpOptionalAvailable: new Set(),
      }),
    ).toThrow(/tidak tersedia/);
    const p = buildPlan({ item: 'php', version: '8.3', extensions: ['redis'] }, ubuntu, {
      ...ctx,
      phpOptionalAvailable: new Set(['redis']),
    });
    expect(p.steps.find((s) => s.argv[1] === 'install')!.argv).toContain('php8.3-redis');
  });

  it('PostgreSQL hanya versi yang tersedia', () => {
    expect(() => buildPlan({ item: 'postgresql', version: '99' }, ubuntu, ctx)).toThrow(AppError);
    expect(() => buildPlan({ item: 'postgresql', version: '16; id' }, ubuntu, ctx)).toThrow(
      AppError,
    );
    expect(buildPlan({ item: 'postgresql', version: '16' }, ubuntu, ctx).verifyPackages).toEqual([
      'postgresql-16',
    ]);
  });

  it('repositori PHP: Ubuntu pakai PPA, Debian pakai keyring + sources dengan codename tervalidasi', () => {
    const u = buildPlan({ item: 'php-repo' }, ubuntu, ctx);
    expect(u.steps.some((s) => s.argv.join(' ') === 'add-apt-repository -y ppa:ondrej/php')).toBe(
      true,
    );
    const d = buildPlan({ item: 'php-repo' }, debian, ctx);
    const write = d.steps.find((s) => s.argv[0] === 'tee')!;
    expect(write.stdin).toBe(
      'deb [signed-by=/usr/share/keyrings/deb.sury.org-php.gpg] https://packages.sury.org/php/ bookworm main\n',
    );
    expect(() => buildPlan({ item: 'php-repo' }, { ...debian, codename: 'x; id' }, ctx)).toThrow(
      /Codename/,
    );
  });

  it('semua perintah adalah argv tetap; skrip composer statis dan memverifikasi checksum', () => {
    expect(COMPOSER_SCRIPT).toContain('hash_file');
    expect(COMPOSER_SCRIPT).toContain('composer.github.io/installer.sig');
    const p = buildPlan({ item: 'composer' }, debian, ctx);
    expect(p.steps[1]!.argv).toEqual(['sh', '-s']);
  });
});
