import type { Db } from '../db/index.js';
import { AppError, forbidden, notFound } from '../errors.js';

export const VM_MODULES = [
  'terminal',
  'files',
  'database',
  'monitoring',
  'services',
  'software',
  'sites',
  'previews',
] as const;
export type VmModule = (typeof VM_MODULES)[number];
export type ModulesEnabled = Record<VmModule, boolean>;

export interface VmRow {
  id: string;
  name: string;
  host: string;
  ssh_port: number;
  ssh_user: string;
  ssh_private_key_enc: string;
  ssh_public_key: string;
  host_key_fingerprint: string | null;
  status: 'online' | 'offline' | 'unknown';
  modules_enabled: string;
  created_at: number;
}

export interface Actor {
  id: string;
  role: 'admin' | 'client';
  status: 'active' | 'suspended';
}

export function parseModules(json: string): ModulesEnabled {
  const out = Object.fromEntries(VM_MODULES.map((m) => [m, false])) as ModulesEnabled;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    for (const m of VM_MODULES) out[m] = raw[m] === true;
  } catch {
    // JSON rusak: semua modul dianggap mati (gagal aman)
  }
  return out;
}

/**
 * Guard otorisasi VM. WAJIB dipanggil sebelum endpoint/pesan WebSocket menyentuh VM.
 * Client yang bukan pemilik mendapat 404 (tidak membocorkan keberadaan VM).
 */
export function assertVmAccess(db: Db, actor: Actor, vmId: string, module?: VmModule): VmRow {
  if (actor.status !== 'active') {
    throw new AppError(
      403,
      'suspended',
      'Akun Anda sedang ditangguhkan. Hubungi admin untuk mengaktifkannya kembali.',
    );
  }
  const vm = db.prepare('SELECT * FROM vms WHERE id = ?').get(vmId) as VmRow | undefined;
  if (!vm) throw notFound('VM');
  if (actor.role !== 'admin') {
    const link = db
      .prepare('SELECT 1 AS ok FROM vm_access WHERE user_id = ? AND vm_id = ?')
      .get(actor.id, vmId);
    if (!link) throw notFound('VM');
  }
  if (module && !parseModules(vm.modules_enabled)[module]) {
    throw forbidden(
      `Modul ${module} dinonaktifkan untuk VM ini. Hubungi admin untuk mengaktifkannya.`,
    );
  }
  return vm;
}
