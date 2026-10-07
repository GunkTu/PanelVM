import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actor, requireActive } from '../../auth/plugin.js';
import type { Ctx } from '../../context.js';
import { AppError } from '../../errors.js';
import { assertVmAccess } from '../../rbac/index.js';
import { rateLimit } from '../../ratelimit.js';
import { execRemote } from '../../ssh/exec.js';
import { privOpts, withVm } from '../vms/service.js';
import { MONITOR_SCRIPT, parseMonitoring } from './collect.js';

export function monitoringRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get(
    '/api/vms/:vmId/monitoring',
    { config: rateLimit(60), onRequest: requireActive },
    async (req) => {
      const { vmId } = z.object({ vmId: z.string().uuid() }).parse(req.params);
      const vm = assertVmAccess(ctx.db, actor(req), vmId, 'monitoring');
      const r = await withVm(ctx, vm, (lease) =>
        execRemote(lease.client, ['sh', '-s'], {
          ...privOpts(vm),
          stdin: MONITOR_SCRIPT,
          timeoutMs: 15_000,
        }),
      );
      if (r.code !== 0 || !r.stdout.includes('##mem')) {
        throw new AppError(
          502,
          'monitor_failed',
          'Gagal membaca data dari VM (perintah bacaan sistem tidak merespons). Coba lagi; bila berulang, periksa VM lewat terminal.',
        );
      }
      return { ...parseMonitoring(r.stdout), collectedAt: Date.now() };
    },
  );
}
