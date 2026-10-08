import type { ProxmoxClient } from './api.js';

export interface TemplateOs {
  /** Kunci OS, mis. debian12 atau ubuntu2404. */
  id: string;
  label: string;
  /** User SSH bawaan image cloud (punya sudo tanpa password). */
  sshUser: 'debian' | 'ubuntu';
}

/**
 * Template VM dikenali dari namanya: tpl-debian12-<node> atau tpl-ubuntu2404-<node>. Nama lain diabaikan agar
 * panel tidak menebak user SSH yang salah. Hanya Debian dan Ubuntu yang didukung installer panel.
 */
export function parseTemplateOs(name: string): TemplateOs | null {
  const m = /^tpl-(debian|ubuntu)(\d{2,4})(?:-[A-Za-z0-9.-]+)?$/.exec(name);
  if (!m) return null;
  const [, distro, ver] = m as unknown as [string, 'debian' | 'ubuntu', string];
  if (distro === 'debian') {
    if (!/^\d{1,2}$/.test(ver)) return null;
    return { id: `debian${ver}`, label: `Debian ${ver}`, sshUser: 'debian' };
  }
  if (!/^\d{4}$/.test(ver)) return null;
  return {
    id: `ubuntu${ver}`,
    label: `Ubuntu ${ver.slice(0, 2)}.${ver.slice(2)}`,
    sshUser: 'ubuntu',
  };
}

interface RawNode {
  node: string;
  status?: string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  uptime?: number;
}
interface RawQemu {
  vmid: number;
  name?: string;
  status?: string;
  template?: number | boolean;
}
interface RawStorage {
  storage: string;
  type?: string;
  avail?: number;
  total?: number;
  active?: number | boolean;
  enabled?: number | boolean;
  content?: string;
}
interface RawNetwork {
  iface: string;
  type?: string;
}

export interface NodeInventory {
  node: string;
  online: boolean;
  cpuPercent: number | null;
  cpuCores: number | null;
  memFreeBytes: number | null;
  memTotalBytes: number | null;
  templates: { vmid: number; name: string; os: TemplateOs }[];
  /** Jumlah template yang namanya tidak mengikuti pola Debian/Ubuntu (diabaikan). */
  ignoredTemplates: number;
  storages: { name: string; type: string; availBytes: number | null; totalBytes: number | null }[];
  bridges: string[];
  error?: string;
}

export interface Inventory {
  version: string | null;
  nodes: NodeInventory[];
}

const truthy = (v: unknown): boolean => v === 1 || v === true || v === '1';
const safe = async <T>(
  p: Promise<T>,
): Promise<{ ok: true; v: T } | { ok: false; error: string }> => {
  try {
    return { ok: true, v: await p };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'gagal' };
  }
};

