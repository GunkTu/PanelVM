import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actor, requireActive } from '../../auth/plugin.js';
import type { Ctx } from '../../context.js';
import { AppError } from '../../errors.js';
import { rateLimit } from '../../ratelimit.js';
import { assertVmAccess } from '../../rbac/index.js';
import { clientFor, type ConnRow } from './service.js';

interface Link {
  connection_id: string;
  node: string;
  vmid: number;
}

const params = z.object({ vmId: z.string().uuid() });

/**
 * Tombol daya VM yang dibuat lewat panel. Hanya "restart" (reboot ACPI yang rapi); tidak ada matikan paksa dan
 * tidak ada hapus. Pemilik VM dan admin boleh, karena pemilik sudah root di VM-nya dan bisa menjalankan `reboot`
 * sendiri lewat terminal. VM yang didaftarkan manual (tanpa tautan Proxmox) tidak punya tombol ini.
 */
export function powerRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, audit } = ctx;

  const linkOf = (vmId: string): { link: Link; conn: ConnRow } | null => {
    const link = db
      .prepare('SELECT connection_id, node, vmid FROM vm_proxmox WHERE vm_id = ?')
      .get(vmId) as Link | undefined;
    if (!link) return null;
    const conn = db
      .prepare('SELECT * FROM proxmox_connections WHERE id = ?')
      .get(link.connection_id) as ConnRow | undefined;
    return conn ? { link, conn } : null;
  };

  app.get('/api/vms/:vmId/power', { onRequest: requireActive }, async (req) => {
    const { vmId } = params.parse(req.params);
    assertVmAccess(db, actor(req), vmId);
    const found = linkOf(vmId);
    if (!found) return { available: false, status: null };
    try {
      const s = await clientFor(ctx, found.conn).get<{ status?: string }>(
        `/nodes/${found.link.node}/qemu/${found.link.vmid}/status/current`,
      );
      return { available: true, status: s.status === 'running' ? 'running' : 'stopped' };
    } catch {
      return { available: true, status: null };
    }
  });

  app.post(
    '/api/vms/:vmId/power/reboot',
    { config: rateLimit(3), onRequest: requireActive },
    async (req) => {
      const { vmId } = params.parse(req.params);
      const user = actor(req);
      const vm = assertVmAccess(db, user, vmId);
      const found = linkOf(vmId);
      if (!found) {
        throw new AppError(
          409,
          'power_unavailable',
          'VM ini tidak dibuat lewat panel, jadi panel tidak tahu letaknya di Proxmox. Restart dari terminal (perintah reboot) atau langsung dari Proxmox.',
        );
      }
      const client = clientFor(ctx, found.conn);
      try {
        await client.post(`/nodes/${found.link.node}/qemu/${found.link.vmid}/status/reboot`);
      } catch (e) {
        audit.record({
          userId: user.id,
          vmId,
          ip: req.ip,
          action: 'vm.reboot',
          target: vm.name,
          result: 'fail',
        });
        throw e;
      }
      audit.record({
        userId: user.id,
        vmId,
        ip: req.ip,
        action: 'vm.reboot',
        target: vm.name,
        result: 'ok',
      });
      return { ok: true };
    },
  );
}
