import type { Readable } from 'node:stream';
import type { Client as SshClient } from 'ssh2';
import { AppError } from '../../errors.js';
import { execRemote, spawnRemote, type ExecOptions } from '../../ssh/exec.js';
import type { DbDriver, DbInfo, DbUserInfo, EngineInfo, PrivLevel, QueryResult } from './types.js';
import { SYSTEM_DATABASES, sqlIdent, sqlString } from './validate.js';

const HOSTS = ['localhost', '127.0.0.1'] as const;
const QUERY_MAX_BYTES = 2 * 1024 * 1024;
const MANAGEABLE_USER = '^[a-z][a-z0-9_]{2,31}$';
const SYSTEM_USERS = ['root', 'mysql', 'mariadb.sys', 'debian-sys-maint'];

/** Unescape format --batch MySQL: \t \n \\ \0. */
export function unescapeBatch(v: string): string {
  return v.replace(/\\([tn0\\])/g, (_m, c: string) =>
    c === 't' ? '\t' : c === 'n' ? '\n' : c === '0' ? '\0' : '\\',
  );
}

export function parseTsv(text: string, hasHeader: boolean): QueryResult {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const cells = lines.map((l) => l.split('\t').map(unescapeBatch));
  if (!hasHeader) return { columns: [], rows: cells, truncated: false };
  return { columns: cells[0] ?? [], rows: cells.slice(1), truncated: false };
}

/** Terjemahkan error klien mysql/mariadb menjadi pesan yang bisa ditindaklanjuti. */
export function mysqlError(stderr: string): AppError {
  const e = stderr.trim();
  if (/Can't connect to local|Can't connect to MySQL server|No such file or directory/i.test(e)) {
    return new AppError(
      502,
      'db_not_running',
      'Server database di VM belum berjalan. Jalankan lewat terminal (systemctl start mariadb atau mysql), lalu coba lagi.',
    );
  }
  if (/Access denied for user 'root'/i.test(e)) {
    return new AppError(
      502,
      'db_root_denied',
      'Panel tidak bisa masuk sebagai root database lewat socket (root DB memakai password). Atur root memakai unix_socket/auth_socket, atau hubungi admin panel.',
    );
  }
  if (/already exists/i.test(e))
    return new AppError(
      409,
      'db_exists',
      'Nama itu sudah ada di server database. Pilih nama lain.',
    );
  if (/database exists/i.test(e))
    return new AppError(409, 'db_exists', 'Database dengan nama itu sudah ada. Pilih nama lain.');
  if (/Unknown database/i.test(e))
    return new AppError(404, 'db_unknown', 'Database tidak ditemukan. Muat ulang daftar database.');
  if (/Operation CREATE USER failed|Operation DROP USER failed/i.test(e))
    return new AppError(
      409,
      'db_user_op',
      'Operasi user gagal: user sudah ada atau tidak ditemukan. Muat ulang daftar lalu coba lagi.',
    );
  if (/command not found|not found/i.test(e))
    return new AppError(
      409,
      'db_not_installed',
      'Klien MySQL/MariaDB belum terpasang di VM. Pasang database lewat menu Aplikasi.',
    );
  const first = e.split('\n')[0]?.slice(0, 240) ?? '';
  return new AppError(
    422,
    'db_error',
    `Server database menolak perintah: ${first || 'tanpa pesan'}.`,
  );
}

interface Tools {
  client: 'mariadb' | 'mysql';
  dump: string;
}

export class MysqlDriver implements DbDriver {
  private tools?: Promise<Tools | null>;
  constructor(
    private readonly ssh: SshClient,
    private readonly opts: Pick<ExecOptions, 'sudo'>,
  ) {}

  /** Cari biner klien yang tersedia di VM (jangan berasumsi mysql vs mariadb). */
  private detectTools(): Promise<Tools | null> {
    this.tools ??= execRemote(
      this.ssh,
      [
        'sh',
        '-c',
        'for c in mariadb mysql mariadb-dump mysqldump; do command -v "$c" >/dev/null 2>&1 && echo "$c"; done',
      ],
      this.opts,
    ).then((r) => {
      const found = new Set(
        r.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      );
      const client = found.has('mariadb') ? 'mariadb' : found.has('mysql') ? 'mysql' : null;
      if (!client) return null;
      const dump = found.has('mariadb-dump')
        ? 'mariadb-dump'
        : found.has('mysqldump')
          ? 'mysqldump'
          : '';
      return { client, dump };
    });
    return this.tools;
  }

