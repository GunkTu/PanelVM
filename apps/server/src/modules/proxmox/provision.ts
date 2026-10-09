import net from 'node:net';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { AppError } from '../../errors.js';
import { VM_MODULES, type VmRow } from '../../rbac/index.js';
import { generateKeyPair, scanHostKey } from '../../ssh/connect.js';
import type { JobControl } from '../jobs/service.js';
import { vmKeyContext } from '../vms/service.js';
import type { ProxmoxClient } from './api.js';
import type { Inventory, NodeInventory, TemplateInfo } from './inventory.js';

const GIB = 1024 ** 3;

// --- jaringan IPv4 -----------------------------------------------------------------------------------------------

const IPV4 = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/;

export function ipv4ToNumber(ip: string): number | null {
  const m = IPV4.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

export interface Cidr {
  ip: string;
  prefix: number;
  ipNum: number;
}

export function parseCidr(s: string): Cidr | null {
  const [ip, p, ...rest] = s.split('/');
  if (!ip || p === undefined || rest.length || !/^[0-9]{1,2}$/.test(p)) return null;
  const ipNum = ipv4ToNumber(ip);
  const prefix = Number(p);
  if (ipNum === null || prefix < 8 || prefix > 30) return null;
  return { ip, prefix, ipNum };
}

const mask = (prefix: number): number => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);

/** Sebuah alamat host valid: di subnet yang sama, bukan alamat jaringan, dan bukan broadcast. */
export function isHostIn(c: Cidr, other: number): boolean {
  const m = mask(c.prefix);
  const network = (c.ipNum & m) >>> 0;
  const broadcast = (network | (~m >>> 0)) >>> 0;
  return (other & m) >>> 0 === network && other !== network && other !== broadcast;
}

// --- masukan dan validasi ----------------------------------------------------------------------------------------

export const createVmBody = z.object({
  node: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/, 'Node tidak valid.'),
  osId: z.string().regex(/^(debian|ubuntu)[0-9]{2,4}$/, 'OS tidak valid.'),
  name: z
    .string()
    .trim()
    .regex(
      /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/,
      'Nama VM 2-40 karakter: huruf kecil, angka, dan tanda hubung (tidak di awal/akhir). Contoh: web-teman1.',
    ),
  cores: z.number().int().min(1).max(32),
  memoryMb: z.number().int().min(256).max(262144),
  diskGb: z.number().int().min(2).max(4096),
  storage: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'Storage tidak valid.'),
  bridge: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,14}$/, 'Bridge tidak valid.'),
  vlan: z.number().int().min(1).max(4094).optional(),
  ip: z
    .string()
    .trim()
    .regex(/^[0-9./]{9,18}$/, 'Isi IP dengan format 192.168.10.50/24.'),
  gateway: z
    .string()
    .trim()
    .regex(/^[0-9.]{7,15}$/, 'Isi gateway, mis. 192.168.10.1.'),
  dns: z
    .string()
    .trim()
    .max(40)
    .regex(/^[0-9. ,]*$/, 'DNS berisi IP dipisah spasi atau koma.')
    .optional(),
  sshPort: z.number().int().min(1).max(65535).default(22),
});
export type CreateVmInput = z.infer<typeof createVmBody>;

const bad = (message: string, code = 'invalid_input') => new AppError(400, code, message);

/** Parameter jaringan yang sudah tervalidasi (alamat VM, ipconfig0 cloud-init, DNS). */
export function resolveNetwork(input: CreateVmInput): {
  host: string;
  ipconfig0: string;
  nameserver: string | null;
} {
  const cidr = parseCidr(input.ip);
  if (!cidr)
    throw bad(
      'IP harus berbentuk 192.168.10.50/24 (IPv4 dengan panjang prefix 8 sampai 30).',
      'bad_ip',
    );
  const gw = ipv4ToNumber(input.gateway);
  if (gw === null) throw bad('Gateway bukan alamat IPv4 yang valid.', 'bad_gateway');
  if (!isHostIn(cidr, cidr.ipNum))
    throw bad('IP tidak boleh alamat jaringan atau broadcast subnet.', 'bad_ip');
  if (!isHostIn(cidr, gw) || gw === cidr.ipNum)
    throw bad(
      'Gateway harus berada di subnet yang sama dengan IP VM dan tidak sama dengan IP VM.',
      'bad_gateway',
    );
  let nameserver: string | null = null;
  if (input.dns) {
    const list = input.dns.split(/[ ,]+/).filter(Boolean);
    if (list.length === 0 || list.length > 2 || list.some((d) => ipv4ToNumber(d) === null))
      throw bad('DNS berisi 1 sampai 2 alamat IPv4, dipisah spasi atau koma.', 'bad_dns');
    nameserver = list.join(' ');
  }
  return { host: cidr.ip, ipconfig0: `ip=${input.ip},gw=${input.gateway}`, nameserver };
}

