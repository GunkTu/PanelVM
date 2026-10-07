import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, login, makeApp, ORIGIN, seedUser } from '../helpers.js';
import { setupRealVm, vmAvailable, type VmFixture } from './vmFixture.js';

const built = await makeApp(false, { MAX_UPLOAD_MB: '16' });
const { app, ctx } = built;
let f: VmFixture;
const rand = randomBytes(3).toString('hex');
const lara = `lara-${rand}.contoh.test`;
const stat = `statis-${rand}.contoh.test`;
const work = mkdtempSync(join(tmpdir(), 'panel-site-'));

/** Proyek "Laravel" minimal: artisan palsu, composer.json tanpa dependensi, dan front controller PHP. */
function makeProject(dir: string, version: string) {
  mkdirSync(join(dir, 'public'), { recursive: true });
  mkdirSync(join(dir, 'storage/app'), { recursive: true });
  writeFileSync(join(dir, 'composer.json'), '{"name":"fake/app","require":{}}\n');
  writeFileSync(join(dir, '.env.example'), 'APP_NAME=Fake\nAPP_KEY=\nDB_HOST=127.0.0.1\n');
  writeFileSync(join(dir, 'storage/app/.gitkeep'), '');
  writeFileSync(
    join(dir, 'artisan'),
    `#!/usr/bin/env php
<?php
$cmd = $argv[1] ?? '';
if ($cmd === 'key:generate') {
  $env = file_get_contents('.env');
  file_put_contents('.env', preg_replace('/^APP_KEY=.*$/m', 'APP_KEY=base64:' . base64_encode(random_bytes(32)), $env));
  echo "Application key set successfully.\\n"; exit(0);
}
if ($cmd === 'migrate:status') { echo "FAKE-MIGRATE-STATUS\\n"; exit(0); }
if ($cmd === 'migrate') { echo "FAKE-MIGRATED\\n"; exit(0); }
if ($cmd === 'storage:link') { @symlink(getcwd().'/storage/app', getcwd().'/public/storage'); echo "linked\\n"; exit(0); }
if ($cmd === 'optimize') { echo "optimized\\n"; exit(0); }
fwrite(STDERR, "perintah tidak dikenal: $cmd\\n"); exit(1);
`,
  );
  writeFileSync(
    join(dir, 'public/index.php'),
    `<?php
$env = @file_get_contents(__DIR__ . '/../.env');
echo "FAKE LARAVEL ${version} " . (preg_match('/^APP_KEY=base64:/m', $env) ? 'KEY_OK' : 'NO_KEY') . ' ' . (file_exists(__DIR__ . '/../vendor/autoload.php') ? 'VENDOR_OK' : 'NO_VENDOR');
`,
  );
}

const zipOf = (dir: string, wrapName?: string): Buffer => {
  const out = join(work, `${randomBytes(3).toString('hex')}.zip`);
  if (wrapName) {
    const parent = mkdtempSync(join(work, 'wrap-'));
    execFileSync('cp', ['-a', dir, join(parent, wrapName)]);
    mkdirSync(join(parent, '__MACOSX'));
    writeFileSync(join(parent, '__MACOSX/._junk'), 'x');
    execFileSync('zip', ['-r', '-q', out, '.'], { cwd: parent });
  } else execFileSync('zip', ['-r', '-q', out, '.'], { cwd: dir });
  return readFileSync(out);
};
const tarOf = (dir: string): Buffer => {
  const out = join(work, `${randomBytes(3).toString('hex')}.tar.gz`);
  execFileSync('tar', ['-czf', out, '-C', dir, '.']);
  return readFileSync(out);
};
const http = (host: string, path = '/') =>
  execFileSync('curl', ['-s', '-H', `Host: ${host}`, `http://127.0.0.1${path}`]).toString();
const status = (host: string) =>
  execFileSync('curl', [
    '-s',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '-H',
    `Host: ${host}`,
    'http://127.0.0.1/',
  ]).toString();

beforeAll(async () => {
  if (vmAvailable) f = await setupRealVm(built, 'vm-site', 'admin-site@contoh.com');
});
afterAll(async () => {
  if (vmAvailable) {
    for (const d of [lara, stat]) {
      const row = ctx.db.prepare('SELECT id FROM sites WHERE domain = ?').get(d) as
        { id: string } | undefined;
      if (row) await post(`/sites/${row.id}/delete`, { confirm: d, deleteFiles: true });
    }
  }
  await app.close();
  rmSync(work, { recursive: true, force: true });
});

