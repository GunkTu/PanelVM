import { describe, expect, it, vi } from 'vitest';
import { apacheConf } from '../src/modules/sites/apache.js';
import { findDirsArgv, parseDirListing, suggestDocRoot } from '../src/modules/sites/docroot.js';
import { DOC_ROOT_RE, defaultDocRootRel, docRoot, nginxConf } from '../src/modules/sites/nginx.js';
import { WEB_SERVERS } from '../src/modules/sites/webserver.js';
import { buildPlan } from '../src/modules/software/install.js';
import { collectStatus, parseOsRelease } from '../src/modules/software/status.js';
import { execRemote } from '../src/ssh/exec.js';

vi.mock('../src/ssh/exec.js', () => ({ execRemote: vi.fn() }));

describe('apacheConf', () => {
  it('Laravel: DocumentRoot ke public, PHP lewat FPM, .htaccess diizinkan', () => {
    const c = apacheConf('blog.contoh.com', 'laravel', '8.3');
    expect(c).toContain('ServerName blog.contoh.com');
    expect(c).toContain('DocumentRoot /var/www/blog.contoh.com/public');
    expect(c).toContain('<Directory /var/www/blog.contoh.com>');
    expect(c).toContain('AllowOverride All');
    expect(c).toContain('SetHandler "proxy:unix:/run/php/php8.3-fpm.sock|fcgi://localhost"');
    expect(c).toContain('<FilesMatch "\\.php$">');
    expect(c).toContain('FallbackResource /index.php');
    expect(c).toContain('ErrorLog ${APACHE_LOG_DIR}/blog.contoh.com.error.log');
    expect(c).toContain('Options -Indexes');
  });

  it('statis: tanpa PHP dan tanpa fallback; PHP biasa: DocumentRoot di folder utama', () => {
    const s = apacheConf('statis.contoh.com', 'static', null);
    expect(s).not.toContain('SetHandler');
    expect(s).not.toContain('FallbackResource');
    expect(s).toContain('DocumentRoot /var/www/statis.contoh.com\n');
    const p = apacheConf('app.contoh.com', 'php', '8.2');
    expect(p).toContain('DocumentRoot /var/www/app.contoh.com\n');
    expect(p).toContain('php8.2-fpm.sock');
  });

  it('folder dokumen pilihan dipakai, "." berarti folder utama', () => {
    expect(apacheConf('a.contoh.com', 'laravel', '8.3', 'web/public')).toContain(
      'DocumentRoot /var/www/a.contoh.com/web/public',
    );
    expect(apacheConf('a.contoh.com', 'laravel', '8.3', '.')).toContain(
      'DocumentRoot /var/www/a.contoh.com\n',
    );
  });

  it('file dan folder tersembunyi (.env, .git) ditolak, .well-known diizinkan', () => {
    const c = apacheConf('a.contoh.com', 'php', '8.3');
    expect(c).toContain('<FilesMatch "^\\.(?!well-known)">');
    expect(c).toContain('<DirectoryMatch "(^|/)\\.(?!well-known)">');
    expect(c).toContain('Require all denied');
  });

  it('menolak masukan berbahaya (injeksi konfigurasi)', () => {
    expect(() => apacheConf('a.com\nSetEnv X 1', 'php', '8.3')).toThrow();
    expect(() => apacheConf('x.contoh.com', 'php', '8.3; rm -rf /')).toThrow();
    expect(() => apacheConf('x.contoh.com', 'php', null)).toThrow();
    expect(() => apacheConf('x.contoh.com', 'php', '8.3', '../etc')).toThrow();
    expect(() => apacheConf('x.contoh.com', 'php', '8.3', 'a b')).toThrow();
  });
});

describe('nginxConf dengan folder dokumen', () => {
  it('bawaan Laravel = public, pilihan pengguna dipakai, "." = folder utama', () => {
    expect(nginxConf('a.contoh.com', 'laravel', '8.3')).toContain(
      'root /var/www/a.contoh.com/public;',
    );
    expect(nginxConf('a.contoh.com', 'laravel', '8.3', 'public_html')).toContain(
      'root /var/www/a.contoh.com/public_html;',
    );
    expect(nginxConf('a.contoh.com', 'static', null, '.')).toContain('root /var/www/a.contoh.com;');
    expect(() => nginxConf('a.contoh.com', 'php', '8.3', '../x')).toThrow();
  });
});