export interface TemplateChoice extends TemplateInfo {
  ownerNode: string;
}

/** Template yang bisa dipakai untuk membuat VM di `node`: yang ada di node itu, atau yang diskusinya di storage bersama. */
export function availableTemplates(inv: Inventory, node: string): TemplateChoice[] {
  const out: TemplateChoice[] = [];
  for (const n of inv.nodes) {
    if (!n.online) continue;
    for (const t of n.templates) {
      if (n.node === node || t.shared) out.push({ ...t, ownerNode: n.node });
    }
  }
  // Template di node tujuan lebih dulu (clone lokal lebih cepat dan tidak lintas node).
  return out.sort((a, b) => Number(b.ownerNode === node) - Number(a.ownerNode === node));
}

export interface Plan {
  node: NodeInventory;
  template: TemplateChoice;
  host: string;
  ipconfig0: string;
  nameserver: string | null;
}

/** Periksa masukan terhadap keadaan nyata Proxmox dan data panel. Melempar galat berbahasa Indonesia yang jelas. */
export function planCreate(ctx: Ctx, inv: Inventory, input: CreateVmInput): Plan {
  const net = resolveNetwork(input);
  const node = inv.nodes.find((n) => n.node === input.node);
  if (!node) throw bad(`Node "${input.node}" tidak ada di cluster ini.`, 'bad_node');
  if (!node.online)
    throw new AppError(409, 'node_offline', `Node "${node.node}" sedang offline. Pilih node lain.`);
  const template = availableTemplates(inv, node.node).find((t) => t.os.id === input.osId);
  if (!template) {
    const local = inv.nodes.flatMap((n) =>
      n.templates.filter((t) => t.os.id === input.osId).map(() => n.node),
    );
    throw new AppError(
      409,
      'no_template',
      local.length
        ? `Template ${input.osId} hanya ada di node ${local.join(', ')} dengan disk lokal, jadi tidak bisa di-clone ke ${node.node}. Pilih node itu, atau pindahkan disk template ke storage bersama.`
        : `Belum ada template untuk OS itu di node ${node.node}. Buat template bernama tpl-${input.osId} (lihat docs/PROXMOX.md).`,
    );
  }
  if (!template.diskKey)
    throw new AppError(
      409,
      'template_unreadable',
      `Disk template ${template.name} tidak terbaca. Periksa hak token pada /vms/${template.vmid} lalu jalankan Tes lagi.`,
    );
  const storage = node.storages.find((s) => s.name === input.storage);
  if (!storage)
    throw bad(`Storage "${input.storage}" tidak tersedia di node ${node.node}.`, 'bad_storage');
  if (!node.bridges.includes(input.bridge))
    throw bad(`Bridge "${input.bridge}" tidak ada di node ${node.node}.`, 'bad_bridge');
  const diskBytes = input.diskGb * GIB;
  if (template.diskSizeBytes !== null && diskBytes < template.diskSizeBytes)
    throw bad(
      `Disk minimal ${Math.ceil(template.diskSizeBytes / GIB)} GB (ukuran template). Disk hanya bisa diperbesar.`,
      'disk_too_small',
    );
  if (storage.availBytes !== null && diskBytes > storage.availBytes)
    throw new AppError(
      409,
      'storage_full',
      `Ruang di storage ${storage.name} node ${node.node} hanya ${Math.floor(storage.availBytes / GIB)} GB, kurang dari ${input.diskGb} GB. Kecilkan disk atau pilih storage/node lain.`,
    );
  if (ctx.db.prepare('SELECT 1 AS ok FROM vms WHERE name = ?').get(input.name))
    throw new AppError(409, 'vm_name_taken', 'Nama VM sudah dipakai di panel. Pilih nama lain.');
  if (ctx.db.prepare('SELECT 1 AS ok FROM vms WHERE host = ?').get(net.host))
    throw new AppError(
      409,
      'ip_taken',
      `IP ${net.host} sudah dipakai VM lain di panel. Pilih IP yang belum terpakai.`,
    );
  return { node, template, ...net };
}

