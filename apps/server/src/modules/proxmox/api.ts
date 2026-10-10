import https from 'node:https';
import tls from 'node:tls';
import { AppError } from '../../errors.js';

export interface Endpoint {
  /** Origin API Proxmox, mis. https://192.168.1.10:8006 */
  url: string;
  /** Pin SHA-256 sertifikat TLS node, format "AA:BB:...". */
  fingerprint: string;
}

export interface Credentials {
  /** user@realm!namatoken */
  tokenId: string;
  secret: string;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT';

/**
 * SATU-SATUNYA daftar panggilan API Proxmox yang boleh dilakukan panel. Panggilan di luar daftar ditolak
 * sebelum dikirim. Tidak ada DELETE dan tidak ada endpoint penghapusan VM: panel tidak pernah menghapus apa pun
 * di Proxmox (penghapusan dilakukan admin langsung di Proxmox).
 */
const NODE = '[A-Za-z0-9][A-Za-z0-9-]{0,62}';
/** ID tugas Proxmox (UPID:node:pid:pstart:starttime:type:id:user@realm!token:). */
const UPID = 'UPID:[A-Za-z0-9:@!._-]{10,300}';
export const ALLOWED_CALLS: readonly { method: HttpMethod; path: RegExp }[] = [
  { method: 'GET', path: /^\/version$/ },
  { method: 'GET', path: /^\/nodes$/ },
  { method: 'GET', path: new RegExp(`^/nodes/${NODE}/(qemu|storage|network)$`) },
  { method: 'GET', path: new RegExp(`^/nodes/${NODE}/qemu/\\d{1,9}/config$`) },
  { method: 'GET', path: /^\/cluster\/nextid$/ },
  { method: 'GET', path: /^\/access\/permissions$/ },
  // --- Tahap B: membuat VM dari template. Tidak ada stop/shutdown/delete/migrate. ---
  { method: 'GET', path: new RegExp(`^/nodes/${NODE}/qemu/\\d{1,9}/status/current$`) },
  { method: 'GET', path: new RegExp(`^/nodes/${NODE}/tasks/${UPID}/status$`) },
  { method: 'POST', path: new RegExp(`^/nodes/${NODE}/qemu/\\d{1,9}/clone$`) },
  { method: 'PUT', path: new RegExp(`^/nodes/${NODE}/qemu/\\d{1,9}/config$`) },
  { method: 'PUT', path: new RegExp(`^/nodes/${NODE}/qemu/\\d{1,9}/resize$`) },
  { method: 'POST', path: new RegExp(`^/nodes/${NODE}/qemu/\\d{1,9}/status/start$`) },
  // Tombol restart di panel (reboot ACPI). Tetap tidak ada stop/shutdown/delete/migrate.
  { method: 'POST', path: new RegExp(`^/nodes/${NODE}/qemu/\\d{1,9}/status/reboot$`) },
];

export function isAllowedCall(method: string, path: string): boolean {
  return ALLOWED_CALLS.some((c) => c.method === method && c.path.test(path));
}

/** Samakan format fingerprint (huruf besar, tanpa pemisah) untuk perbandingan. */
export const normalizeFingerprint = (fp: string): string =>
  fp.replace(/[^0-9a-fA-F]/g, '').toUpperCase();

export const FINGERPRINT_RE = /^(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/;

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

class PinError extends Error {}

function hostPort(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: u.port ? Number(u.port) : 443 };
}

/** Buka koneksi TLS dan kembalikan soket beserta info sertifikat (tanpa mengirim data apa pun). */
function connectTls(
  url: string,
): Promise<{ socket: tls.TLSSocket; fingerprint: string; subject: string }> {
  const { host, port } = hostPort(url);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      // Sertifikat Proxmox biasanya self-signed. Keamanan datang dari pin fingerprint di bawah, dicek
      // SEBELUM satu byte pun (termasuk token) dikirim.
      rejectUnauthorized: false,
      servername: /^[\d.]+$|:/.test(host) ? undefined : host,
      timeout: REQUEST_TIMEOUT_MS,
    });
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      resolve({
        socket,
        fingerprint: cert.fingerprint256,
        subject: typeof cert.subject?.CN === 'string' ? cert.subject.CN : '',
      });
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('timeout'));
    });
    socket.once('error', reject);
  });
}

/** Ambil fingerprint sertifikat sebuah endpoint untuk dikonfirmasi admin (belum ada autentikasi). */
export async function scanCertificate(
  url: string,
): Promise<{ fingerprint: string; subject: string }> {
  try {
    const { socket, fingerprint, subject } = await connectTls(url);
    socket.destroy();
    return { fingerprint, subject };
  } catch {
    throw new AppError(
      502,
      'proxmox_unreachable',
      `Panel tidak bisa terhubung ke ${url}. Periksa alamat dan port (biasanya 8006), dan pastikan firewall mengizinkan VM panel menjangkau Proxmox.`,
    );
  }
}

/** Pesan dari tubuh jawaban Proxmox ({"message": "..."}), dirapikan dan dibatasi; kosong bila tidak ada. */
function proxmoxMessage(body: string): string {
  try {
    const m = (JSON.parse(body) as { message?: unknown }).message;
    return typeof m === 'string' ? m.replace(/[\s]+/g, ' ').trim().slice(0, 200) : '';
  } catch {
    return '';
  }
}

