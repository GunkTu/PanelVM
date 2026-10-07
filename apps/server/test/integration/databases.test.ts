import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, login, makeApp, ORIGIN, seedUser } from '../helpers.js';
import { setupRealVm, vmAvailable, type VmFixture } from './vmFixture.js';

const built = await makeApp(false, { MAX_UPLOAD_MB: '8' });
const { app, ctx } = built;
let f: VmFixture;
const suffix = randomBytes(3).toString('hex');
const dbName = `uji_${suffix}`;
const userName = `usr_${suffix}`;
const secrets: string[] = [];

beforeAll(async () => {
  if (vmAvailable) f = await setupRealVm(built, 'vm-db', 'admin-db@contoh.com');
});
afterAll(async () => {
  if (vmAvailable) {
    for (const n of [dbName, `${dbName}_b`])
      await call(app, f.admin, 'POST', `/api/vms/${f.vmId}/databases/drop`, {
        name: n,
        confirm: n,
      });
    for (const n of [userName, `${userName}_b`])
      await call(app, f.admin, 'POST', `/api/vms/${f.vmId}/databases/users/drop`, {
        name: n,
        confirm: n,
      });
  }
  await app.close();
});

const base = () => `/api/vms/${f.vmId}/databases`;
const post = (p: string, body: unknown) => call(app, f.admin, 'POST', `${base()}${p}`, body);
/** Login sebagai user DB lewat TCP, persis seperti aplikasi Laravel di VM. */
const asUser = (user: string, pw: string, db: string, sql: string) =>
  execFileSync('mariadb', ['-h127.0.0.1', '-P3306', `-u${user}`, `-p${pw}`, db, '-N', '-e', sql], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();

describe.skipIf(!vmAvailable)('database manager (MariaDB nyata)', () => {
  it('mendeteksi engine dan flavor dari VM', async () => {
    const r = await call(app, f.admin, 'GET', `${base()}/engines`);
    expect(r.statusCode).toBe(200);
    const e = r.json().engines[0];
    expect(e).toMatchObject({ engine: 'mysql', flavor: 'mariadb', running: true, managed: true });
    expect(e.version).toMatch(/^\d+\.\d+/);
  });

  it('membuat database + user, kredensial dikembalikan sekali dan benar-benar bisa login', async () => {
    const r = await post('', { name: dbName, user: userName });
    expect(r.statusCode).toBe(200);
    const c = r.json().credentials as { user: string; password: string; envSnippet: string };
    secrets.push(c.password);
    expect(c.password).toHaveLength(24);
    expect(c.envSnippet).toContain(`DB_DATABASE=${dbName}`);
    expect(asUser(userName, c.password, dbName, 'SELECT 1')).toBe('1');
    // user juga bisa lewat 'localhost' (socket)
    expect(
      execFileSync('mariadb', [`-u${userName}`, `-p${c.password}`, dbName, '-N', '-e', 'SELECT 2'])
        .toString()
        .trim(),
    ).toBe('2');

    const list = await call(app, f.admin, 'GET', base());
    expect(list.json().databases.map((d: { name: string }) => d.name)).toContain(dbName);
    const u = list.json().users.find((x: { name: string }) => x.name === userName);
    expect(u.databases).toEqual([{ name: dbName, level: 'all' }]);
    // database sistem dan akun sistem tidak pernah tampil
    expect(
      list
        .json()
        .databases.some((d: { name: string }) =>
          ['mysql', 'information_schema', 'sys'].includes(d.name),
        ),
    ).toBe(false);
    expect(
      list
        .json()
        .users.some((x: { name: string }) => ['root', 'mariadb.sys', 'mysql'].includes(x.name)),
    ).toBe(false);
  });

  it('menolak nama berbahaya, dicadangkan, atau duplikat', async () => {
    for (const name of [
      'a',
      'Besar',
      'mysql',
      'root',
      'information_schema',
      'sys',
      'postgres',
      'a`; DROP DATABASE x; --',
      "x'y",
      'ab c',
      '1abc',
      'a'.repeat(40),
    ]) {
      expect((await post('', { name })).statusCode, name).toBe(400);
    }
    expect((await post('', { name: dbName })).statusCode).toBe(409);
    expect((await post('/users', { name: userName })).statusCode).toBe(409);
  });

  it('hak akses: readonly bisa SELECT tapi tidak INSERT; revoke mencabut', async () => {
    const b = `${dbName}_b`;
    expect((await post('', { name: b })).statusCode).toBe(200);
    const cu = (await post('/users', { name: `${userName}_b`, database: b })).json().credentials;
    secrets.push(cu.password);
    asUser(cu.user, cu.password, b, 'CREATE TABLE t (id INT)');
    expect(
      (await post('/grant', { user: cu.user, database: b, level: 'readonly' })).statusCode,
    ).toBe(200);
    expect(asUser(cu.user, cu.password, b, 'SELECT COUNT(*) FROM t')).toBe('0');
    expect(() => asUser(cu.user, cu.password, b, 'INSERT INTO t VALUES (1)')).toThrow();
    const list = await call(app, f.admin, 'GET', base());
    expect(list.json().users.find((x: { name: string }) => x.name === cu.user).databases).toEqual([
      { name: b, level: 'readonly' },
    ]);
    expect((await post('/revoke', { user: cu.user, database: b })).statusCode).toBe(200);
    expect(() => asUser(cu.user, cu.password, b, 'SELECT 1 FROM t')).toThrow();
    expect(
      (await post('/grant', { user: 'tidak_ada', database: b, level: 'all' })).statusCode,
    ).toBe(404);
  });

  it('reset password mengganti kredensial lama', async () => {
    const r = await post('/users/password', { name: userName });
    expect(r.statusCode).toBe(200);
    const fresh = r.json().credentials.password as string;
    secrets.push(fresh);
    expect(asUser(userName, fresh, dbName, 'SELECT 1')).toBe('1');
    expect(() => asUser(userName, secrets[0]!, dbName, 'SELECT 1')).toThrow();
  });

  it('query editor: hasil tabel, karakter khusus, error informatif, tanpa injeksi shell', async () => {
    const q = async (sql: string, database: string | null = dbName) =>
      post('/query', { database, sql });
    expect((await q('CREATE TABLE x (id INT PRIMARY KEY, v TEXT)')).statusCode).toBe(200);
    expect(
      (await q("INSERT INTO x VALUES (1, 'a\\tb\\nc'), (2, 'O''Reilly \"q\" $(id) `id`')"))
        .statusCode,
    ).toBe(200);
    const sel = (await q('SELECT id, v FROM x ORDER BY id')).json();
    expect(sel.columns).toEqual(['id', 'v']);
    expect(sel.rows).toEqual([
      ['1', 'a\tb\nc'],
      ['2', 'O\'Reilly "q" $(id) `id`'],
    ]);
    const bad = await q('SELEKT 1');
    expect(bad.statusCode).toBe(422);
    expect(bad.json().message).toContain('Server database menolak perintah');
    expect((await q('SELECT 1', 'mysql')).statusCode).toBe(400); // nama database sistem ditolak validator
    // hasil besar dipotong
    const big = (await q('SELECT REPEAT("x", 1000) AS c FROM seq_1_to_4000')).json();
    expect(big.truncated).toBe(true);
    expect(big.rows.length).toBeLessThan(4000);
  });

  it('import SQL besar via stream dan export kembali', { timeout: 60_000 }, async () => {
    const b = `${dbName}_b`;
    const lines = [
      'SET autocommit=0;',
      'DROP TABLE IF EXISTS t;',
      'CREATE TABLE t (id INT, v VARCHAR(100));',
    ];
    for (let i = 0; i < 20000; i += 500) {
      const rows = Array.from(
        { length: 500 },
        (_, k) => `(${i + k}, 'baris-${i + k}-${'x'.repeat(50)}')`,
      );
      lines.push(`INSERT INTO t VALUES ${rows.join(',')};`);
    }
    lines.push('COMMIT;');
    const sql = Buffer.from(lines.join('\n'));
    expect(sql.length).toBeGreaterThan(1024 * 1024); // melewati bodyLimit default Fastify (1 MB)
    const imp = await app.inject({
      method: 'POST',
      url: `${base()}/import?database=${b}`,
      headers: {
        origin: ORIGIN,
        cookie: f.admin.cookie,
        'x-csrf-token': f.admin.csrf,
        'content-type': 'application/octet-stream',
      },
      payload: sql,
    });
    expect(imp.statusCode).toBe(200);
    const count = (
      await post('/query', { database: b, sql: 'SELECT COUNT(*) AS n FROM t' })
    ).json();
    expect(count.rows[0][0]).toBe('20000');

    const exp = await call(app, f.admin, 'GET', `${base()}/export?database=${b}`);
    expect(exp.statusCode).toBe(200);
    expect(exp.headers['content-disposition']).toContain(`${b}-`);
    expect(exp.body).toContain('CREATE TABLE `t`');
    expect(exp.body).toContain('baris-19999-');

    const badImp = await app.inject({
      method: 'POST',
      url: `${base()}/import?database=${b}`,
      headers: {
        origin: ORIGIN,
        cookie: f.admin.cookie,
        'x-csrf-token': f.admin.csrf,
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.from('INSERT INTO tabel_tidak_ada VALUES (1);'),
    });
    expect(badImp.statusCode).toBe(422);
    const tooBig = await app.inject({
      method: 'POST',
      url: `${base()}/import?database=${b}`,
      headers: {
        origin: ORIGIN,
        cookie: f.admin.cookie,
        'x-csrf-token': f.admin.csrf,
        'content-type': 'application/octet-stream',
      },
      payload: randomBytes(9 * 1024 * 1024),
    });
    expect(tooBig.statusCode).toBe(413);
  });

  it('hapus butuh konfirmasi nama; notifikasi risiko ke admin; password tidak bocor ke audit/job/notifikasi', async () => {
    expect((await post('/drop', { name: dbName, confirm: 'salah' })).statusCode).toBe(400);
    expect((await post('/drop', { name: dbName, confirm: dbName })).statusCode).toBe(200);
    expect((await post('/users/drop', { name: userName, confirm: userName })).statusCode).toBe(200);
    const gone = await call(app, f.admin, 'GET', base());
    expect(gone.json().databases.some((d: { name: string }) => d.name === dbName)).toBe(false);
    expect(gone.json().users.some((u: { name: string }) => u.name === userName)).toBe(false);

    const dump = JSON.stringify([
      ctx.db.prepare('SELECT * FROM audit_logs').all(),
      ctx.db.prepare('SELECT * FROM notifications').all(),
      ctx.db.prepare('SELECT * FROM jobs').all(),
    ]);
    for (const s of secrets) expect(dump).not.toContain(s);
    expect(dump).toContain('db.drop_database');
    const note = ctx.db
      .prepare("SELECT 1 AS ok FROM notifications WHERE type = 'risky_action'")
      .get();
    expect(note).toBeTruthy();
  });

  it('client lain tidak bisa menyentuh database VM ini (404)', async () => {
    const other = await seedUser(built, 'luar-db@contoh.com');
    const c = await login(app, other);
    for (const p of ['', '/engines', '/export?database=abc'])
      expect((await call(app, c, 'GET', `${base()}${p}`)).statusCode, p).toBe(404);
    for (const p of ['', '/drop', '/users', '/query', '/grant', '/users/drop']) {
      expect(
        (
          await call(app, c, 'POST', `${base()}${p}`, {
            name: 'abc',
            confirm: 'abc',
            database: 'abc',
            sql: 'select 1',
            user: 'abc',
            level: 'all',
          })
        ).statusCode,
        p,
      ).toBe(404);
    }
  });
});