  private async cli(): Promise<Tools> {
    const t = await this.detectTools();
    if (!t)
      throw new AppError(
        409,
        'db_not_installed',
        'MySQL/MariaDB belum terpasang di VM ini. Pasang lewat menu Aplikasi terlebih dulu.',
      );
    return t;
  }

  /** Jalankan SQL lewat stdin (tidak pernah lewat argumen perintah). */
  private async run(
    sql: string,
    o: { database?: string; header?: boolean; maxBytes?: number; timeoutMs?: number } = {},
  ) {
    const t = await this.cli();
    const argv = [
      t.client,
      '--batch',
      '--default-character-set=utf8mb4',
      '--connect-timeout=5',
      ...(o.header ? [] : ['--skip-column-names']),
    ];
    if (o.database) argv.push(`--database=${o.database}`);
    const r = await execRemote(this.ssh, argv, {
      ...this.opts,
      stdin: sql,
      timeoutMs: o.timeoutMs ?? 30_000,
      maxBytes: o.maxBytes,
    });
    if (r.code !== 0) throw mysqlError(r.stderr);
    return r;
  }

  async info(): Promise<EngineInfo> {
    const t = await this.detectTools();
    if (!t)
      return {
        engine: 'mysql',
        flavor: 'mysql',
        version: '',
        running: false,
        managed: false,
        problem: 'Belum terpasang.',
      };
    const ver = await execRemote(this.ssh, [t.client, '--version'], this.opts);
    const text = ver.stdout.trim();
    const flavor = /mariadb/i.test(text) ? 'mariadb' : 'mysql';
    const version =
      /(\d+\.\d+\.\d+)(?:-MariaDB)?/i.exec(text.replace(/Ver \d+\.\d+ Distrib /, ''))?.[1] ??
      text.slice(0, 60);
    try {
      await this.run('SELECT 1');
      return { engine: 'mysql', flavor, version, running: true, managed: true };
    } catch (e) {
      const err = e instanceof AppError ? e : null;
      return {
        engine: 'mysql',
        flavor,
        version,
        running: err?.code !== 'db_not_running' ? true : false,
        managed: false,
        problem: err?.message ?? 'Tidak bisa terhubung.',
      };
    }
  }

  async listDatabases(): Promise<DbInfo[]> {
    const sys = SYSTEM_DATABASES.map((d) => sqlString(d)).join(',');
    const r = await this.run(
      `SELECT s.schema_name, COALESCE(SUM(t.data_length + t.index_length), 0) FROM information_schema.schemata s LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name WHERE s.schema_name NOT IN (${sys}) GROUP BY s.schema_name ORDER BY s.schema_name`,
    );
    return parseTsv(r.stdout, false).rows.map(([name, size]) => ({
      name: name!,
      sizeBytes: Number(size ?? 0),
    }));
  }

  async listUsers(): Promise<DbUserInfo[]> {
    const hosts = HOSTS.map((h) => sqlString(h)).join(',');
    const sysUsers = SYSTEM_USERS.map((u) => sqlString(u)).join(',');
    const users = await this.run(
      `SELECT DISTINCT User FROM mysql.user WHERE Host IN (${hosts}) AND User REGEXP ${sqlString(MANAGEABLE_USER)} AND User NOT IN (${sysUsers}) ORDER BY User`,
    );
    const dbs = await this.run(
      `SELECT User, Db, Select_priv, Insert_priv, Update_priv, Delete_priv, Create_priv, Drop_priv, Alter_priv FROM mysql.db WHERE Host IN (${hosts})`,
    );
    const grants = parseTsv(dbs.stdout, false).rows;
    return parseTsv(users.stdout, false).rows.map(([name]) => ({
      name: name!,
      databases: grants
        .filter(
          (g, i, all) =>
            g[0] === name && all.findIndex((o) => o[0] === g[0] && o[1] === g[1]) === i,
        )
        .map((g) => {
          const privs = g.slice(2);
          const level: 'all' | 'readonly' | 'custom' = privs.every((p) => p === 'Y')
            ? 'all'
            : privs[0] === 'Y' && privs.slice(1).every((p) => p === 'N')
              ? 'readonly'
              : 'custom';
          return { name: g[1]!.replace(/\\_/g, '_'), level };
        }),
    }));
  }

