import type { Ctx } from '../../context.js';
import type { VmRow } from '../../rbac/index.js';
import { execRemote } from '../../ssh/exec.js';
import { notify, notifyAdmins } from '../notifications/service.js';
import { sshTargetFor } from './service.js';

/**
 * Memeriksa semua VM yang host key-nya sudah disetujui secara berkala (koneksi SSH + perintah `true`),
 * memperbarui status online/offline, dan memberi notifikasi HANYA saat status berubah.
 */
export class VmWatcher {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.intervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => void this.checkAll(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async checkAll(): Promise<void> {
    if (this.running) return; // jangan menumpuk bila pemeriksaan sebelumnya belum selesai
    this.running = true;
    try {
      const vms = this.ctx.db
        .prepare('SELECT * FROM vms WHERE host_key_fingerprint IS NOT NULL')
        .all() as VmRow[];
      await Promise.all(vms.map((vm) => this.checkOne(vm)));
    } finally {
      this.running = false;
    }
  }

  async checkOne(vm: VmRow): Promise<boolean> {
    const { db, pool } = this.ctx;
    const before = (
      db.prepare('SELECT status FROM vms WHERE id = ?').get(vm.id) as
        { status: VmRow['status'] } | undefined
    )?.status;
    if (before === undefined) return false;
    let online = false;
    try {
      const lease = await pool.acquire(vm.id, sshTargetFor(this.ctx, vm));
      try {
        online = (await execRemote(lease.client, ['true'], { timeoutMs: 8000 })).code === 0;
      } finally {
        lease.release();
      }
    } catch {
      pool.invalidate(vm.id); // koneksi yang macet tidak boleh dipakai ulang
    }
    db.prepare('UPDATE vms SET status = ? WHERE id = ?').run(online ? 'online' : 'offline', vm.id);

    if (before === 'online' && !online)
      this.announce(
        vm,
        'vm_offline',
        `VM "${vm.name}" tidak bisa dijangkau`,
        `Panel gagal terhubung ke VM "${vm.name}" lewat SSH. Periksa apakah VM menyala dan firewall mengizinkan SSH dari VM panel.`,
      );
    if (before === 'offline' && online)
      this.announce(
        vm,
        'vm_online',
        `VM "${vm.name}" kembali online`,
        `Panel kembali terhubung ke VM "${vm.name}".`,
      );
    return online;
  }

  private announce(vm: VmRow, type: string, title: string, message: string): void {
    const { db, audit } = this.ctx;
    notifyAdmins(db, type, title, message);
    const owner = db
      .prepare(
        'SELECT a.user_id AS id, u.role FROM vm_access a JOIN users u ON u.id = a.user_id WHERE a.vm_id = ?',
      )
      .get(vm.id) as { id: string; role: string } | undefined;
    if (owner && owner.role !== 'admin') notify(db, owner.id, type, title, message);
    audit.record({
      vmId: vm.id,
      action: `vm.${type === 'vm_offline' ? 'went_offline' : 'came_online'}`,
      target: vm.name,
      result: 'ok',
    });
  }
}
