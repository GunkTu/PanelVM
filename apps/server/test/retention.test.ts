import { describe, expect, it } from 'vitest';
import { purgeOld } from '../src/audit/retention.js';
import { makeApp } from './helpers.js';

describe('retensi', () => {
  it('menghapus audit log lebih tua dari batas, menyisakan yang baru', async () => {
    const { app, ctx } = await makeApp();
    const day = 24 * 60 * 60 * 1000;
    const ins = ctx.db.prepare("INSERT INTO audit_logs (ts, action, result) VALUES (?, 'x', 'ok')");
    ins.run(Date.now() - 100 * day);
    ins.run(Date.now() - 10 * day);
    const r = purgeOld(ctx.db, 90);
    expect(r.audit).toBe(1);
    expect(
      (
        ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'x'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    await app.close();
  });

  it('audit log tetap tidak bisa di-UPDATE', async () => {
    const { app, ctx } = await makeApp();
    ctx.db.prepare("INSERT INTO audit_logs (ts, action, result) VALUES (1, 'y', 'ok')").run();
    expect(() =>
      ctx.db.prepare("UPDATE audit_logs SET result = 'fail' WHERE action = 'y'").run(),
    ).toThrow(/append-only/);
    await app.close();
  });
});
