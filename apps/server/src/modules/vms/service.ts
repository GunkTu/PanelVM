import type { Ctx } from '../../context.js';
import { parseModules, type ModulesEnabled, type VmRow } from '../../rbac/index.js';
import { openSsh, type SshTarget } from '../../ssh/connect.js';
import type { Lease } from '../../ssh/pool.js';

export const vmKeyContext = (vmId: string): string => `vms.ssh_private_key:${vmId}`;

/** Bentuk VM untuk browser. Private key TIDAK PERNAH disertakan. */
export interface PublicVm {
  id: string;
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  status: VmRow['status'];
  hostKeyFingerprint: string | null;
  hostKeyApproved: boolean;
  modules: ModulesEnabled;
  createdAt: number;
  /** Hanya untuk admin. */
  publicKey?: string;
  assignedTo?: { id: string; email: string } | null;
}

export function toPublicVm(ctx: Ctx, vm: VmRow, forAdmin: boolean): PublicVm {
  const base: PublicVm = {
    id: vm.id,
    name: vm.name,
    host: vm.host,
    sshPort: vm.ssh_port,
    sshUser: vm.ssh_user,
    status: vm.status,
    hostKeyFingerprint: vm.host_key_fingerprint,
    hostKeyApproved: vm.host_key_fingerprint !== null,
    modules: parseModules(vm.modules_enabled),
    createdAt: vm.created_at,
  };
  if (!forAdmin) return base;
  const owner = ctx.db
    .prepare(
      'SELECT u.id, u.email FROM vm_access a JOIN users u ON u.id = a.user_id WHERE a.vm_id = ?',
    )
    .get(vm.id) as { id: string; email: string } | undefined;
  return { ...base, publicKey: vm.ssh_public_key, assignedTo: owner ?? null };
}

export function sshTargetFor(ctx: Ctx, vm: VmRow): SshTarget {
  return {
    host: vm.host,
    port: vm.ssh_port,
    username: vm.ssh_user,
    privateKey: ctx.box.decrypt(vm.ssh_private_key_enc, vmKeyContext(vm.id)),
    expectedFingerprint: vm.host_key_fingerprint,
  };
}

export function setVmStatus(ctx: Ctx, vmId: string, status: VmRow['status']): void {
  ctx.db.prepare('UPDATE vms SET status = ? WHERE id = ?').run(status, vmId);
}

/** Tes koneksi SSH ke VM dan perbarui status online/offline. */
export async function testVm(ctx: Ctx, vm: VmRow, log: (e: Error) => void): Promise<void> {
  try {
    const client = await openSsh(sshTargetFor(ctx, vm), log);
    client.end();
    setVmStatus(ctx, vm.id, 'online');
  } catch (e) {
    setVmStatus(ctx, vm.id, 'offline');
    throw e;
  }
}

/** Pinjam koneksi SSH bersama untuk VM ini, dan pastikan dilepas setelah selesai. */
export async function withVm<T>(ctx: Ctx, vm: VmRow, fn: (lease: Lease) => Promise<T>): Promise<T> {
  const lease = await ctx.pool.acquire(vm.id, sshTargetFor(ctx, vm), (e) =>
    ctx.log?.warn({ err: e.message }, 'ssh pool error'),
  );
  try {
    return await fn(lease);
  } finally {
    lease.release();
  }
}

/** Opsi exec: user non-root memakai sudo -n. */
export const privOpts = (vm: VmRow): { sudo: boolean } => ({ sudo: vm.ssh_user !== 'root' });
