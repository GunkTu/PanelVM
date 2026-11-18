/**
 * Peringatan sebelum impor SQL: mendeteksi pernyataan yang menghapus data atau berpindah database.
 * Salinan dari apps/server/src/modules/databases/sqlscan.ts (server memakainya untuk audit); ini hanya
 * bantuan agar pengguna tidak tak sengaja menjalankan DROP DATABASE di produksi, bukan batas keamanan.
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
  snippet: string;
}

export function scanSql(sql: string): SqlFinding[] {
  const text = stripComments(sql);
  const out: SqlFinding[] = [];
  for (const [risk, re] of PATTERNS) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m)
      out.push({
        risk,
        snippet: m[0].replace(/^;\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 100),
      });
  }
  return out;
}

/** Pindai berkas per 1 MB (dengan tumpang tindih kecil agar pernyataan yang terbelah tetap terbaca). */
export async function scanFile(file: Blob): Promise<SqlFinding[]> {
  const CHUNK = 1024 * 1024;
  const found = new Map<SqlRisk, SqlFinding>();
  let tail = '';
  for (let off = 0; off < file.size; off += CHUNK) {
    const text = tail + (await file.slice(off, off + CHUNK).text());
    for (const f of scanSql(text)) if (!found.has(f.risk)) found.set(f.risk, f);
    tail = text.slice(-300);
  }
  return [...found.values()];
}
