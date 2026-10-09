import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Input, JobLog, Modal, Skeleton, useToast } from '../../components';
import { api } from '../../lib/api';
import { formatBytes } from '../../lib/format';

interface OsOption {
  id: string;
  label: string;
  templateName: string;
  ownerNode: string;
  shared: boolean;
  minDiskGb: number | null;
}
interface NodeOption {
  node: string;
  online: boolean;
  cpuPercent: number | null;
  cpuCores: number | null;
  memFreeBytes: number | null;
  storages: { name: string; type: string; availBytes: number | null; shared: boolean }[];
  bridges: string[];
  osOptions: OsOption[];
}
interface Options {
  pool: string;
  nodes: NodeOption[];
}

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/;
const CIDR_RE = /^[0-9]{1,3}(?:[.][0-9]{1,3}){3}\/[0-9]{1,2}$/;
const IP_RE = /^[0-9]{1,3}(?:[.][0-9]{1,3}){3}$/;
const MEMORY = [512, 1024, 2048, 4096, 8192, 16384];

interface Form {
  node: string;
  osId: string;
  name: string;
  cores: number;
  memoryMb: number;
  diskGb: number;
  storage: string;
  bridge: string;
  vlan: string;
  ip: string;
  gateway: string;
  dns: string;
  sshPort: string;
}

const EMPTY: Form = {
  node: '',
  osId: '',
  name: '',
  cores: 2,
  memoryMb: 2048,
  diskGb: 20,
  storage: '',
  bridge: '',
  vlan: '',
  ip: '',
  gateway: '',
  dns: '',
  sshPort: '22',
};

/** Lengkapi pilihan yang kosong atau tidak berlaku di node terpilih (node, OS, storage, bridge, ukuran disk minimal). */
function withDefaults(f: Form, data: Options | undefined): Form {
  if (!data) return f;
  let next = f;
  const usable = data.nodes.filter((n) => n.online && n.osOptions.length > 0);
  if (!data.nodes.some((n) => n.node === next.node) && usable[0])
    next = { ...next, node: usable[0].node };
  const n = data.nodes.find((x) => x.node === next.node);
  if (!n) return next;
  if (!n.osOptions.some((o) => o.id === next.osId))
    next = { ...next, osId: n.osOptions[0]?.id ?? '' };
  if (!n.storages.some((s) => s.name === next.storage))
    next = {
      ...next,
      storage: (n.storages.find((s) => s.name === 'local-lvm') ?? n.storages[0])?.name ?? '',
    };
  if (!n.bridges.includes(next.bridge))
    next = { ...next, bridge: n.bridges.includes('vmbr0') ? 'vmbr0' : (n.bridges[0] ?? '') };
  const min = n.osOptions.find((o) => o.id === next.osId)?.minDiskGb ?? 0;
  if (next.diskGb < min) next = { ...next, diskGb: min };
  return next;
}

