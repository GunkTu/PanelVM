import { z } from 'zod';

/** Nama unit service: hanya karakter aman dan wajib berakhiran .service. */
export const unitName = z
  .string()
  .max(100)
  .regex(
    /^[A-Za-z0-9_@][A-Za-z0-9_.@-]*\.service$/,
    'Nama service tidak valid (tanpa spasi atau awalan "-"). Contoh: nginx.service',
  );

export const ACTIONS = ['start', 'stop', 'restart', 'reload', 'enable', 'disable'] as const;
export type ServiceAction = (typeof ACTIONS)[number];

const PROTECTED_EXACT = new Set([
  'ssh.service',
  'sshd.service',
  'dbus.service',
  'networking.service',
  'NetworkManager.service',
  'ssh@.service',
]);

/**
 * Service yang kalau dimatikan memutus akses panel ke VM atau merusak sistem. Hanya `reload` yang diizinkan;
 * untuk perubahan lain gunakan terminal dengan sadar.
 */
export const isProtectedUnit = (unit: string): boolean =>
  PROTECTED_EXACT.has(unit) ||
  unit.startsWith('systemd-') ||
  unit.startsWith('dbus-') ||
  /^ssh@.+\.service$/.test(unit);

export interface ServiceInfo {
  name: string;
  description: string;
  load: string;
  active: string;
  sub: string;
  /** enabled | disabled | static | masked | alias | indirect | generated | transient | '' */
  enabled: string;
  protected: boolean;
}

/** Parse `systemctl list-units --type=service --all --no-legend --plain --no-pager`. */
export function parseListUnits(text: string): Omit<ServiceInfo, 'enabled' | 'protected'>[] {
  const out: Omit<ServiceInfo, 'enabled' | 'protected'>[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (m)
      out.push({ name: m[1]!, load: m[2]!, active: m[3]!, sub: m[4]!, description: m[5]!.trim() });
  }
  return out;
}

/** Parse `systemctl list-unit-files --type=service --no-legend --no-pager` -> unit -> state. */
export function parseUnitFiles(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^\s*(\S+\.service)\s+(\S+)/.exec(line);
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

export function mergeServices(
  units: ReturnType<typeof parseListUnits>,
  files: Map<string, string>,
): ServiceInfo[] {
  return units
    .filter((u) => u.load !== 'not-found') // sisa referensi dependensi, bukan service yang ada
    .map((u) => ({ ...u, enabled: files.get(u.name) ?? '', protected: isProtectedUnit(u.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse `systemctl show -p ...` (key=value per baris). */
export function parseShow(text: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  return kv;
}