describe('DOC_ROOT_RE dan docRoot', () => {
  it('menerima folder aman', () => {
    for (const ok of [
      '.',
      'public',
      'public_html',
      'web/public',
      'a/b/c',
      'dist-2',
      'app.v2/www',
    ]) {
      expect(DOC_ROOT_RE.test(ok), ok).toBe(true);
    }
  });

  it('menolak traversal, path absolut, tersembunyi, spasi, dan karakter konfigurasi', () => {
    const bad = [
      '',
      '..',
      '../x',
      'a/../b',
      '/etc',
      '/var/www/x',
      '.git',
      '.env',
      'a/.hidden',
      'a b',
      'a;b',
      '$(id)',
      'a\nb',
      'a//b',
      'public/',
      'a/b/c/d',
      'x"y',
      'folder-ñ',
    ];
    for (const b of bad) expect(DOC_ROOT_RE.test(b), JSON.stringify(b)).toBe(false);
  });

  it('docRoot menyusun path absolut dan menolak nilai tidak valid', () => {
    expect(docRoot('a.contoh.com', 'laravel')).toBe('/var/www/a.contoh.com/public');
    expect(docRoot('a.contoh.com', 'laravel', null)).toBe('/var/www/a.contoh.com/public');
    expect(docRoot('a.contoh.com', 'php')).toBe('/var/www/a.contoh.com');
    expect(docRoot('a.contoh.com', 'laravel', 'x/y')).toBe('/var/www/a.contoh.com/x/y');
    expect(() => docRoot('a.contoh.com', 'php', '../..')).toThrow();
    expect(defaultDocRootRel('laravel')).toBe('public');
    expect(defaultDocRootRel('static')).toBe('.');
  });
});

describe('daftar folder situs', () => {
  it('findDirsArgv: perintah tetap tanpa shell, melewati vendor/node_modules/storage/.git', () => {
    const argv = findDirsArgv('/var/www/a.contoh.com');
    expect(argv[0]).toBe('find');
    expect(argv[1]).toBe('/var/www/a.contoh.com');
    expect(argv).toContain('-prune');
    for (const n of ['vendor', 'node_modules', 'storage', '.git']) expect(argv).toContain(n);
    expect(argv.some((a) => a === 'sh' || a === '-c')).toBe(false);
  });

  const listing = [
    'd app',
    'd public',
    'f public/index.php',
    'd public/build',
    'd config',
    'd .idea',
    'd nama dengan spasi',
    'f index.php',
    'd dist',
    'f dist/index.html',
    'f app/Http/index.php',
    '',
  ].join('\n');

  it('menandai folder berisi index dan menyaring nama tidak aman atau tersembunyi', () => {
    const e = parseDirListing(listing);
    const paths = e.map((x) => x.path);
    expect(paths[0]).toBe('.');
    expect(paths).toContain('public');
    expect(paths).not.toContain('.idea');
    expect(paths).not.toContain('nama dengan spasi');
    expect(e.find((x) => x.path === '.')!.hasIndex).toBe(true);
    expect(e.find((x) => x.path === 'public')!.hasIndex).toBe(true);
    expect(e.find((x) => x.path === 'config')!.hasIndex).toBe(false);
    // yang berisi index diurutkan lebih dulu (setelah folder utama)
    const firstNoIndex = e.findIndex((x, i) => i > 0 && !x.hasIndex);
    expect(e.slice(1, firstNoIndex).every((x) => x.hasIndex)).toBe(true);
  });

  it('keluaran dibatasi', () => {
    const many = Array.from({ length: 500 }, (_, i) => `d d${i}`).join('\n');
    expect(parseDirListing(many)).toHaveLength(200);
  });

  it('suggestDocRoot: tidak mengubah bila folder bawaan sudah berisi index', () => {
    expect(suggestDocRoot('laravel', parseDirListing(listing))).toBeNull();
    expect(suggestDocRoot('php', parseDirListing('f index.php'))).toBeNull();
  });

  it('suggestDocRoot: satu kandidat dipakai, banyak kandidat pilih nama umum, ambigu = null', () => {
    expect(suggestDocRoot('laravel', parseDirListing('d dist\nf dist/index.html'))).toBe('dist');
    expect(
      suggestDocRoot(
        'laravel',
        parseDirListing('d app\nf app/index.php\nd public_html\nf public_html/index.php'),
      ),
    ).toBe('public_html');
    expect(
      suggestDocRoot('static', parseDirListing('d aaa\nf aaa/index.html\nd bbb\nf bbb/index.html')),
    ).toBeNull();
    expect(suggestDocRoot('static', parseDirListing('d aaa'))).toBeNull();
  });
});