// --- pembuatan ---------------------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Tunggu tugas Proxmox selesai. exitstatus "OK" (atau "WARNINGS...") = berhasil. */
export async function waitTask(
  client: ProxmoxClient,
  node: string,
  upid: string,
  opts: { timeoutMs: number; pollMs: number },
): Promise<void> {
  const started = Date.now();
  for (;;) {
    const st = await client.get<{ status: string; exitstatus?: string }>(
      `/nodes/${node}/tasks/${upid}/status`,
    );
    if (st.status === 'stopped') {
      if (st.exitstatus === 'OK' || st.exitstatus?.startsWith('WARNINGS')) return;
      throw new AppError(
        502,
        'proxmox_task_failed',
        `Tugas di Proxmox gagal: ${String(st.exitstatus ?? 'tanpa keterangan').slice(0, 200)}. Lihat Task log di Proxmox untuk detailnya.`,
      );
    }
    if (Date.now() - started > opts.timeoutMs)
      throw new AppError(
        504,
        'proxmox_task_timeout',
        'Tugas di Proxmox belum selesai dalam batas waktu. Periksa Task log di Proxmox.',
      );
    await sleep(opts.pollMs);
  }
}

function waitForTcp(
  host: string,
  port: number,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const started = Date.now();
  const attempt = (): Promise<boolean> =>
    new Promise((resolve) => {
      const s = net.connect({ host, port, timeout: 4000 });
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      const fail = () => {
        s.destroy();
        resolve(false);
      };
      s.once('timeout', fail);
      s.once('error', fail);
    }).then(async (ok) => {
      if (ok) return true;
      if (Date.now() - started > timeoutMs) return false;
      await sleep(pollMs);
      return attempt();
    });
  return attempt();
}

export interface ProvisionDeps {
  ctx: Ctx;
  client: ProxmoxClient;
  connectionId: string;
  pool: string;
  vm: VmRow;
  input: CreateVmInput;
  plan: Plan;
  log: (text: string) => void;
  ctl?: JobControl;
  /** Jeda polling; diperkecil di test. */
  pollMs?: number;
  sshWaitMs?: number;
}

