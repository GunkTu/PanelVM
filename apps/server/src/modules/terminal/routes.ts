import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { actor, requireActive, requireAuthed } from '../../auth/plugin.js';
import type { Ctx } from '../../context.js';
import { AppError } from '../../errors.js';
import { assertVmAccess, type VmRow } from '../../rbac/index.js';
import { openSsh } from '../../ssh/connect.js';
import { setVmStatus, sshTargetFor } from '../vms/service.js';
import { MAX_TERMINALS_PER_USER, MAX_TERMINALS_PER_VM } from './registry.js';

export const MAX_WS_MESSAGE_BYTES = 64 * 1024;
const IDLE_CLOSE_MS = 30 * 60 * 1000;
const LIVENESS_CHECK_MS = 15 * 1000;
const BACKPRESSURE_HIGH = 1_000_000;

/** Pesan dari browser. Tipe lain ditolak. */
export const clientMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('input'), d: z.string().max(MAX_WS_MESSAGE_BYTES) }),
  z.object({
    t: z.literal('resize'),
    cols: z.number().int().min(1).max(500),
    rows: z.number().int().min(1).max(300),
  }),
  z.object({ t: z.literal('ping') }),
]);

const sizeQuery = z.object({
  cols: z.coerce.number().int().min(1).max(500).default(80),
  rows: z.coerce.number().int().min(1).max(300).default(24),
});

declare module 'fastify' {
  interface FastifyRequest {
    terminalVm?: VmRow;
  }
}

export function terminalRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { audit } = ctx;
  const sendStatus = (ws: WebSocket, state: string, message?: string) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'status', state, message }));
  };

  app.get<{ Params: { vmId: string } }>(
    '/api/vms/:vmId/terminal',
    {
      websocket: true,
      // Semua pengecekan di tahap HTTP (sebelum upgrade) agar penolakan berupa 401/403/404 biasa.
      preHandler: [
        requireActive,
        async (req) => {
          if (req.headers.origin !== ctx.env.APP_ORIGIN) {
            throw new AppError(
              403,
              'bad_origin',
              'Koneksi terminal ditolak karena berasal dari alamat yang tidak dikenal. Buka panel dari alamat resminya.',
            );
          }
          const user = actor(req);
          const { vmId } = z.object({ vmId: z.string().uuid() }).parse(req.params);
          const vm = assertVmAccess(ctx.db, user, vmId, 'terminal');
          if (
            ctx.terminals.countForUser(user.id) >= MAX_TERMINALS_PER_USER ||
            ctx.terminals.countForVm(vm.id) >= MAX_TERMINALS_PER_VM
          ) {
            throw new AppError(
              429,
              'terminal_limit',
              'Jumlah tab terminal sudah mencapai batas. Tutup salah satu tab terminal lalu coba lagi.',
            );
          }
          req.terminalVm = vm;
        },
      ],
    },
    async (socket, req) => {
      const { user, session } = requireAuthed(req);
      const vm = req.terminalVm!;
      const size = sizeQuery.parse(req.query);
      const termId = randomUUID();
      let closed = false;
      let sshClient: Awaited<ReturnType<typeof openSsh>> | null = null;
      let lastActivity = Date.now();
      let lastTouch = 0;

      const cleanup = (reason: string, result: 'ok' | 'fail' = 'ok') => {
        if (closed) return;
        closed = true;
        clearInterval(liveness);
        ctx.terminals.remove(termId);
        sshClient?.end();
        sendStatus(socket, 'closed', reason);
        if (socket.readyState === socket.OPEN) socket.close(1000, 'closed');
        audit.record({
          userId: user.id,
          vmId: vm.id,
          ip: req.ip,
          action: 'terminal.close',
          target: vm.name,
          result,
          meta: { reason },
        });
      };

      ctx.terminals.add({
        id: termId,
        userId: user.id,
        vmId: vm.id,
        authSessionId: session.id,
        close: (r) => cleanup(r),
      });

      const liveness = setInterval(() => {
        const row = ctx.db.prepare('SELECT status FROM users WHERE id = ?').get(user.id) as
          { status: string } | undefined;
        if (!row || row.status !== 'active' || !ctx.sessions.isLive(session.id))
          return cleanup('Sesi login berakhir');
        if (Date.now() - lastActivity > IDLE_CLOSE_MS)
          cleanup('Terminal ditutup karena tidak aktif 30 menit');
      }, LIVENESS_CHECK_MS);

      audit.record({
        userId: user.id,
        vmId: vm.id,
        ip: req.ip,
        action: 'terminal.open',
        target: vm.name,
        result: 'ok',
      });
      sendStatus(socket, 'connecting');

      socket.on('close', () => cleanup('Koneksi browser terputus'));
      socket.on('error', () => cleanup('Koneksi browser bermasalah', 'fail'));

      try {
        sshClient = await openSsh(sshTargetFor(ctx, vm), (e) =>
          req.log.warn({ err: e.message }, 'ssh terminal error'),
        );
        setVmStatus(ctx, vm.id, 'online');
      } catch (e) {
        setVmStatus(ctx, vm.id, 'offline');
        const msg =
          e instanceof AppError ? e.message : 'Koneksi SSH ke VM gagal. Coba lagi beberapa saat.';
        sendStatus(socket, 'error', msg);
        return cleanup(msg, 'fail');
      }
      if (closed) return sshClient.end();

      sshClient.on('error', () => cleanup('Koneksi ke VM terputus', 'fail'));
      sshClient.on('close', () => cleanup('Koneksi ke VM ditutup'));

      sshClient.shell(
        { term: 'xterm-256color', cols: size.cols, rows: size.rows },
        (err, stream) => {
          if (err || closed) return cleanup('Gagal membuka shell di VM. Coba lagi.', 'fail');
          sendStatus(socket, 'connected');
          let paused = false;

          stream.on('data', (chunk: Buffer) => {
            if (socket.readyState !== socket.OPEN) return;
            socket.send(chunk, { binary: true });
            if (!paused && socket.bufferedAmount > BACKPRESSURE_HIGH) {
              paused = true;
              stream.pause();
              const t = setInterval(() => {
                if (
                  socket.bufferedAmount < BACKPRESSURE_HIGH / 4 ||
                  socket.readyState !== socket.OPEN
                ) {
                  clearInterval(t);
                  paused = false;
                  stream.resume();
                }
              }, 50);
            }
          });
          stream.on('close', () => cleanup('Sesi shell di VM berakhir'));

          socket.on('message', (raw: Buffer, isBinary: boolean) => {
            if (isBinary || raw.length > MAX_WS_MESSAGE_BYTES + 64)
              return cleanup('Pesan tidak valid', 'fail');
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw.toString('utf8'));
            } catch {
              return cleanup('Pesan tidak valid', 'fail');
            }
            const msg = clientMessage.safeParse(parsed);
            if (!msg.success) return cleanup('Pesan tidak valid', 'fail');
            const now = Date.now();
            switch (msg.data.t) {
              case 'input':
                lastActivity = now;
                if (now - lastTouch > 60_000) {
                  lastTouch = now;
                  ctx.sessions.touch(session.id);
                }
                stream.write(msg.data.d);
                break;
              case 'resize':
                stream.setWindow(msg.data.rows, msg.data.cols, 0, 0);
                break;
              case 'ping':
                socket.send(JSON.stringify({ t: 'pong' }));
                break;
            }
          });
        },
      );
    },
  );
}
