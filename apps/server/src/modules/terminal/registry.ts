/** Melacak sesi terminal yang berjalan agar bisa dipaksa putus saat logout/suspend/sesi berakhir. */
export interface TerminalHandle {
  id: string;
  userId: string;
  vmId: string;
  authSessionId: string;
  close(reason: string): void;
}

export const MAX_TERMINALS_PER_USER = 5;
export const MAX_TERMINALS_PER_VM = 5;

export class TerminalRegistry {
  private readonly handles = new Map<string, TerminalHandle>();

  add(h: TerminalHandle): void {
    this.handles.set(h.id, h);
  }
  remove(id: string): void {
    this.handles.delete(id);
  }
  countForUser(userId: string): number {
    return [...this.handles.values()].filter((h) => h.userId === userId).length;
  }
  countForVm(vmId: string): number {
    return [...this.handles.values()].filter((h) => h.vmId === vmId).length;
  }
  closeByUser(userId: string, reason: string): void {
    for (const h of [...this.handles.values()]) if (h.userId === userId) h.close(reason);
  }
  closeByAuthSession(authSessionId: string, reason: string): void {
    for (const h of [...this.handles.values()])
      if (h.authSessionId === authSessionId) h.close(reason);
  }
  closeByVm(vmId: string, reason: string): void {
    for (const h of [...this.handles.values()]) if (h.vmId === vmId) h.close(reason);
  }
  closeAll(reason: string): void {
    for (const h of [...this.handles.values()]) h.close(reason);
  }
  get size(): number {
    return this.handles.size;
  }
}
