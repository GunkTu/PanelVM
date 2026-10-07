import type { Readable } from 'node:stream';
import type { Client as SshClient } from 'ssh2';
import { AppError } from '../../errors.js';
import { execRemote, spawnRemote, type ExecOptions } from '../../ssh/exec.js';
import type { DbDriver, DbInfo, DbUserInfo, EngineInfo, PrivLevel, QueryResult } from './types.js';
import { IDENT, RESERVED_NAMES } from './validate.js';

const QUERY_MAX_BYTES = 2 * 1024 * 1024;
const TAB = '\t';
const IDENT_PG = '^[a-z][a-z0-9_]{2,31}$';

/** Literal string SQL standar (standard_conforming_strings=on, bawaan PG >= 9.1): hanya ' yang digandakan. */
export const pgString = (v: string): string => {
  if (v.includes('\0')) throw new Error('String SQL tidak boleh memuat NUL');
  return `'${v.replace(/'/g, "''")}'`;
};
/** Identifier PG dikutip dengan " (hanya setelah lolos IDENT, jadi tidak ada " di dalamnya). */
export const pgIdent = (name: string): string => {
  if (!IDENT.test(name)) throw new Error('Identifier tidak valid');
  return `"${name}"`;
};

/** Parser CSV RFC 4180 (keluaran `psql --csv`): kutip ganda, koma, dan baris baru di dalam nilai. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function pgError(stderr: string): AppError {
  const e = stderr.trim();
  const line = /ERROR:\s*(.*)/.exec(e)?.[1]?.slice(0, 240) ?? e.split('\n')[0]?.slice(0, 240) ?? '';
  if (
    /could not connect|Connection refused|No such file or directory|is the server running/i.test(e)
  ) {
    return new AppError(
      502,
      'db_not_running',
      'Server PostgreSQL di VM belum berjalan. Jalankan lewat terminal (systemctl start postgresql), lalu coba lagi.',
    );
  }
  if (/user postgres does not exist|runuser: .*postgres/i.test(e)) {
    return new AppError(
      409,
      'db_no_postgres_user',
      'User sistem "postgres" tidak ada di VM, jadi PostgreSQL belum terpasang dengan benar. Pasang lewat menu Aplikasi.',
    );
  }
  if (/already exists/i.test(e))
    return new AppError(
      409,
      'db_exists',
      'Nama itu sudah ada di server PostgreSQL. Pilih nama lain.',
    );
  if (/database ".*" does not exist/i.test(e))
    return new AppError(404, 'db_unknown', 'Database tidak ditemukan. Muat ulang daftar database.');
  if (/role ".*" does not exist/i.test(e))
    return new AppError(
      404,
      'db_user_missing',
      'User database tidak ditemukan. Muat ulang daftar.',
    );
  if (/cannot be dropped because some objects depend on it/i.test(e))
    return new AppError(
      409,
      'db_user_busy',
      'User masih memiliki objek di database. Cabut aksesnya atau hapus database terkait dulu.',
    );
  if (/command not found|not found/i.test(e))
    return new AppError(
      409,
      'db_not_installed',
      'Klien PostgreSQL (psql) belum terpasang di VM. Pasang lewat menu Aplikasi.',
    );
  return new AppError(
    422,
    'db_error',
    `Server PostgreSQL menolak perintah: ${line || 'tanpa pesan'}.`,
  );
}

/**
 * Driver PostgreSQL. Perintah dijalankan sebagai user sistem `postgres` lewat `runuser` (peer auth),
 * SQL lewat stdin; tidak ada password di argumen proses. Model akses panel:
 *  - "all"      = pemilik database (ALTER DATABASE ... OWNER TO user)
 *  - "readonly" = CONNECT + USAGE schema public + SELECT pada tabel/sequence yang ADA saat ini
 * Objek yang dibuat user sendiri tetap miliknya meski aksesnya dicabut.
 */
export class PostgresDriver implements DbDriver {
  constructor(
    private readonly ssh: SshClient,
    private readonly opts: Pick<ExecOptions, 'sudo'>,
  ) {}

  private base(database: string, extra: string[] = []): string[] {
    return [
      'runuser',
      '-u',
      'postgres',
      '--',
      'psql',
      '-X',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-d',
      database,
      ...extra,
    ];
  }