function describeFailure(status: number, path: string, body: string): AppError {
  if (status === 401)
    return new AppError(
      401,
      'proxmox_auth',
      'Proxmox menolak token (401). Periksa Token ID dan secret-nya, dan pastikan token belum dihapus atau kedaluwarsa.',
    );
  if (status === 403)
    return new AppError(
      403,
      'proxmox_forbidden',
      `Token tidak punya hak untuk ${path} (403).${proxmoxMessage(body) ? ` Proxmox: ${proxmoxMessage(body)}.` : ''} Tambahkan hak yang kurang ke peran PanelVM sesuai docs/PROXMOX.md, lalu coba lagi.`,
    );
  if (status === 404)
    return new AppError(404, 'proxmox_not_found', `Proxmox tidak menemukan ${path}.`);
  return new AppError(
    502,
    'proxmox_error',
    `Proxmox menjawab error ${status}. ${body.replace(/\s+/g, ' ').slice(0, 160)}`.trim(),
  );
}

/**
 * Klien API Proxmox: pin sertifikat per endpoint, token lewat header (bukan URL), daftar panggilan yang diizinkan,
 * dan cadangan antar endpoint (node lain di cluster) bila satu tidak terjangkau.
 */
export class ProxmoxClient {
  constructor(
    private readonly endpoints: Endpoint[],
    private readonly creds: Credentials,
  ) {
    if (endpoints.length === 0) throw new Error('Minimal satu endpoint');
  }

  async get<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
    return this.call<T>('GET', path, query);
  }

  /** POST dengan isian form (hanya path yang ada di ALLOWED_CALLS). */
  async post<T>(path: string, form: Record<string, string | number> = {}): Promise<T> {
    return this.call<T>('POST', path, {}, form);
  }

  async put<T>(path: string, form: Record<string, string | number> = {}): Promise<T> {
    return this.call<T>('PUT', path, {}, form);
  }

  async call<T>(
    method: HttpMethod,
    path: string,
    query: Record<string, string | number> = {},
    form?: Record<string, string | number>,
  ): Promise<T> {
    if (!isAllowedCall(method, path)) {
      throw new AppError(
        500,
        'proxmox_call_blocked',
        'Panggilan ke Proxmox ini tidak diizinkan oleh panel.',
      );
    }
    let lastError: AppError | null = null;
    for (const ep of this.endpoints) {
      try {
        return await this.callOne<T>(ep, method, path, query, form);
      } catch (e) {
        if (e instanceof PinError) {
          lastError = new AppError(
            502,
            'proxmox_cert_changed',
            `Sertifikat ${ep.url} berbeda dari yang Anda konfirmasi. Mungkin sertifikat node diganti atau ada pihak yang menyamar. Periksa node itu, lalu perbarui pin di halaman Proxmox.`,
          );
          continue;
        }
        if (e instanceof AppError) throw e; // jawaban Proxmox (401/403/404/5xx): tidak dialihkan ke endpoint lain
        lastError ??= new AppError(
          502,
          'proxmox_unreachable',
          `Panel tidak bisa terhubung ke ${ep.url}. Periksa alamat, port 8006, dan firewall.`,
        );
      }
    }
    throw (
      lastError ??
      new AppError(502, 'proxmox_unreachable', 'Panel tidak bisa terhubung ke Proxmox.')
    );
  }

  private async callOne<T>(
    ep: Endpoint,
    method: HttpMethod,
    path: string,
    query: Record<string, string | number>,
    form?: Record<string, string | number>,
  ): Promise<T> {
    const { socket, fingerprint } = await connectTls(ep.url);
    if (normalizeFingerprint(fingerprint) !== normalizeFingerprint(ep.fingerprint)) {
      socket.destroy();
      throw new PinError();
    }
    const { host, port } = hostPort(ep.url);
    const qs = new URLSearchParams(
      Object.entries(query).map(([k, v]) => [k, String(v)]),
    ).toString();
    const body = form
      ? new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])).toString()
      : undefined;
    return new Promise<T>((resolve, reject) => {
      const req = https.request(
        {
          method,
          host,
          port,
          path: `/api2/json${path}${qs ? `?${qs}` : ''}`,
          headers: {
            Authorization: `PVEAPIToken=${this.creds.tokenId}=${this.creds.secret}`,
            Accept: 'application/json',
            ...(body
              ? {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'Content-Length': Buffer.byteLength(body),
                }
              : {}),
          },
          createConnection: () => socket,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_RESPONSE_BYTES) {
              req.destroy(new Error('terlalu besar'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (!res.statusCode || res.statusCode >= 400) {
              return reject(describeFailure(res.statusCode ?? 0, path, text));
            }
            try {
              resolve((JSON.parse(text) as { data: T }).data);
            } catch {
              reject(
                new AppError(502, 'proxmox_bad_response', 'Jawaban Proxmox tidak bisa dibaca.'),
              );
            }
          });
        },
      );
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(body);
    });
  }
}
