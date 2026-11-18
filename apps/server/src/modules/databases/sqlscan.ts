/**
 * Pemindai SQL sederhana untuk PERINGATAN sebelum impor (bukan penyaring keamanan; client sudah root di VM-nya).
 * Mendeteksi pernyataan yang menghapus data atau berpindah database, yang sering ada di schema.sql dan
 * berbahaya bila dijalankan ulang di produksi. Komentar SQL (baris "--", baris "#", dan blok) tidak ikut dipindai.
 */
export type SqlRisk = 'drop_database' | 'drop_table' | 'truncate' | 'create_database' | 'use';

export const RISK_LABEL: Record<SqlRisk, string> = {
  drop_database: 'DROP DATABASE (menghapus seluruh database)',
  drop_table: 'DROP TABLE (menghapus tabel beserta isinya)',
  truncate: 'TRUNCATE (mengosongkan tabel)',
  create_database: 'CREATE DATABASE (membuat database lain)',
  use: 'USE (berpindah ke database lain)',
};

const PATTERNS: [SqlRisk, RegExp][] = [
  ['drop_database', /\bDROP\s+(?:DATABASE|SCHEMA)\b[^;]*/gi],
  ['drop_table', /\bDROP\s+TABLE\b[^;]*/gi],
  ['truncate', /\bTRUNCATE\b[^;]*/gi],
  ['create_database', /\bCREATE\s+(?:DATABASE|SCHEMA)\b[^;]*/gi],
  ['use', /(?:^|;)\s*USE\s+[^;\n]+/gi],
];

const stripComments = (sql: string): string =>
  sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\n)\s*(?:--|#)[^\n]*/g, '$1');

export interface SqlFinding {
  risk: SqlRisk;
  /** Cuplikan pernyataan (dipotong) untuk ditampilkan ke pengguna. */
  snippet: string;
}

/** Cari pernyataan berisiko di potongan teks SQL. Setiap jenis dilaporkan paling banyak `perRisk` kali. */
export function scanSql(sql: string, perRisk = 2): SqlFinding[] {
  const text = stripComments(sql);
  const out: SqlFinding[] = [];
  for (const [risk, re] of PATTERNS) {
    re.lastIndex = 0;
    let n = 0;
    for (const m of text.matchAll(re)) {
      out.push({
        risk,
        snippet: m[0].replace(/^;\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 100),
      });
      if (++n >= perRisk) break;
    }
  }
  return out;
}

/** Pemindai bertahap untuk aliran data besar: sisa akhir tiap potongan dibawa agar pernyataan terbelah tetap terdeteksi. */
export class SqlScanner {
  private tail = '';
  private readonly risks = new Set<SqlRisk>();
  private readonly found: SqlFinding[] = [];

  push(chunk: string): void {
    const text = this.tail + chunk;
    for (const f of scanSql(text, 1)) {
      if (!this.risks.has(f.risk)) {
        this.risks.add(f.risk);
        this.found.push(f);
      }
    }
    this.tail = text.slice(-300);
  }
  result(): { risks: SqlRisk[]; findings: SqlFinding[] } {
    return { risks: [...this.risks], findings: this.found };
  }
}
