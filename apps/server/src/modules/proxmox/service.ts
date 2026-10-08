import type { Ctx } from '../../context.js';
import { ProxmoxClient, type Endpoint } from './api.js';

export interface ConnRow {
  id: string;
  name: string;
  endpoints: string;
  token_id: string;
  token_secret_enc: string;
  pool: string;
  created_at: number;
  last_ok_at: number | null;
}

/** Konteks AAD enkripsi: ciphertext token satu koneksi tidak bisa dipindah ke baris lain. */
export const tokenContext = (id: string): string => `proxmox.token:${id}`;

export function parseEndpoints(json: string): Endpoint[] {
  try {
    const raw = JSON.parse(json) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is Endpoint =>
        !!e &&
        typeof (e as Endpoint).url === 'string' &&
        typeof (e as Endpoint).fingerprint === 'string',
    );
  } catch {
    return [];
  }
}

export function clientFor(ctx: Ctx, row: ConnRow): ProxmoxClient {
  return new ProxmoxClient(parseEndpoints(row.endpoints), {
    tokenId: row.token_id,
    secret: ctx.box.decrypt(row.token_secret_enc, tokenContext(row.id)),
  });
}

/** Bentuk untuk browser. Secret token TIDAK PERNAH disertakan. */
export const toPublicConn = (r: ConnRow) => ({
  id: r.id,
  name: r.name,
  endpoints: parseEndpoints(r.endpoints),
  tokenId: r.token_id,
  pool: r.pool,
  createdAt: r.created_at,
  lastOkAt: r.last_ok_at,
});
