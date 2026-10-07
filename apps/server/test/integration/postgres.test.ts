import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, login, makeApp, ORIGIN, seedUser } from '../helpers.js';
import { setupRealVm, vmAvailable, type VmFixture } from './vmFixture.js';

const built = await makeApp(false, { MAX_UPLOAD_MB: '8' });
const { app, ctx } = built;
let f: VmFixture;
const sfx = randomBytes(3).toString('hex');
const db = `pg_${sfx}`;
const usr = `pu_${sfx}`;
const ro = `pr_${sfx}`;
const secrets: string[] = [];

const psql = (user: string, pw: string, database: string, sql: string) =>
  execFileSync('psql', ['-h', '127.0.0.1', '-U', user, '-d', database, '-Atc', sql], {
    env: { ...process.env, PGPASSWORD: pw },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
const admin = (sql: string) =>
  execFileSync('runuser', ['-u', 'postgres', '--', 'psql', '-X', '-Atc', sql]).toString().trim();

beforeAll(async () => {
  if (vmAvailable) f = await setupRealVm(built, 'vm-pg', 'admin-pg@contoh.com');
});
afterAll(async () => {
  if (vmAvailable) {
    for (const n of [db, `${db}_b`]) await post('/drop', { name: n, confirm: n });
    for (const n of [usr, ro]) await post('/users/drop', { name: n, confirm: n });
  }
  await app.close();
});

const base = () => `/api/vms/${f.vmId}/databases`;
const q = '?engine=postgres';
const post = (p: string, body: unknown) => call(app, f.admin, 'POST', `${base()}${p}${q}`, body);
const get = (p: string) =>
  call(app, f.admin, 'GET', `${base()}${p}${p.includes('?') ? '&' : '?'}engine=postgres`);
const rawUpload = (path: string, data: Buffer) =>
  app.inject({
    method: 'POST',
    url: `${base()}${path}`,
    headers: {
      origin: ORIGIN,
      cookie: f.admin.cookie,
      'x-csrf-token': f.admin.csrf,
      'content-type': 'application/octet-stream',
    },
    payload: data,
  });

describe.skipIf(!vmAvailable)('database manager PostgreSQL (PG nyata)', () => {
  it('mendeteksi PostgreSQL dan MariaDB berdampingan; engine tidak valid ditolak', async () => {
    const r = (await call(app, f.admin, 'GET', `${base()}/engines`)).json().engines as {
      engine: string;
      flavor: string;
      version: string;
      managed: boolean;
    }[];
    expect(r.find((e) => e.engine === 'postgres')).toMatchObject({
      flavor: 'postgres',
      managed: true,
    });
    expect(r.find((e) => e.engine === 'postgres')!.version).toMatch(/^\d+/);
    expect(r.find((e) => e.engine === 'mysql')).toMatchObject({ flavor: 'mariadb', managed: true });
    expect((await call(app, f.admin, 'GET', `${base()}?engine=oracle`)).statusCode).toBe(400);
  });

  it('membuat database + user: kredensial valid via TCP, user menjadi pemilik, database tertutup untuk role lain', async () => {
    const r = await post('', { name: db, user: usr });
    expect(r.statusCode, r.body).toBe(200);
    const c = r.json().credentials as { password: string; envSnippet: string };
    secrets.push(c.password);
    expect(c.envSnippet).toContain('DB_CONNECTION=pgsql');
    expect(c.envSnippet).toContain('DB_PORT=5432');
    expect(
      psql(
        usr,
        c.password,
        db,
        "CREATE TABLE t (id int, v text); INSERT INTO t VALUES (1, 'a'); SELECT count(*) FROM t",
      )
        .split('\n')
        .pop(),
    ).toBe('1');

    const other = (await post('/users', { name: ro })).json().credentials as { password: string };
    secrets.push(other.password);
    expect(() => psql(ro, other.password, db, 'SELECT 1')).toThrow(); // PUBLIC dicabut dari CONNECT

    const list = (await get('')).json();
    expect(list.databases.map((d: { name: string }) => d.name)).toContain(db);
    expect(list.users.find((u: { name: string }) => u.name === usr).databases).toEqual([
      { name: db, level: 'all' },
    ]);
    expect(
      list.databases.some((d: { name: string }) =>
        ['postgres', 'template0', 'template1'].includes(d.name),
      ),
    ).toBe(false);
    expect(list.users.some((u: { name: string }) => u.name === 'postgres')).toBe(false);
  });

  it('menolak nama berbahaya/dicadangkan/duplikat', async () => {
    for (const name of [
      'a',
      'Besar',
      'postgres',
      'template0',
      'template1',
      'mysql',
      'root',
      'x"; DROP DATABASE y; --',
      "x'y",
      'ab c',
      '1abc',
    ]) {
      expect((await post('', { name })).statusCode, name).toBe(400);
    }
    expect((await post('', { name: db })).statusCode).toBe(409);
    expect((await post('/users', { name: usr })).statusCode).toBe(409);
  });

  it('hak akses: readonly bisa SELECT tapi tidak INSERT/CREATE; revoke menutup akses; all mengembalikan penuh', async () => {
    expect((await post('/grant', { user: ro, database: db, level: 'readonly' })).statusCode).toBe(
      200,
    );
    const pw = (await post('/users/password', { name: ro })).json().credentials.password as string;
    secrets.push(pw);
    expect(psql(ro, pw, db, 'SELECT count(*) FROM t')).toBe('1');
    expect(() => psql(ro, pw, db, "INSERT INTO t VALUES (2, 'b')")).toThrow();
    expect(() => psql(ro, pw, db, 'CREATE TABLE x (i int)')).toThrow();
    expect(
      (await get('')).json().users.find((u: { name: string }) => u.name === ro).databases,
    ).toEqual([{ name: db, level: 'readonly' }]);

    expect((await post('/revoke', { user: ro, database: db })).statusCode).toBe(200);
    expect(() => psql(ro, pw, db, 'SELECT 1')).toThrow();
    expect((await post('/revoke', { user: ro, database: db })).statusCode).toBe(200); // idempoten

    // beralih level: all -> readonly mencabut kepemilikan database dari usr
    expect((await post('/grant', { user: usr, database: db, level: 'readonly' })).statusCode).toBe(
      200,
    );
    expect(
      (await get('')).json().users.find((u: { name: string }) => u.name === usr).databases,
    ).toEqual([{ name: db, level: 'readonly' }]);
    expect(
      admin(
        `SELECT r.rolname FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE datname = '${db}'`,
      ),
    ).toBe('postgres');
    expect((await post('/grant', { user: usr, database: db, level: 'all' })).statusCode).toBe(200);
    expect(
      admin(
        `SELECT r.rolname FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE datname = '${db}'`,
      ),
    ).toBe(usr);
    expect(
      (await post('/grant', { user: 'tidak_ada', database: db, level: 'all' })).statusCode,
    ).toBe(404);
  });

  it('reset password mengganti kredensial lama', async () => {
    const old = secrets[0]!;
    const fresh = (await post('/users/password', { name: usr })).json().credentials
      .password as string;
    secrets.push(fresh);
    expect(psql(usr, fresh, db, 'SELECT 1')).toBe('1');
    expect(() => psql(usr, old, db, 'SELECT 1')).toThrow();
  });

  it('query editor: CSV dengan koma/kutip/baris baru, NULL, error informatif, hasil besar dipotong', async () => {
    const qr = (sql: string, database: string | null = db) => post('/query', { database, sql });
    expect(
      (await qr("INSERT INTO t VALUES (2, 'b,\"c\"'), (3, E'baris1\\nbaris2'), (4, NULL)"))
        .statusCode,
    ).toBe(200);
    const sel = (await qr('SELECT id, v FROM t ORDER BY id')).json();
    expect(sel.columns).toEqual(['id', 'v']);
    expect(sel.rows).toEqual([
      ['1', 'a'],
      ['2', 'b,"c"'],
      ['3', 'baris1\nbaris2'],
      ['4', ''],
    ]);
    const bad = await qr('SELEKT 1');
    expect(bad.statusCode).toBe(422);
    expect(bad.json().message).toContain('Server PostgreSQL menolak perintah');
    expect((await qr('SELECT 1', 'postgres')).statusCode).toBe(400);
    const big = (await qr("SELECT repeat('x', 1000) AS c FROM generate_series(1, 4000)")).json();
    expect(big.truncated).toBe(true);
    expect(big.rows.length).toBeLessThan(4000);
  });

  it(
    'import SQL besar via stream: objek dimiliki pemilik database; export berisi data',
    { timeout: 60_000 },
    async () => {
      const b = `${db}_b`;
      expect((await post('', { name: b, user: undefined })).statusCode).toBe(200);
      expect((await post('/grant', { user: usr, database: b, level: 'all' })).statusCode).toBe(200);
      const lines = ['CREATE TABLE big (id int, v varchar(100));'];
      for (let i = 0; i < 20000; i += 500)
        lines.push(
          `INSERT INTO big VALUES ${Array.from({ length: 500 }, (_, k) => `(${i + k}, 'baris-${i + k}-${'x'.repeat(50)}')`).join(',')};`,
        );
      const sql = Buffer.from(lines.join('\n'));
      expect(sql.length).toBeGreaterThan(1024 * 1024);
      const imp = await rawUpload(`/import?database=${b}&engine=postgres`, sql);
      expect(imp.statusCode, imp.body).toBe(200);
      expect(
        (await post('/query', { database: b, sql: 'SELECT count(*) FROM big' })).json().rows[0][0],
      ).toBe('20000');
      expect(
        execFileSync('runuser', [
          '-u',
          'postgres',
          '--',
          'psql',
          '-X',
          '-d',
          b,
          '-Atc',
          "SELECT tableowner FROM pg_tables WHERE tablename = 'big'",
        ])
          .toString()
          .trim(),
      ).toBe(usr);
    },
  );

  it('export berisi struktur dan data tanpa OWNER', async () => {
    const b = `${db}_b`;
    const exp = await get(`/export?database=${b}`);
    expect(exp.statusCode).toBe(200);
    expect(exp.headers['content-disposition']).toContain(`${b}-`);
    expect(exp.body).toContain('CREATE TABLE public.big');
    expect(exp.body).toContain('baris-19999-');
    expect(exp.body).not.toMatch(/OWNER TO/);
  });

  it('import yang gagal melaporkan error; file terlalu besar ditolak', async () => {
    const b = `${db}_b`;
    const bad = await rawUpload(
      `/import?database=${b}&engine=postgres`,
      Buffer.from('INSERT INTO tabel_tidak_ada VALUES (1);'),
    );
    expect(bad.statusCode).toBe(422);
    expect(
      (await rawUpload(`/import?database=${b}&engine=postgres`, randomBytes(9 * 1024 * 1024)))
        .statusCode,
    ).toBe(413);
    expect(
      (await rawUpload(`/import?database=tidak_ada&engine=postgres`, Buffer.from('SELECT 1;')))
        .statusCode,
    ).toBe(404);
  });

  it('hapus user yang memiliki database dan tabel berhasil; hapus database dengan koneksi aktif berhasil', async () => {
    expect((await post('/drop', { name: db, confirm: 'salah' })).statusCode).toBe(400);
    const pw = secrets[secrets.length - 1]!;
    // koneksi aktif ke database
    const holder = spawn(
      'psql',
      ['-h', '127.0.0.1', '-U', usr, '-d', db, '-c', 'SELECT pg_sleep(30)'],
      { env: { ...process.env, PGPASSWORD: pw }, stdio: 'ignore' },
    );
    await new Promise((r) => setTimeout(r, 800));
    expect((await post('/drop', { name: db, confirm: db })).statusCode).toBe(200);
    holder.kill();
    // usr masih pemilik database _b + tabel big
    expect((await post('/users/drop', { name: usr, confirm: 'salah' })).statusCode).toBe(400);
    expect((await post('/users/drop', { name: usr, confirm: usr })).statusCode).toBe(200);
    const list = (await get('')).json();
    expect(list.users.some((u: { name: string }) => u.name === usr)).toBe(false);
    expect(list.databases.some((d: { name: string }) => d.name === `${db}_b`)).toBe(true); // database tetap ada, dimiliki postgres
    expect(
      admin(
        `SELECT r.rolname FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE datname = '${db}_b'`,
      ),
    ).toBe('postgres');
    expect((await post('/users/drop', { name: usr, confirm: usr })).statusCode).toBe(200); // idempoten
  });

  it('password tidak bocor ke audit/notifikasi/job; client lain 404', async () => {
    const dump = JSON.stringify([
      ctx.db.prepare('SELECT * FROM audit_logs').all(),
      ctx.db.prepare('SELECT * FROM notifications').all(),
      ctx.db.prepare('SELECT * FROM jobs').all(),
    ]);
    for (const s of secrets) expect(dump).not.toContain(s);
    const other = await login(app, await seedUser(built, 'luar-pg@contoh.com'));
    expect((await call(app, other, 'GET', `${base()}?engine=postgres`)).statusCode).toBe(404);
    expect(
      (
        await call(app, other, 'POST', `${base()}/query?engine=postgres`, {
          database: db,
          sql: 'select 1',
        })
      ).statusCode,
    ).toBe(404);
  });
});