  async createDatabase(name: string): Promise<void> {
    await this.run(
      `CREATE DATABASE ${sqlIdent(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  }

  async dropDatabase(name: string): Promise<void> {
    await this.run(`DROP DATABASE ${sqlIdent(name)}`);
  }

  async createUser(name: string, password: string): Promise<void> {
    const sql = HOSTS.map(
      (h) => `CREATE USER ${sqlString(name)}@${sqlString(h)} IDENTIFIED BY ${sqlString(password)};`,
    ).join('\n');
    await this.run(sql);
  }

  async dropUser(name: string): Promise<void> {
    await this.run(
      HOSTS.map((h) => `DROP USER IF EXISTS ${sqlString(name)}@${sqlString(h)};`).join('\n'),
    );
  }

  async setPassword(name: string, password: string): Promise<void> {
    await this.run(
      HOSTS.map(
        (h) =>
          `ALTER USER ${sqlString(name)}@${sqlString(h)} IDENTIFIED BY ${sqlString(password)};`,
      ).join('\n'),
    );
  }

  async grant(user: string, database: string, level: PrivLevel): Promise<void> {
    // Cabut hak lama dulu: GRANT bersifat menambah, jadi tanpa ini "readonly" tidak mengurangi "all".
    await this.revoke(user, database);
    const priv = level === 'all' ? 'ALL PRIVILEGES' : 'SELECT';
    await this.run(
      HOSTS.map(
        (h) => `GRANT ${priv} ON ${sqlIdent(database)}.* TO ${sqlString(user)}@${sqlString(h)};`,
      ).join('\n') + '\nFLUSH PRIVILEGES;',
    );
  }

  /** Idempoten: hanya mencabut host yang memang punya hak di database itu (REVOKE error bila tidak ada). */
  async revoke(user: string, database: string): Promise<void> {
    const hosts = HOSTS.map((h) => sqlString(h)).join(',');
    const forms = [database, database.replace(/_/g, '\\_')].map((d) => sqlString(d)).join(',');
    const r = await this.run(
      `SELECT Host FROM mysql.db WHERE User = ${sqlString(user)} AND Db IN (${forms}) AND Host IN (${hosts})`,
    );
    const have = parseTsv(r.stdout, false).rows.map((row) => row[0]!);
    if (have.length === 0) return;
    await this.run(
      have
        .map(
          (h) =>
            `REVOKE ALL PRIVILEGES ON ${sqlIdent(database)}.* FROM ${sqlString(user)}@${sqlString(h)};`,
        )
        .join('\n') + '\nFLUSH PRIVILEGES;',
    );
  }

  async query(database: string | null, sql: string): Promise<QueryResult> {
    const r = await this.run(sql, {
      database: database ?? undefined,
      header: true,
      maxBytes: QUERY_MAX_BYTES,
      timeoutMs: 60_000,
    });
    let out = r.stdout;
    if (r.truncated) out = out.slice(0, out.lastIndexOf('\n') + 1);
    return { ...parseTsv(out, true), truncated: r.truncated };
  }

  async importSql(database: string, input: Readable): Promise<void> {
    const t = await this.cli();
    const { done } = await spawnRemote(
      this.ssh,
      [t.client, '--batch', '--default-character-set=utf8mb4', `--database=${database}`],
      { ...this.opts, stdin: input, timeoutMs: 60 * 60_000 },
    );
    const r = await done;
    if (r.code !== 0) throw mysqlError(r.stderr);
  }

  async exportSql(database: string): Promise<{ stream: Readable; done: Promise<void> }> {
    const t = await this.cli();
    if (!t.dump)
      throw new AppError(
        409,
        'dump_missing',
        'Perintah dump (mysqldump/mariadb-dump) tidak ada di VM. Pasang paket klien database lewat menu Aplikasi.',
      );
    const { channel, done } = await spawnRemote(
      this.ssh,
      [
        t.dump,
        '--single-transaction',
        '--routines',
        '--triggers',
        '--events',
        '--default-character-set=utf8mb4',
        '--',
        database,
      ],
      { ...this.opts, onStdout: () => {}, timeoutMs: 6 * 60 * 60_000 },
    );
    // onStdout kosong agar `data` tidak diserap; channel dialirkan langsung ke pemanggil.
    channel.removeAllListeners('data');
    return {
      stream: channel as unknown as Readable,
      done: done.then((r) => {
        if (r.code !== 0) throw mysqlError(r.stderr);
      }),
    };
  }
}
