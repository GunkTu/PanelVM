import type { Readable } from 'node:stream';

export type Engine = 'mysql' | 'postgres';
export type PrivLevel = 'all' | 'readonly';

export interface EngineInfo {
  engine: Engine;
  /** mysql = MySQL Oracle, mariadb = MariaDB. Panel tidak berasumsi, hasil deteksi dari VM. */
  flavor: 'mysql' | 'mariadb' | 'postgres';
  version: string;
  running: boolean;
  /** Pesan bila terpasang tapi tidak bisa dikelola panel (mis. root butuh password). */
  problem?: string;
  managed: boolean;
}

export interface DbInfo {
  name: string;
  sizeBytes: number;
}

export interface DbUserInfo {
  name: string;
  databases: { name: string; level: PrivLevel | 'custom' }[];
}

export interface QueryResult {
  columns: string[];
  rows: string[][];
  truncated: boolean;
}

/** Antarmuka per engine. v1: MysqlDriver (MySQL/MariaDB). PostgresDriver menyusul di Fase 3. */
export interface DbDriver {
  info(): Promise<EngineInfo>;
  listDatabases(): Promise<DbInfo[]>;
  listUsers(): Promise<DbUserInfo[]>;
  createDatabase(name: string): Promise<void>;
  dropDatabase(name: string): Promise<void>;
  createUser(name: string, password: string): Promise<void>;
  dropUser(name: string): Promise<void>;
  setPassword(name: string, password: string): Promise<void>;
  grant(user: string, database: string, level: PrivLevel): Promise<void>;
  revoke(user: string, database: string): Promise<void>;
  query(database: string | null, sql: string): Promise<QueryResult>;
  importSql(database: string, input: Readable, onDone?: () => void): Promise<void>;
  /** Stream dump SQL. `done` selesai dengan error bila perintah dump gagal. */
  exportSql(database: string): Promise<{ stream: Readable; done: Promise<void> }>;
}
