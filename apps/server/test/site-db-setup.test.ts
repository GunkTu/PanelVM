import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanSql, SqlScanner } from '../src/modules/databases/sqlscan.js';
import { dbNameFromDomain, setEnvVars } from '../src/modules/sites/envfile.js';
import { dbIdentifier, RESERVED_NAMES } from '../src/modules/databases/validate.js';
import { startFakeSsh } from './fakeSsh.js';
import { call, login, makeApp, seedUser, type Client } from './helpers.js';

describe('setEnvVars', () => {
  const vars = { DB_DATABASE: 'blog', DB_PASSWORD: 'abc123' };

  it('mengganti baris yang ada dan baris yang dikomentari, tanpa menyentuh baris lain', () => {
    const out = setEnvVars(
      'APP_NAME=Blog\n# DB_DATABASE=laravel\nDB_PASSWORD=\nAPP_ENV=local\n',
      vars,
    );
    expect(out).toBe('APP_NAME=Blog\nDB_DATABASE=blog\nDB_PASSWORD=abc123\nAPP_ENV=local\n');
  });

  it('menambahkan kunci yang belum ada di akhir dan menjaga akhir baris', () => {
    expect(setEnvVars('APP_NAME=Blog\n', vars)).toBe(
      'APP_NAME=Blog\nDB_DATABASE=blog\nDB_PASSWORD=abc123\n',
    );
    expect(setEnvVars('', vars)).toBe('DB_DATABASE=blog\nDB_PASSWORD=abc123\n');
    expect(setEnvVars('A=1\r\nDB_DATABASE=x\r\n', vars)).toBe(
      'A=1\r\nDB_DATABASE=blog\r\nDB_PASSWORD=abc123\r\n',
    );
  });

  it('hanya baris pertama yang cocok yang diganti', () => {
    const out = setEnvVars('DB_DATABASE=a\nDB_DATABASE=b\n', { DB_DATABASE: 'x' });
    expect(out).toBe('DB_DATABASE=x\nDB_DATABASE=b\n');
  });

  it('menolak nilai yang bisa menyisipkan baris atau perintah, dan nama variabel aneh', () => {
    expect(() => setEnvVars('', { DB_PASSWORD: 'a\nAPP_KEY=x' })).toThrow();
    expect(() => setEnvVars('', { DB_PASSWORD: 'a b' })).toThrow();
    expect(() => setEnvVars('', { DB_PASSWORD: '$(id)' })).toThrow();
    expect(() => setEnvVars('', { db_x: 'a' })).toThrow();
  });
});

describe('dbNameFromDomain', () => {
  it('menghasilkan nama yang lolos aturan database dan tidak dicadangkan', () => {
    for (const d of [
      'blog.contoh.com',
      'toko-saya.my.id',
      '123.contoh.com',
      'a.io',
      'sik-bss.thegt.my.id',
    ]) {
      const n = dbNameFromDomain(d);
      expect(() => dbIdentifier.parse(n), `${d} -> ${n}`).not.toThrow();
      expect(n.length).toBeLessThanOrEqual(28);
      expect(RESERVED_NAMES.has(n)).toBe(false);
    }
    expect(dbNameFromDomain('toko-saya.contoh.com')).toBe('toko_saya_contoh');
    expect(dbNameFromDomain('123.contoh.com')).toBe('s_123_contoh');
  });
});

describe('scanSql', () => {
  it('mendeteksi DROP DATABASE, DROP TABLE, TRUNCATE, CREATE DATABASE, USE', () => {
    const f = scanSql(
      'DROP DATABASE IF EXISTS sik_bss;\nCREATE DATABASE sik_bss;\nUSE sik_bss;\nDROP TABLE users;\nTRUNCATE TABLE log;',
    );
    expect(f.map((x) => x.risk).sort()).toEqual(
      ['create_database', 'drop_database', 'drop_table', 'truncate', 'use'].sort(),
    );
    expect(f.find((x) => x.risk === 'drop_database')!.snippet).toContain('sik_bss');
  });

  it('SQL biasa dan pernyataan di dalam komentar tidak memicu peringatan', () => {
    expect(scanSql('CREATE TABLE a (id INT);\nINSERT INTO a VALUES (1);')).toEqual([]);
    expect(scanSql('-- DROP DATABASE x;\n# TRUNCATE y;\n/* DROP TABLE z; */\nSELECT 1;')).toEqual(
      [],
    );
  });

  it('pemindai bertahap mendeteksi pernyataan yang terbelah di antara dua potongan', () => {
    const s = new SqlScanner();
    s.push('INSERT INTO a VALUES (1);\nDR');
    s.push('OP DATABASE halo;');
    expect(s.result().risks).toEqual(['drop_database']);
  });
});

describe('POST /sites/:id/database: otorisasi dan masukan', () => {
  const fake = startFakeSsh({});
  let admin: Client, owner: Client, other: Client;
  let built: Awaited<ReturnType<typeof makeApp>>;
  let url = '';

  beforeAll(async () => {
    const f = await fake;
    built = await makeApp();
    admin = await login(built.app, await seedUser(built, 'admin@contoh.com', 'admin'));
    const ownerU = await seedUser(built, 'pemilik@contoh.com');
    owner = await login(built.app, ownerU);
    other = await login(built.app, await seedUser(built, 'lain@contoh.com'));
    const vm = (
      await call(built.app, admin, 'POST', '/api/vms', {
        name: 'vm-db',
        host: '127.0.0.1',
        sshPort: f.port,
        sshUser: 'root',
      })
    ).json().id as string;
    await call(built.app, admin, 'PUT', `/api/vms/${vm}/assignment`, { userId: ownerU.row.id });
    const siteId = crypto.randomUUID();
    built.ctx.db
      .prepare(
        'INSERT INTO sites (id, vm_id, domain, kind, php_version, root_path, web_server, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        siteId,
        vm,
        'blog.contoh.com',
        'laravel',
        '8.3',
        '/var/www/blog.contoh.com',
        'nginx',
        Date.now(),
      );
    url = `/api/vms/${vm}/sites/${siteId}/database`;
  });
  afterAll(async () => {
    await built.app.close();
    await (await fake).close();
  });

  it('tanpa login 401; client lain 404', async () => {
    expect((await call(built.app, null, 'POST', url, {})).statusCode).toBe(401);
    expect((await call(built.app, other, 'POST', url, {})).statusCode).toBe(404);
  });

  it('nama database tidak valid atau dicadangkan ditolak sebelum menyentuh VM', async () => {
    for (const name of ['Ab', 'root', 'a;drop', 'x'.repeat(40), 'mysql']) {
      expect((await call(built.app, owner, 'POST', url, { name })).statusCode, name).toBe(400);
    }
    expect((await call(built.app, owner, 'POST', url, { engine: 'oracle' })).statusCode).toBe(400);
  });
});