  private async run(
    sql: string,
    o: { database?: string; csv?: boolean; maxBytes?: number; timeoutMs?: number } = {},
  ) {
    const fmt = o.csv ? ['--csv'] : ['-A', '-t', '-F', TAB];
    const r = await execRemote(this.ssh, this.base(o.database ?? 'postgres', fmt), {
      ...this.opts,
      stdin: sql,
      timeoutMs: o.timeoutMs ?? 30_000,
      maxBytes: o.maxBytes,
    });
    if (r.code !== 0) throw pgError(r.stderr);
    return r;
  }

  private rows = (text: string): string[][] =>
    text
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => l.split(TAB));

  async info(): Promise<EngineInfo> {
    const ver = await execRemote(
      this.ssh,
      ['sh', '-c', 'command -v psql >/dev/null 2>&1 && psql --version'],
      this.opts,
    );
    if (ver.code !== 0)
      return {
        engine: 'postgres',
        flavor: 'postgres',
        version: '',
        running: false,
        managed: false,
        problem: 'Belum terpasang.',
      };
    const version = /(\d+(?:\.\d+)*)/.exec(ver.stdout)?.[1] ?? ver.stdout.trim().slice(0, 40);
    try {
      await this.run('SELECT 1');
      return { engine: 'postgres', flavor: 'postgres', version, running: true, managed: true };
    } catch (e) {
      const err = e instanceof AppError ? e : null;
      return {
        engine: 'postgres',
        flavor: 'postgres',
        version,
        running: err?.code !== 'db_not_running',
        managed: false,
        problem: err?.message ?? 'Tidak bisa terhubung.',
      };
    }
  }

  async listDatabases(): Promise<DbInfo[]> {
    const r = await this.run(
      "SELECT datname, pg_database_size(datname) FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY datname;",
    );
    return this.rows(r.stdout).map(([name, size]) => ({
      name: name!,
      sizeBytes: Number(size ?? 0),
    }));
  }

  async listUsers(): Promise<DbUserInfo[]> {
    const reserved = [...RESERVED_NAMES].map((n) => `'${n}'`).join(',');
    const users = await this.run(
      `SELECT rolname FROM pg_roles WHERE rolcanlogin AND NOT rolsuper AND rolname ~ '${IDENT_PG}' AND rolname NOT IN (${reserved}) ORDER BY rolname;`,
    );
    const grants = await this.run(
      `SELECT r.rolname, d.datname, CASE WHEN d.datdba = r.oid THEN 'owner' ELSE 'connect' END FROM pg_roles r JOIN pg_database d ON (NOT d.datistemplate AND d.datname <> 'postgres' AND (d.datdba = r.oid OR EXISTS (SELECT 1 FROM aclexplode(d.datacl) a WHERE a.grantee = r.oid AND a.privilege_type = 'CONNECT'))) WHERE r.rolcanlogin AND NOT r.rolsuper AND r.rolname ~ '${IDENT_PG}' ORDER BY 1, 2;`,
    );
    const g = this.rows(grants.stdout);
    return this.rows(users.stdout).map(([name]) => ({
      name: name!,
      databases: g
        .filter((x) => x[0] === name)
        .map((x) => ({
          name: x[1]!,
          level: (x[2] === 'owner' ? 'all' : 'readonly') as 'all' | 'readonly',
        })),
    }));
  }

  async createDatabase(name: string): Promise<void> {
    await this.run(
      `CREATE DATABASE ${pgIdent(name)} TEMPLATE template0 ENCODING 'UTF8';\nREVOKE ALL ON DATABASE ${pgIdent(name)} FROM PUBLIC;`,
    );
  }

  async dropDatabase(name: string): Promise<void> {
    await this.run(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${pgString(name)} AND pid <> pg_backend_pid();\nDROP DATABASE ${pgIdent(name)};`,
    );
  }

  async createUser(name: string, password: string): Promise<void> {
    await this.run(
      `CREATE ROLE ${pgIdent(name)} LOGIN PASSWORD ${pgString(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE;`,
    );
  }

  async dropUser(name: string): Promise<void> {
    const exists = await this.run(`SELECT 1 FROM pg_roles WHERE rolname = ${pgString(name)};`);
    if (!exists.stdout.trim()) return;
    // Pindahkan kepemilikan ke postgres dan buang hak di SETIAP database, baru role bisa dihapus.
    const dbs = (
      await this.run('SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn;')
    ).stdout
      .split('\n')
      .filter(Boolean);
    for (const d of dbs)
      await this.run(
        `REASSIGN OWNED BY ${pgIdent(name)} TO postgres;\nDROP OWNED BY ${pgIdent(name)};`,
        { database: d },
      );
    await this.run(`DROP ROLE ${pgIdent(name)};`);
  }

  async setPassword(name: string, password: string): Promise<void> {
    await this.run(`ALTER ROLE ${pgIdent(name)} PASSWORD ${pgString(password)};`);
  }

  /** Dijalankan DI DALAM database target: cabut hak tabel yang BUKAN milik user (agar hak pemilik tidak ikut terhapus). */
  private revokeInDb(user: string): string {
    return `DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT format('REVOKE ALL ON %I.%I FROM %I', n.nspname, c.relname, ${pgString(user)}) AS cmd
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f')
             AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = ${pgString(user)})
  LOOP EXECUTE r.cmd; END LOOP;
END $$;
REVOKE ALL ON SCHEMA public FROM ${pgIdent(user)};`;
  }

  async revoke(user: string, database: string): Promise<void> {
    const own = await this.run(
      `SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = ${pgString(database)} AND r.rolname = ${pgString(user)};`,
    );
    if (own.stdout.trim()) await this.run(`ALTER DATABASE ${pgIdent(database)} OWNER TO postgres;`);
    await this.run(`REVOKE ALL ON DATABASE ${pgIdent(database)} FROM ${pgIdent(user)};`);
    await this.run(this.revokeInDb(user), { database });
  }

  async grant(user: string, database: string, level: PrivLevel): Promise<void> {
    await this.revoke(user, database); // level baru menggantikan, bukan menambah
    if (level === 'all') {
      await this.run(`ALTER DATABASE ${pgIdent(database)} OWNER TO ${pgIdent(user)};`);
      return;
    }
    await this.run(`GRANT CONNECT ON DATABASE ${pgIdent(database)} TO ${pgIdent(user)};`);
    await this.run(
      `GRANT USAGE ON SCHEMA public TO ${pgIdent(user)};\nGRANT SELECT ON ALL TABLES IN SCHEMA public TO ${pgIdent(user)};\nGRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${pgIdent(user)};`,
      { database },
    );
  }

  async query(database: string | null, sql: string): Promise<QueryResult> {
    const r = await this.run(sql, {
      database: database ?? undefined,
      csv: true,
      maxBytes: QUERY_MAX_BYTES,
      timeoutMs: 60_000,
    });
    let out = r.stdout;
    if (r.truncated) out = out.slice(0, out.lastIndexOf('\n') + 1);
    const rows = parseCsv(out);
    return { columns: rows[0] ?? [], rows: rows.slice(1), truncated: r.truncated };
  }

  async importSql(database: string, input: Readable): Promise<void> {
    // Objek hasil import dimiliki pemilik database (bukan postgres) agar aplikasinya bisa memakainya.
    const owner = (
      await this.run(
        `SELECT r.rolname FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = ${pgString(database)};`,
      )
    ).stdout.trim();
    const setRole =
      owner && owner !== 'postgres' && IDENT.test(owner)
        ? ['-c', `SET ROLE ${pgIdent(owner)}`]
        : [];
    const { done } = await spawnRemote(this.ssh, this.base(database, [...setRole, '-f', '-']), {
      ...this.opts,
      stdin: input,
      timeoutMs: 60 * 60_000,
    });
    const r = await done;
    if (r.code !== 0) throw pgError(r.stderr);
  }

  async exportSql(database: string): Promise<{ stream: Readable; done: Promise<void> }> {
    const { channel, done } = await spawnRemote(
      this.ssh,
      [
        'runuser',
        '-u',
        'postgres',
        '--',
        'pg_dump',
        '--no-owner',
        '--no-privileges',
        '--encoding=UTF8',
        '--',
        database,
      ],
      { ...this.opts, onStdout: () => {}, timeoutMs: 6 * 60 * 60_000 },
    );
    channel.removeAllListeners('data');
    return {
      stream: channel as unknown as Readable,
      done: done.then((r) => {
        if (r.code !== 0) throw pgError(r.stderr);
      }),
    };
  }
}