describe('Apache dan Nginx: pilih salah satu', () => {
  const ubuntu = parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble');

  it('rencana pemasangan Apache memverifikasi paket apache2', () => {
    const plan = buildPlan({ item: 'apache' }, ubuntu, { phpVersions: [], pgVersions: [] });
    expect(plan.verifyPackages).toEqual(['apache2']);
    expect(plan.steps.map((s) => s.argv.join(' ')).join('\n')).toContain('apache2');
  });

  const statusWith = async (installed: string[]) => {
    const dpkg = installed.map((p) => `${p}\tii \t1.0\n`).join('');
    vi.mocked(execRemote).mockImplementation(async (_ssh, argv) => {
      const out = (stdout: string) => ({ code: 0, stdout, stderr: '', truncated: false });
      if (argv[0] === 'cat') return out('ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n');
      if (argv[0] === 'dpkg-query' && argv.includes('nginx')) return out(dpkg);
      if (argv[0] === 'apt-cache' && argv[1] === 'policy')
        return out(
          'nginx:\n  Installed: (none)\n  Candidate: 1.24\napache2:\n  Installed: (none)\n  Candidate: 2.4.58\n',
        );
      return out('');
    });
    return collectStatus({} as never, { sudo: false });
  };

  it('Nginx terpasang -> Apache konflik, Nginx tidak', async () => {
    const s = await statusWith(['nginx']);
    const nginx = s.items.find((i) => i.id === 'nginx')!;
    const apache = s.items.find((i) => i.id === 'apache')!;
    expect(nginx.installed).toBe(true);
    expect(nginx.conflict).toBeUndefined();
    expect(apache.installed).toBe(false);
    expect(apache.conflict).toMatch(/Nginx sudah terpasang/);
  });

  it('Apache terpasang -> Nginx konflik, Apache tidak', async () => {
    const s = await statusWith(['apache2']);
    const nginx = s.items.find((i) => i.id === 'nginx')!;
    const apache = s.items.find((i) => i.id === 'apache')!;
    expect(apache.installed).toBe(true);
    expect(apache.conflict).toBeUndefined();
    expect(nginx.conflict).toMatch(/Apache sudah terpasang/);
  });

  it('belum ada keduanya -> tidak ada konflik dan keduanya tersedia', async () => {
    const s = await statusWith([]);
    for (const id of ['nginx', 'apache']) {
      const row = s.items.find((i) => i.id === id)!;
      expect(row.conflict).toBeUndefined();
      expect(row.available).toBe(true);
    }
  });

  it('WEB_SERVERS: lokasi file dan perintah per server', () => {
    expect(WEB_SERVERS.nginx.available('a.contoh.com')).toBe(
      '/etc/nginx/sites-available/a.contoh.com.conf',
    );
    expect(WEB_SERVERS.apache.available('a.contoh.com')).toBe(
      '/etc/apache2/sites-available/a.contoh.com.conf',
    );
    expect(WEB_SERVERS.apache.enabled('a.contoh.com')).toBe(
      '/etc/apache2/sites-enabled/a.contoh.com.conf',
    );
    expect(WEB_SERVERS.nginx.test).toEqual(['nginx', '-t']);
    expect(WEB_SERVERS.apache.test).toEqual(['apache2ctl', 'configtest']);
  });
});