/** Buat VM baru dari template dan daftarkan ke panel. TIDAK PERNAH menghapus apa pun di Proxmox. */
export async function provisionVm(d: ProvisionDeps): Promise<void> {
  const { ctx, client, plan, input, vm, log } = d;
  const pollMs = d.pollMs ?? 2000;
  const task = { timeoutMs: 15 * 60_000, pollMs };
  const tpl = plan.template;
  const target = plan.node.node;
  let step = 'mengambil nomor VM';
  let vmid: number | null = null;
  let cloned = false;
  try {
    log(`Membuat VM "${input.name}" di node ${target} dari template ${tpl.name} (#${tpl.vmid}).\n`);
    const nextId = Number(await client.get<string | number>('/cluster/nextid'));
    if (!Number.isInteger(nextId) || nextId < 100)
      throw new AppError(502, 'bad_vmid', 'Proxmox memberi nomor VM yang tidak valid.');
    vmid = nextId;
    log(`Nomor VM di Proxmox: ${vmid}.\n`);

    step = 'meng-clone template';
    log(
      `[1/6] Clone template ke storage ${input.storage}${tpl.ownerNode !== target ? ` (lintas node: ${tpl.ownerNode} ke ${target})` : ''}...\n`,
    );
    const cloneUpid = await client.post<string>(`/nodes/${tpl.ownerNode}/qemu/${tpl.vmid}/clone`, {
      newid: vmid,
      name: input.name,
      full: 1,
      storage: input.storage,
      pool: d.pool,
      description: 'Dibuat oleh Panel VM',
      ...(tpl.ownerNode !== target ? { target } : {}),
    });
    await waitTask(client, tpl.ownerNode, cloneUpid, task);
    ctx.db
      .prepare(
        'INSERT INTO vm_proxmox (vm_id, connection_id, node, vmid, template_vmid, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(vm.id, d.connectionId, target, vmid, tpl.vmid, Date.now());
    cloned = true;
    ctx.audit.record({
      vmId: vm.id,
      action: 'proxmox.vm_cloned',
      target: `${target}/${vmid}`,
      result: 'ok',
      meta: { template: tpl.vmid },
    });
    log('Clone selesai.\n');

    step = 'mengisi konfigurasi (IP, kunci SSH, spesifikasi)';
    log('[2/6] Mengisi konfigurasi: CPU, RAM, IP, user, dan kunci SSH panel...\n');
    await client.put(`/nodes/${target}/qemu/${vmid}/config`, {
      cores: input.cores,
      memory: input.memoryMb,
      ciuser: tpl.os.sshUser,
      // Proxmox meminta nilai sshkeys yang sudah di-URL-encode (di atas encoding form).
      sshkeys: encodeURIComponent(vm.ssh_public_key.trim()),
      ipconfig0: plan.ipconfig0,
      net0: `virtio,bridge=${input.bridge}${input.vlan ? `,tag=${input.vlan}` : ''}`,
      ...(plan.nameserver ? { nameserver: plan.nameserver } : {}),
    });

    step = 'memperbesar disk';
    log(`[3/6] Memperbesar disk ${tpl.diskKey} menjadi ${input.diskGb} GB...\n`);
    await client.put(`/nodes/${target}/qemu/${vmid}/resize`, {
      disk: tpl.diskKey!,
      size: `${input.diskGb}G`,
    });

    step = 'menyalakan VM';
    log('[4/6] Menyalakan VM...\n');
    await waitTask(
      client,
      target,
      await client.post<string>(`/nodes/${target}/qemu/${vmid}/status/start`),
      task,
    );

    step = 'menunggu SSH';
    log(`[5/6] Menunggu SSH di ${plan.host}:${input.sshPort} (boot pertama bisa 1-3 menit)...\n`);
    const up = await waitForTcp(
      plan.host,
      input.sshPort,
      d.sshWaitMs ?? 6 * 60_000,
      Math.max(pollMs, 1000),
    );
    if (!up)
      throw new AppError(
        504,
        'ssh_timeout',
        `VM sudah menyala tetapi SSH di ${plan.host}:${input.sshPort} belum menjawab. Periksa IP, gateway, dan firewall (VM panel harus bisa menjangkau VM baru), atau buka konsol VM di Proxmox.`,
      );

    step = 'membaca host key';
    log('[6/6] Membaca host key SSH...\n');
    const fingerprint = await scanHostKey(plan.host, input.sshPort, () => {});
    log(
      `\nHost key VM: ${fingerprint}\nLangkah terakhir untuk Anda: buka Admin > Kelola VM, pilih VM "${input.name}", pindai host key lalu setujui bila fingerprint cocok, kemudian hubungkan ke client.\n`,
    );
  } catch (e) {
    const detail =
      e instanceof AppError ? e.message : 'kesalahan di panel (detail ada di log server)';
    if (cloned) {
      log(
        `\nVM sudah dibuat di Proxmox (node ${target}, nomor ${vmid}) tetapi gagal saat ${step}. Panel TIDAK menghapusnya. Periksa di Proxmox lalu hapus manual bila tidak diperlukan, atau perbaiki masalahnya.\n`,
      );
    } else {
      log(
        `\nGagal saat ${step}. Belum ada VM yang jadi di Proxmox. Catatan VM ini di panel bisa dihapus lewat Admin > Kelola VM, lalu coba lagi setelah masalahnya diperbaiki.\n`,
      );
    }
    if (e instanceof AppError) throw e;
    ctx.log?.error({ err: e }, 'proxmox provision error');
    throw new AppError(500, 'provision_failed', `Pembuatan VM gagal saat ${step}: ${detail}.`);
  }
}

/** Buat baris VM di panel (kunci SSH khusus, semua modul aktif). VM belum dipakai sampai host key disetujui. */
export function insertVmRow(ctx: Ctx, id: string, input: CreateVmInput, plan: Plan): VmRow {
  const pair = generateKeyPair(`panel-${id.slice(0, 8)}`);
  const modules = Object.fromEntries(VM_MODULES.map((m) => [m, true]));
  ctx.db
    .prepare(
      'INSERT INTO vms (id, name, host, ssh_port, ssh_user, ssh_private_key_enc, ssh_public_key, modules_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      id,
      input.name,
      plan.host,
      input.sshPort,
      plan.template.os.sshUser,
      ctx.box.encrypt(pair.privateKey, vmKeyContext(id)),
      pair.publicKey,
      JSON.stringify(modules),
      Date.now(),
    );
  return ctx.db.prepare('SELECT * FROM vms WHERE id = ?').get(id) as VmRow;
}