/** Wizard membuat VM dari template Proxmox. Semua isian diperiksa ulang oleh server terhadap keadaan nyata. */
export function ProxmoxCreateVm({
  connection,
  onClose,
}: {
  connection: { id: string; name: string } | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const [raw, setForm] = useState<Form>(EMPTY);
  const [started, setStarted] = useState<{ vmId: string; jobId: string; name: string } | null>(
    null,
  );

  const options = useQuery({
    queryKey: ['proxmox-options', connection?.id],
    enabled: !!connection,
    retry: false,
    queryFn: () => api<Options>(`/api/admin/proxmox/${connection!.id}/options`),
  });

  // Nilai efektif: pilihan pengguna, dilengkapi default yang masuk akal untuk node/OS yang sedang dipilih.
  const form = useMemo(() => withDefaults(raw, options.data), [raw, options.data]);
  const node = options.data?.nodes.find((n) => n.node === form.node);
  const os = node?.osOptions.find((o) => o.id === form.osId);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const create = useMutation({
    mutationFn: () =>
      api<{ vmId: string; name: string; job: { id: string } }>(
        `/api/admin/proxmox/${connection!.id}/vms`,
        {
          method: 'POST',
          body: {
            node: form.node,
            osId: form.osId,
            name: form.name.trim(),
            cores: form.cores,
            memoryMb: form.memoryMb,
            diskGb: form.diskGb,
            storage: form.storage,
            bridge: form.bridge,
            ...(form.vlan ? { vlan: Number(form.vlan) } : {}),
            ip: form.ip.trim(),
            gateway: form.gateway.trim(),
            ...(form.dns.trim() ? { dns: form.dns.trim() } : {}),
            sshPort: Number(form.sshPort) || 22,
          },
        },
      ),
    onSuccess: (r) => setStarted({ vmId: r.vmId, jobId: r.job.id, name: r.name }),
    onError: (e: Error) => toast.show('error', e.message),
  });

  const close = () => {
    setForm(EMPTY);
    setStarted(null);
    onClose();
  };

  const valid =
    !!node?.online &&
    !!os &&
    NAME_RE.test(form.name.trim()) &&
    CIDR_RE.test(form.ip.trim()) &&
    IP_RE.test(form.gateway.trim()) &&
    !!form.storage &&
    !!form.bridge &&
    form.diskGb >= (os?.minDiskGb ?? 2);

  const storage = node?.storages.find((s) => s.name === form.storage);

  return (
    <Modal
      open={!!connection}
      wide
      title={started ? `Membuat VM: ${started.name}` : `Buat VM di ${connection?.name ?? ''}`}
      onClose={close}
      footer={
        started ? (
          <>
            <Button variant="ghost" onClick={close}>
              Tutup
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Batal
            </Button>
            <Button disabled={!valid} loading={create.isPending} onClick={() => create.mutate()}>
              Buat VM
            </Button>
          </>
        )
      }
    >
      {started ? (
        <div className="flex flex-col gap-3">
          <JobLog
            vmId={started.vmId}
            jobId={started.jobId}
            onDone={(j) =>
              toast.show(
                j.status === 'succeeded' ? 'success' : 'error',
                j.status === 'succeeded'
                  ? 'VM selesai dibuat. Setujui host key-nya di Kelola VM.'
                  : 'Pembuatan VM gagal. Baca log untuk penyebab dan langkah berikutnya.',
              )
            }
          />
          <p className="text-sm text-slate-600">
            Setelah selesai, buka{' '}
            <Link className="font-medium text-info underline" to="/admin/vms" onClick={close}>
              Admin &gt; Kelola VM
            </Link>
            , pindai dan setujui host key VM, lalu hubungkan ke client. Panel tidak pernah menghapus
            VM di Proxmox; kalau pembuatan gagal di tengah, hapus VM-nya manual di Proxmox.
          </p>
        </div>
      ) : options.isLoading ? (
        <Skeleton className="h-64" />
      ) : options.error ? (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-red-900">
          {options.error.message}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-sm font-medium text-slate-700" htmlFor="pv-node">
                Node
              </label>
              <select
                id="pv-node"
                className="mt-1.5 h-10 w-full px-3"
                value={form.node}
                onChange={(e) => set('node', e.target.value)}
              >
                {options.data?.nodes.map((n) => (
                  <option
                    key={n.node}
                    value={n.node}
                    disabled={!n.online || n.osOptions.length === 0}
                  >
                    {n.node}
                    {!n.online
                      ? ' (offline)'
                      : n.osOptions.length === 0
                        ? ' (belum ada template)'
                        : ` — CPU ${n.cpuPercent ?? '?'}%, RAM bebas ${n.memFreeBytes != null ? formatBytes(n.memFreeBytes) : '?'}`}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700" htmlFor="pv-os">
                Sistem operasi
              </label>
              <select
                id="pv-os"
                className="mt-1.5 h-10 w-full px-3"
                value={form.osId}
                onChange={(e) => set('osId', e.target.value)}
              >
                {(node?.osOptions ?? []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              {os && (
                <p className="mt-1 text-xs text-slate-500">
                  Template {os.templateName}
                  {os.ownerNode !== form.node ? ` (di node ${os.ownerNode}, storage bersama)` : ''}.
                </p>
              )}
            </div>
          </div>

          <Input
            label="Nama VM"
            value={form.name}
            onChange={(e) => set('name', e.target.value.toLowerCase())}
            hint="Huruf kecil, angka, dan tanda hubung (2-40 karakter). Dipakai juga sebagai nama host. Contoh: web-teman1."
            error={form.name && !NAME_RE.test(form.name.trim()) ? 'Nama tidak valid.' : undefined}
            autoComplete="off"
          />

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="text-sm font-medium text-slate-700" htmlFor="pv-cpu">
                CPU (inti)
              </label>
              <select
                id="pv-cpu"
                className="mt-1.5 h-10 w-full px-3"
                value={form.cores}
                onChange={(e) => set('cores', Number(e.target.value))}
              >
                {[1, 2, 4, 8].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700" htmlFor="pv-mem">
                RAM
              </label>
              <select
                id="pv-mem"
                className="mt-1.5 h-10 w-full px-3"
                value={form.memoryMb}
                onChange={(e) => set('memoryMb', Number(e.target.value))}
              >
                {MEMORY.map((m) => (
                  <option key={m} value={m}>
                    {m >= 1024 ? `${m / 1024} GB` : `${m} MB`}
                  </option>
                ))}
              </select>
            </div>
            <Input
              label="Disk (GB)"
              type="number"
              min={os?.minDiskGb ?? 2}
              value={form.diskGb}
              onChange={(e) => set('diskGb', Number(e.target.value))}
              hint={os?.minDiskGb ? `Minimal ${os.minDiskGb} GB.` : undefined}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="text-sm font-medium text-slate-700" htmlFor="pv-st">
                Storage
              </label>
              <select
                id="pv-st"
                className="mt-1.5 h-10 w-full px-3"
                value={form.storage}
                onChange={(e) => set('storage', e.target.value)}
              >
                {node?.storages.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                    {s.availBytes != null ? ` (${formatBytes(s.availBytes)} bebas)` : ''}
                  </option>
                ))}
              </select>
              {storage?.shared && (
                <p className="mt-1 text-xs text-amber-700">
                  Storage bersama (jaringan): lebih lambat untuk VM yang berjalan. Disarankan
                  local-lvm.
                </p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700" htmlFor="pv-br">
                Bridge
              </label>
              <select
                id="pv-br"
                className="mt-1.5 h-10 w-full px-3"
                value={form.bridge}
                onChange={(e) => set('bridge', e.target.value)}
              >
                {node?.bridges.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
            <Input
              label="VLAN (opsional)"
              inputMode="numeric"
              value={form.vlan}
              onChange={(e) => set('vlan', e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
              hint="Kosongkan bila tidak memakai VLAN."
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="IP VM beserta prefix"
              value={form.ip}
              onChange={(e) => {
                const ip = e.target.value.trim();
                setForm((f) => {
                  // Saran gateway: .1 di subnet yang sama, selama kolom gateway belum diisi sendiri.
                  const m =
                    /^([0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3})[.][0-9]{1,3}\/[0-9]{1,2}$/.exec(ip);
                  const guess = m ? `${m[1]}.1` : '';
                  const auto =
                    f.gateway === '' || f.gateway === (/^([0-9.]+)\./.exec(f.ip)?.[1] ?? '') + '.1';
                  return { ...f, ip, gateway: auto && guess ? guess : f.gateway };
                });
              }}
              hint="Contoh: 192.168.10.50/24. Pastikan IP belum dipakai perangkat lain."
              error={
                form.ip && !CIDR_RE.test(form.ip.trim())
                  ? 'Format harus 192.168.10.50/24.'
                  : undefined
              }
              autoComplete="off"
            />
            <Input
              label="Gateway"
              value={form.gateway}
              onChange={(e) => set('gateway', e.target.value.trim())}
              hint="Contoh: 192.168.10.1."
              error={form.gateway && !IP_RE.test(form.gateway) ? 'Bukan alamat IPv4.' : undefined}
              autoComplete="off"
            />
            <Input
              label="DNS (opsional)"
              value={form.dns}
              onChange={(e) => set('dns', e.target.value)}
              hint="Maksimal 2 alamat IPv4, dipisah spasi. Kosong = bawaan Proxmox."
              autoComplete="off"
            />
            <Input
              label="Port SSH"
              inputMode="numeric"
              value={form.sshPort}
              onChange={(e) => set('sshPort', e.target.value.replace(/[^0-9]/g, '').slice(0, 5))}
              hint="Bawaan 22."
            />
          </div>

          <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
            VM dibuat sebagai clone penuh dari template, ditaruh di pool{' '}
            <code>{options.data?.pool}</code>, dengan user SSH dan kunci khusus panel. Panel hanya
            membuat dan menyalakan VM; tidak pernah menghapus atau mematikan apa pun di Proxmox.
            Pembuatan berjalan sebagai proses latar belakang dan bisa 2-6 menit.
          </p>
        </div>
      )}
    </Modal>
  );
}