const base = () => `/api/vms/${f.vmId}`;
const post = (p: string, body: unknown) => call(app, f.admin, 'POST', `${base()}${p}`, body);
const deploy = (siteId: string, name: string, data: Buffer, q = '') =>
  app.inject({
    method: 'POST',
    url: `${base()}/sites/${siteId}/deploy?filename=${encodeURIComponent(name)}${q}`,
    headers: {
      origin: ORIGIN,
      cookie: f.admin.cookie,
      'x-csrf-token': f.admin.csrf,
      'content-type': 'application/octet-stream',
    },
    payload: data,
  });
async function waitJob(id: string) {
  const end = Date.now() + 180_000;
  for (;;) {
    const r = (await call(app, f.admin, 'GET', `${base()}/jobs/${id}`)).json();
    if (r.status !== 'running') return r as { status: string; log: string };
    if (Date.now() > end) throw new Error('job timeout');
    await new Promise((r) => setTimeout(r, 400));
  }
}
let laraId = '';

describe.skipIf(!vmAvailable)('situs web + deploy (nginx & PHP-FPM nyata)', () => {
  it('opsi: nginx, composer, dan versi PHP terpasang terdeteksi', async () => {
    const r = (await call(app, f.admin, 'GET', `${base()}/sites/options`)).json();
    expect(r).toMatchObject({ nginx: true, composer: true });
    expect(r.phpVersions).toContain('8.3');
  });

  it('validasi input: domain, PHP, duplikat', async () => {
    for (const domain of [
      'http://x.com',
      'a;b.com',
      'x',
      '../x.com',
      'a b.com',
      'a.com\nserver {',
      '-a.com',
      'a..com',
    ]) {
      expect(
        (await post('/sites', { domain, kind: 'php', phpVersion: '8.3' })).statusCode,
        domain,
      ).toBe(400);
    }
    expect((await post('/sites', { domain: 'ok.contoh.test', kind: 'laravel' })).statusCode).toBe(
      400,
    );
    expect(
      (await post('/sites', { domain: 'ok.contoh.test', kind: 'static', phpVersion: '8.3' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await post('/sites', { domain: 'ok.contoh.test', kind: 'php', phpVersion: '8' })).statusCode,
    ).toBe(400);
    expect(
      (await post('/sites', { domain: 'ok.contoh.test', kind: 'php', phpVersion: '8.3; id' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await post('/sites', { domain: 'ok.contoh.test', kind: 'php', phpVersion: '8.9' }))
        .statusCode,
    ).toBe(409); // format valid tapi tidak terpasang
    expect(
      (await post('/sites', { domain: 'ok.contoh.test', kind: 'php', phpVersion: '7.4' }))
        .statusCode,
    ).toBe(409); // belum terpasang
  });

  it('membuat situs Laravel: vhost valid, nginx melayani halaman awal', async () => {
    const r = await post('/sites', { domain: lara, kind: 'laravel', phpVersion: '8.3' });
    expect(r.statusCode, r.body).toBe(201);
    laraId = r.json().id;
    expect(r.json()).toMatchObject({
      docRoot: `/var/www/${lara}/public`,
      envPath: `/var/www/${lara}/.env`,
    });
    expect(http(lara)).toContain('Situs siap');
    expect(
      (await post('/sites', { domain: lara, kind: 'laravel', phpVersion: '8.3' })).statusCode,
    ).toBe(409);
  });

  it(
    'deploy zip Laravel: ekstrak, composer, .env, APP_KEY, izin www-data, dilayani PHP-FPM',
    { timeout: 120_000 },
    async () => {
      const proj = join(work, 'v1');
      makeProject(proj, 'v1');
      const up = await deploy(laraId, 'app.zip', zipOf(proj, 'proyek-saya'));
      expect(up.statusCode, up.body).toBe(200);
      const job = await waitJob(up.json().id);
      expect(job.status, job.log.slice(-1200)).toBe('succeeded');
      expect(job.log).toContain('satu folder');
      expect(job.log).toContain('Composer install');
      expect(job.log).toContain('Application key set');
      expect(http(lara)).toBe('FAKE LARAVEL v1 KEY_OK VENDOR_OK');
      const list = (
        await call(
          app,
          f.admin,
          'GET',
          `${base()}/files/list?path=${encodeURIComponent(`/var/www/${lara}`)}`,
        )
      ).json();
      const names = list.items.map((i: { name: string }) => i.name);
      expect(names).toContain('artisan');
      expect(names).not.toContain('__MACOSX');
      expect(list.items.find((i: { name: string }) => i.name === '.env').uid).toBe(33); // www-data
    },
  );

  it(
    'update lewat tar.gz mempertahankan .env dan data storage/app, tapi memperbarui kode',
    { timeout: 120_000 },
    async () => {
      const envPath = `/var/www/${lara}/.env`;
      const cur = (
        await call(
          app,
          f.admin,
          'GET',
          `${base()}/files/content?path=${encodeURIComponent(envPath)}`,
        )
      ).json().content as string;
      await call(app, f.admin, 'PUT', `${base()}/files/content`, {
        path: envPath,
        content: `${cur}\nBUATAN_ADMIN=ya\n`,
      });
      const put = await call(app, f.admin, 'PUT', `${base()}/files/content`, {
        path: `/var/www/${lara}/storage/app/user.txt`,
        content: 'unggahan pengguna',
        create: true,
      });
      expect(put.statusCode, put.body).toBe(200);

      const proj = join(work, 'v2');
      makeProject(proj, 'v2');
      writeFileSync(join(proj, '.env'), 'APP_KEY=\nDIBAWA_ARSIP=jangan\n'); // .env di arsip tidak boleh menimpa
      const up = await deploy(laraId, 'app.tar.gz', tarOf(proj), '&migrate=true&optimize=true');
      expect(up.statusCode, up.body).toBe(200);
      const job = await waitJob(up.json().id);
      expect(job.status, job.log.slice(-1200)).toBe('succeeded');
      expect(job.log).toContain('FAKE-MIGRATED');
      expect(http(lara)).toBe('FAKE LARAVEL v2 KEY_OK VENDOR_OK');
      const env = (
        await call(
          app,
          f.admin,
          'GET',
          `${base()}/files/content?path=${encodeURIComponent(envPath)}`,
        )
      ).json().content as string;
      expect(env).toContain('BUATAN_ADMIN=ya');
      expect(env).not.toContain('DIBAWA_ARSIP');
      const kept = (
        await call(
          app,
          f.admin,
          'GET',
          `${base()}/files/content?path=${encodeURIComponent(`/var/www/${lara}/storage/app/user.txt`)}`,
        )
      ).json();
      expect(kept, JSON.stringify(kept)).toMatchObject({ content: 'unggahan pengguna' });
    },
  );

  it('artisan: hanya perintah daftar tetap, hanya untuk Laravel', async () => {
    const ok = await post(`/sites/${laraId}/artisan`, { command: 'migrate:status' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ code: 0 });
    expect(ok.json().output).toContain('FAKE-MIGRATE-STATUS');
    for (const command of ['tinker', 'migrate:fresh', 'migrate; id', '--version', '$(id)']) {
      expect((await post(`/sites/${laraId}/artisan`, { command })).statusCode, command).toBe(400);
    }
    expect((await post(`/sites/${laraId}/php`, { phpVersion: '8.2' })).statusCode).toBe(409);
    expect((await post(`/sites/${laraId}/php`, { phpVersion: '8.3' })).statusCode).toBe(200);
  });

  it(
    'situs statis: ratakan folder pembungkus dan abaikan __MACOSX',
    { timeout: 60_000 },
    async () => {
      const r = await post('/sites', { domain: stat, kind: 'static' });
      expect(r.statusCode).toBe(201);
      const dir = join(work, 'statis');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.html'), '<h1>HALAMAN STATIS</h1>');
      writeFileSync(join(dir, '.rahasia'), 'x');
      const up = await deploy(r.json().id, 'situs.zip', zipOf(dir, 'build'));
      const job = await waitJob(up.json().id);
      expect(job.status, job.log.slice(-800)).toBe('succeeded');
      expect(http(stat)).toContain('HALAMAN STATIS');
      expect(status(stat)).toBe('200');
      expect(
        execFileSync('curl', [
          '-s',
          '-o',
          '/dev/null',
          '-w',
          '%{http_code}',
          '-H',
          `Host: ${stat}`,
          'http://127.0.0.1/.rahasia',
        ]).toString(),
      ).toBe('403'); // dotfile diblokir
      expect((await post(`/sites/${r.json().id}/artisan`, { command: 'migrate' })).statusCode).toBe(
        400,
      );
    },
  );

  it('upload tidak valid: format salah, terlalu besar, dan tidak ada folder .env bocor', async () => {
    expect((await deploy(laraId, 'app.rar', Buffer.from('x'))).statusCode).toBe(400);
    expect((await deploy(laraId, 'app.zip', randomBytes(17 * 1024 * 1024))).statusCode).toBe(413);
    expect(
      execFileSync('curl', [
        '-s',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '-H',
        `Host: ${lara}`,
        'http://127.0.0.1/.env',
      ]).toString(),
    ).toBe('403');
    expect(execFileSync('ls', ['/tmp']).toString()).not.toMatch(/panel-deploy-/); // arsip sementara dibersihkan
  });

  it(
    'deploy Git: URL berbahaya ditolak, kegagalan clone terlihat jelas di log',
    { timeout: 60_000 },
    async () => {
      for (const url of [
        'http://github.com/a/b.git',
        'https://user:pw@github.com/a/b.git',
        'file:///etc',
        'https://github.com/a/b.git --upload-pack=id',
        'git@github.com:a/b.git',
        'https://github.com/a/b;id',
      ]) {
        expect((await post(`/sites/${laraId}/deploy-git`, { url })).statusCode, url).toBe(400);
      }
      expect(
        (
          await post(`/sites/${laraId}/deploy-git`, {
            url: 'https://github.com/a/b.git',
            branch: '--evil',
          })
        ).statusCode,
      ).toBe(400);
      const r = await post(`/sites/${laraId}/deploy-git`, {
        url: 'https://host-tidak-ada.invalid/a/b.git',
      });
      expect(r.statusCode).toBe(200);
      const job = await waitJob(r.json().id);
      expect(job.status).toBe('failed');
      expect(job.log).toContain('git clone');
      expect(job.log).toContain('[GAGAL]');
    },
  );

  it('client lain tidak bisa mengakses situs VM ini (404)', async () => {
    const other = await seedUser(built, 'luar-site@contoh.com');
    const c = await login(app, other);
    for (const [m, p] of [
      ['GET', '/sites'],
      ['GET', '/sites/options'],
      ['POST', '/sites'],
      ['POST', `/sites/${laraId}/delete`],
      ['POST', `/sites/${laraId}/artisan`],
      ['POST', `/sites/${laraId}/php`],
      ['POST', `/sites/${laraId}/deploy-git`],
    ] as const) {
      expect(
        (
          await call(app, c, m, `${base()}${p}`, {
            domain: 'x.contoh.test',
            kind: 'static',
            command: 'migrate',
            confirm: 'x',
            phpVersion: '8.3',
            url: 'https://github.com/a/b.git',
          })
        ).statusCode,
        p,
      ).toBe(404);
    }
    const up = await app.inject({
      method: 'POST',
      url: `${base()}/sites/${laraId}/deploy?filename=a.zip`,
      headers: {
        origin: ORIGIN,
        cookie: c.cookie,
        'x-csrf-token': c.csrf,
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.from('x'),
    });
    expect(up.statusCode).toBe(404);
  });

  it('hapus: butuh konfirmasi domain; konfigurasi dan file ikut hilang', async () => {
    expect((await post(`/sites/${laraId}/delete`, { confirm: 'salah' })).statusCode).toBe(400);
    expect(
      (await post(`/sites/${laraId}/delete`, { confirm: lara, deleteFiles: true })).statusCode,
    ).toBe(200);
    expect(ctx.db.prepare('SELECT 1 AS ok FROM sites WHERE domain = ?').get(lara)).toBeUndefined();
    const gone = await call(
      app,
      f.admin,
      'GET',
      `${base()}/files/list?path=${encodeURIComponent(`/var/www/${lara}`)}`,
    );
    expect(gone.statusCode).toBe(404);
    // Host yang tak dikenal jatuh ke server block lain; yang penting konten situs yang dihapus tidak tersaji lagi.
    expect(http(lara)).not.toContain('FAKE LARAVEL');
  });
});
