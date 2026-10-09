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
  shared?: number | boolean;
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

export interface TemplateInfo {
  vmid: number;
  name: string;
  os: TemplateOs;
  /** Kunci disk utama di konfigurasi template (mis. scsi0), dan storage serta ukurannya. */
  diskKey: string | null;
  diskStorage: string | null;
  diskSizeBytes: number | null;
  /** Disk utama template ada di storage bersama (mis. share SMB). */
  shared: boolean;
  /** Disk cloud-init di template (kunci dan storage), atau null bila template tidak punya. */
  cloudinit: { key: string; storage: string } | null;
  /** Kunci IDE yang masih kosong, tempat panel menambah disk cloud-init bila template tidak punya. */
  freeIdeKey: string | null;
  /**
   * Semua volume template ada di storage bersama. Hanya dengan begitu Proxmox mau meng-clone template ke node lain
   * ("can't clone VM to node ... (VM uses local storage)" bila ada satu saja di storage lokal).
   */
  cloneableAcrossNodes: boolean;
}

/** Volume (disk/ISO/cloud-init) di konfigurasi VM: kunci, storage, dan apakah itu disk cloud-init. */
export function parseVolumes(
  config: Record<string, unknown>,
): { key: string; storage: string; cloudinit: boolean }[] {
  const out: { key: string; storage: string; cloudinit: boolean }[] = [];
  for (const [key, v] of Object.entries(config)) {
    if (!/^(?:ide|sata|scsi|virtio)[0-9]+$|^(?:efidisk|tpmstate)[0-9]+$/.test(key)) continue;
    if (typeof v !== 'string') continue;
    const storage = /^([A-Za-z0-9][A-Za-z0-9._-]*):/.exec(v)?.[1];
    if (!storage) continue; // mis. "none" atau cdrom kosong
    out.push({
      key,
      storage,
      cloudinit: v.includes('cloudinit'),
    });
  }
  return out;
}

/** Disk utama dari konfigurasi VM: kunci, storage, dan ukuran (mis. "scsi0: tpl-smb:9000/base.qcow2,size=3G"). */
export function parseMainDisk(
  config: Record<string, unknown>,
): { key: string; storage: string; sizeBytes: number | null } | null {
  for (const key of ['scsi0', 'virtio0', 'sata0', 'ide0']) {
    const v = config[key];
    if (typeof v !== 'string' || v.includes('media=cdrom')) continue;
    const storage = /^([A-Za-z0-9][A-Za-z0-9._-]*):/.exec(v)?.[1];
    if (!storage) continue;
    const m = /(?:^|,)size=([0-9]+(?:[.][0-9]+)?)([KMGT])/.exec(v);
    const unit = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 } as const;
    const sizeBytes = m ? Math.round(Number(m[1]) * unit[m[2] as keyof typeof unit]) : null;
    return { key, storage, sizeBytes };
  }
  return null;
}

export interface NodeInventory {
  node: string;
  online: boolean;
  cpuPercent: number | null;
  cpuCores: number | null;
  memFreeBytes: number | null;
  memTotalBytes: number | null;
  templates: TemplateInfo[];
  /** Nomor semua VM/template di node ini (untuk memilih nomor template baru yang kosong). */
  vmids: number[];
  /** Jumlah template yang namanya tidak mengikuti pola Debian/Ubuntu (diabaikan). */
  ignoredTemplates: number;
  storages: {
    name: string;
    type: string;
    availBytes: number | null;
    totalBytes: number | null;
    shared: boolean;
  }[];
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
        vmids: [],
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
        base.vmids = qemu.v.map((v) => v.vmid);
        for (const vm of qemu.v) {
          if (!truthy(vm.template)) continue;
          const os = parseTemplateOs(vm.name ?? '');
          if (os)
            base.templates.push({
              vmid: vm.vmid,
              name: vm.name!,
              os,
              diskKey: null,
              diskStorage: null,
              diskSizeBytes: null,
              shared: false,
              cloudinit: null,
              freeIdeKey: null,
              cloneableAcrossNodes: false,
            });
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
            shared: truthy(s.shared),
          }));
      } else errors.push(`storage: ${storage.error}`);
      if (net.ok) base.bridges = net.v.map((b) => b.iface).sort();
      else errors.push(`jaringan: ${net.error}`);
      // Detail disk tiap template: menentukan apakah bisa di-clone ke node lain (disk di storage bersama).
      await Promise.all(
        base.templates.map(async (t) => {
          const cfg = await safe(
            client.get<Record<string, unknown>>(`/nodes/${n.node}/qemu/${t.vmid}/config`),
          );
          if (!cfg.ok) return;
          const disk = parseMainDisk(cfg.v);
          if (!disk) return;
          t.diskKey = disk.key;
          t.diskStorage = disk.storage;
          t.diskSizeBytes = disk.sizeBytes;
          const isShared = (name: string) =>
            base.storages.find((st) => st.name === name)?.shared ?? false;
          t.shared = isShared(disk.storage);
          const vols = parseVolumes(cfg.v);
          const ci = vols.find((v) => v.cloudinit);
          t.cloudinit = ci ? { key: ci.key, storage: ci.storage } : null;
          t.freeIdeKey = ['ide2', 'ide3', 'ide0', 'ide1'].find((k) => !(k in cfg.v)) ?? null;
          t.cloneableAcrossNodes = vols.length > 0 && vols.every((v) => isShared(v.storage));
        }),
      );
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
  nodes: ['Sys.Audit'],
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
    {
      path: '/nodes',
      purpose: 'membaca node, storage, dan jaringan',
      need: REQUIRED_PRIVILEGES.nodes,
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