/** Kumpulkan node, template, storage, dan bridge dengan panggilan baca-saja. Node offline dilewati. */
export async function collectInventory(client: ProxmoxClient): Promise<Inventory> {
  const [version, nodes] = await Promise.all([
    safe(client.get<{ version?: string }>('/version')),
    client.get<RawNode[]>('/nodes'),
  ]);
  const out: NodeInventory[] = await Promise.all(
    nodes.map(async (n): Promise<NodeInventory> => {
      const base: NodeInventory = {
        node: n.node,
        online: n.status === 'online',
        cpuPercent: typeof n.cpu === 'number' ? Math.round(n.cpu * 100) : null,
        cpuCores: n.maxcpu ?? null,
        memFreeBytes: n.maxmem != null && n.mem != null ? n.maxmem - n.mem : null,
        memTotalBytes: n.maxmem ?? null,
        templates: [],
        ignoredTemplates: 0,
        storages: [],
        bridges: [],
      };
      if (!base.online) return base;
      const [qemu, storage, net] = await Promise.all([
        safe(client.get<RawQemu[]>(`/nodes/${n.node}/qemu`)),
        safe(client.get<RawStorage[]>(`/nodes/${n.node}/storage`, { content: 'images' })),
        safe(client.get<RawNetwork[]>(`/nodes/${n.node}/network`, { type: 'bridge' })),
      ]);
      const errors: string[] = [];
      if (qemu.ok) {
        for (const vm of qemu.v) {
          if (!truthy(vm.template)) continue;
          const os = parseTemplateOs(vm.name ?? '');
          if (os) base.templates.push({ vmid: vm.vmid, name: vm.name!, os });
          else base.ignoredTemplates += 1;
        }
        base.templates.sort((a, b) => a.name.localeCompare(b.name));
      } else errors.push(`daftar VM: ${qemu.error}`);
      if (storage.ok) {
        base.storages = storage.v
          .filter(
            (s) =>
              (s.enabled === undefined || truthy(s.enabled)) &&
              (s.active === undefined || truthy(s.active)),
          )
          .map((s) => ({
            name: s.storage,
            type: s.type ?? '',
            availBytes: s.avail ?? null,
            totalBytes: s.total ?? null,
          }));
      } else errors.push(`storage: ${storage.error}`);
      if (net.ok) base.bridges = net.v.map((b) => b.iface).sort();
      else errors.push(`jaringan: ${net.error}`);
      if (errors.length) base.error = errors.join('; ');
      return base;
    }),
  );
  return { version: version.ok ? (version.v.version ?? null) : null, nodes: out };
}

/** Hak yang dibutuhkan panel untuk membuat VM (Tahap B). Nama hak mengikuti dokumentasi Proxmox VE 8. */
export const REQUIRED_PRIVILEGES = {
  pool: [
    'VM.Allocate',
    'VM.Config.CPU',
    'VM.Config.Memory',
    'VM.Config.Disk',
    'VM.Config.Network',
    'VM.Config.Cloudinit',
    'VM.Config.Options',
    'VM.PowerMgmt',
    'VM.Audit',
  ],
  storage: ['Datastore.AllocateSpace'],
  template: ['VM.Clone'],
  network: ['SDN.Use'],
} as const;

export interface PermissionCheck {
  path: string;
  /** Kebutuhan: apa yang dipakai di path ini. */
  purpose: string;
  missing: string[];
  /** true bila tidak bisa diperiksa (mis. path tidak ada); tidak dianggap gagal. */
  unknown?: boolean;
}

/**
 * Periksa hak token pada path yang akan dipakai. Bersifat saran (hanya membaca): bila Proxmox tidak bisa
 * menjawab untuk sebuah path, hasilnya "unknown", bukan gagal.
 */
export async function checkPermissions(
  client: ProxmoxClient,
  pool: string,
  inv: Inventory,
): Promise<PermissionCheck[]> {
  const targets: { path: string; purpose: string; need: readonly string[] }[] = [
    { path: `/pool/${pool}`, purpose: 'VM baru (pool panel)', need: REQUIRED_PRIVILEGES.pool },
    {
      path: '/sdn/zones/localnetwork',
      purpose: 'jaringan bridge',
      need: REQUIRED_PRIVILEGES.network,
    },
  ];
  const seen = new Set<string>();
  for (const n of inv.nodes) {
    for (const s of n.storages) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      targets.push({
        path: `/storage/${s.name}`,
        purpose: `storage ${s.name}`,
        need: REQUIRED_PRIVILEGES.storage,
      });
    }
    for (const t of n.templates)
      targets.push({
        path: `/vms/${t.vmid}`,
        purpose: `template ${t.name}`,
        need: REQUIRED_PRIVILEGES.template,
      });
  }
  return Promise.all(
    targets.map(async (t): Promise<PermissionCheck> => {
      const r = await safe(
        client.get<Record<string, Record<string, number>>>('/access/permissions', { path: t.path }),
      );
      if (!r.ok) return { path: t.path, purpose: t.purpose, missing: [], unknown: true };
      const granted = r.v[t.path] ?? {};
      return {
        path: t.path,
        purpose: t.purpose,
        missing: t.need.filter((p) => !granted[p]),
      };
    }),
  );
}
