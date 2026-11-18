import { describe, expect, it } from 'vitest';
import {
  commandProblem,
  cronFile,
  nextFreePort,
  proxyConf,
  systemdUnit,
  validSchedule,
  WORKDIR_RE,
} from '../src/modules/tasks/spec.js';

describe('validSchedule', () => {
  it('menerima jadwal cron yang lazim', () => {
    for (const s of [
      '* * * * *',
      '*/5 * * * *',
      '0 3 * * *',
      '0 0 1 1 *',
      '15,45 8-17 * * 1-5',
      '0 */2 * * 0',
      '0 0 * * 7',
      '@daily',
      '@hourly',
    ])
      expect(validSchedule(s), s).toBe(true);
  });

  it('menolak yang di luar rentang, salah bentuk, atau berisi sisipan', () => {
    for (const s of [
      '',
      '* * * *',
      '* * * * * *',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * 32 * *',
      '* * * 13 *',
      '* * * * 8',
      '*/0 * * * *',
      '5-1 * * * *',
      '@reboot',
      '@every5m',
      '* * * * * ; rm -rf /',
      '*  * * * *',
      'a * * * *',
      '* * * * *\n* * * * *',
    ])
      expect(validSchedule(s), JSON.stringify(s)).toBe(false);
  });
});

describe('commandProblem', () => {
  it('menerima perintah polos dan {PORT}', () => {
    for (const c of [
      'npm start',
      'node server.js',
      'php8.3 artisan queue:work --sleep=3 --tries=3',
      './venv/bin/gunicorn -b 127.0.0.1:{PORT} app:app',
      'python3 -m http.server {PORT}',
    ])
      expect(commandProblem(c), c).toBeNull();
  });

  it('menolak metakarakter shell dan systemd', () => {
    for (const c of [
      '',
      'npm start; rm -rf /',
      'node a.js && node b.js',
      'node a.js | tee x',
      'node a.js > /etc/passwd',
      'echo $HOME',
      'echo `id`',
      'echo $(id)',
      'node "a b.js"',
      "node 'a'",
      'node %n',
      'node a.js\nExecStartPost=/bin/sh',
      'node  a.js',
      ' node',
      'x'.repeat(301),
      'node {OTHER}',
    ])
      expect(commandProblem(c), JSON.stringify(c)).not.toBeNull();
  });
});

describe('WORKDIR_RE', () => {
  it('hanya di /var/www atau /srv, tanpa ".." dan folder tersembunyi', () => {
    for (const p of ['/var/www/blog.contoh.com', '/srv/app', '/var/www/a/b/c'])
      expect(WORKDIR_RE.test(p), p).toBe(true);
    for (const p of [
      '/etc',
      '/var/www',
      '/var/www/../etc',
      '/var/www/a/../../etc',
      '/var/www/.git',
      '/var/www/a b',
      '/root/x',
      '/var/www/a;id',
      '/var/www/a/b/c/d/e',
      'var/www/a',
    ])
      expect(WORKDIR_RE.test(p), p).toBe(false);
  });
});

describe('cronFile', () => {
  it('menghasilkan baris cron sebagai www-data dengan keluaran dibuang', () => {
    const f = cronFile({
      name: 'blog-scheduler',
      schedule: '* * * * *',
      workdir: '/var/www/blog.contoh.com',
      command: 'php8.3 artisan schedule:run',
    });
    expect(f).toContain(
      '* * * * * www-data cd /var/www/blog.contoh.com && php8.3 artisan schedule:run >/dev/null 2>&1\n',
    );
    expect(f.endsWith('\n')).toBe(true);
  });

  it('menolak masukan berbahaya', () => {
    const base = { name: 'x1', schedule: '* * * * *', workdir: '/srv/a', command: 'ls' };
    expect(() => cronFile({ ...base, name: 'a;b' })).toThrow();
    expect(() => cronFile({ ...base, schedule: '* * * * * root id' })).toThrow();
    expect(() => cronFile({ ...base, workdir: '/etc' })).toThrow();
    expect(() => cronFile({ ...base, command: 'ls; id' })).toThrow();
  });
});

describe('systemdUnit', () => {
  const base = {
    kind: 'app' as const,
    name: 'toko',
    workdir: '/var/www/toko.contoh.com',
    command: 'npm start',
    port: 3001,
    withEnvFile: true,
  };

  it('app: berjalan sebagai www-data, PORT dan .env opsional, restart otomatis', () => {
    const u = systemdUnit(base);
    expect(u).toContain('User=www-data');
    expect(u).toContain('WorkingDirectory=/var/www/toko.contoh.com');
    expect(u).toContain('Environment=PORT=3001');
    expect(u).toContain('EnvironmentFile=-/var/www/toko.contoh.com/.env');
    expect(u).toContain('ExecStart=/usr/bin/env npm start\n');
    expect(u).toContain('Restart=always');
    expect(u).toContain('NoNewPrivileges=true');
  });

  it('{PORT} diganti, worker tanpa port tidak mendapat PORT', () => {
    expect(systemdUnit({ ...base, command: 'gunicorn -b 127.0.0.1:{PORT} app:app' })).toContain(
      'ExecStart=/usr/bin/env gunicorn -b 127.0.0.1:3001 app:app\n',
    );
    const w = systemdUnit({
      kind: 'worker',
      name: 'blog-queue',
      workdir: '/var/www/blog.contoh.com',
      command: 'php8.3 artisan queue:work',
      port: null,
      withEnvFile: false,
    });
    expect(w).not.toContain('PORT=');
    expect(w).not.toContain('EnvironmentFile');
    expect(w).not.toContain('NODE_ENV');
  });

  it('menolak masukan yang bisa menyisipkan direktif atau keluar folder', () => {
    expect(() => systemdUnit({ ...base, command: 'npm start\nExecStartPost=/bin/sh' })).toThrow();
    expect(() => systemdUnit({ ...base, command: 'npm start %n' })).toThrow();
    expect(() => systemdUnit({ ...base, workdir: '/var/www/../etc' })).toThrow();
    expect(() => systemdUnit({ ...base, name: 'A b' })).toThrow();
    expect(() => systemdUnit({ ...base, port: 22 })).toThrow();
    expect(() => systemdUnit({ ...base, port: 3001.5 })).toThrow();
  });
});

describe('proxyConf dan port', () => {
  it('proxy_pass hanya ke 127.0.0.1 pada port yang valid', () => {
    const c = proxyConf('toko.contoh.com', 3005);
    expect(c).toContain('server_name toko.contoh.com;');
    expect(c).toContain('proxy_pass http://127.0.0.1:3005;');
    expect(c).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(() => proxyConf('toko.contoh.com', 80)).toThrow();
    expect(() => proxyConf('bukan domain;', 3005)).toThrow();
  });

  it('nextFreePort memilih port terkecil yang belum dipakai', () => {
    expect(nextFreePort([])).toBe(3001);
    expect(nextFreePort([3001, 3002, 3004])).toBe(3003);
    expect(nextFreePort(Array.from({ length: 999 }, (_, i) => 3001 + i))).toBeNull();
  });
});
