import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleHelp, Cloud, Plus, XCircle } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  Button,
  ConfirmDialog,
  Input,
  Modal,
  PageHeader,
  Table,
  useToast,
} from '../../components';
import { api } from '../../lib/api';
import { formatBytes, formatTime } from '../../lib/format';

interface Endpoint {
  url: string;
  fingerprint: string;
}
interface Connection {
  id: string;
  name: string;
  endpoints: Endpoint[];
  tokenId: string;
  pool: string;
  createdAt: number;
  lastOkAt: number | null;
}
interface NodeInventory {
  node: string;
  online: boolean;
  cpuPercent: number | null;
  cpuCores: number | null;
  memFreeBytes: number | null;
  memTotalBytes: number | null;
  templates: { vmid: number; name: string; os: { id: string; label: string; sshUser: string } }[];
  ignoredTemplates: number;
  storages: { name: string; type: string; availBytes: number | null; totalBytes: number | null }[];
  bridges: string[];
  error?: string;
}
interface TestResult {
  connection: Connection;
  inventory: { version: string | null; nodes: NodeInventory[] };
  permissions: { path: string; purpose: string; missing: string[]; unknown?: boolean }[];
}
interface Scanned {
  url: string;
  fingerprint: string;
  subject: string;
}

const URL_RE = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/;

function AddConnection({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    name: '',
    urls: '',
    tokenId: '',
    tokenSecret: '',
    pool: 'panel',
  });
  const [scanned, setScanned] = useState<Scanned[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const urls = form.urls
    .split('\n')
    .map((u) => u.trim())
    .filter(Boolean);
  const urlsValid = urls.length > 0 && urls.length <= 5 && urls.every((u) => URL_RE.test(u));

  const scan = useMutation({
    mutationFn: async () => {
      const out: Scanned[] = [];
      for (const url of urls)
        out.push(
          await api<Scanned>('/api/admin/proxmox/scan-cert', { method: 'POST', body: { url } }),
        );
      return out;
    },
    onSuccess: (r) => {
      setScanned(r);
      setConfirmed(false);
    },
    onError: (e: Error) => toast.show('error', e.message),
  });
  const create = useMutation({
    mutationFn: () =>
      api<Connection>('/api/admin/proxmox', {
        method: 'POST',
        body: {
          name: form.name.trim(),
          endpoints: scanned.map((s) => ({ url: s.url, fingerprint: s.fingerprint })),
          tokenId: form.tokenId.trim(),
          tokenSecret: form.tokenSecret.trim(),
          pool: form.pool.trim() || 'panel',
        },
      }),
    onSuccess: async (c) => {
      toast.show(
        'success',
        `Koneksi "${c.name}" tersimpan. Klik Tes untuk melihat node dan template.`,
      );
      setForm({ name: '', urls: '', tokenId: '', tokenSecret: '', pool: 'panel' });
      setScanned([]);
      setConfirmed(false);
      onClose();
      await qc.invalidateQueries({ queryKey: ['proxmox'] });
    },
    onError: (e: Error) => toast.show('error', e.message),
  });

  const ready =
    scanned.length === urls.length &&
    scanned.length > 0 &&
    confirmed &&
    form.name.trim().length >= 2 &&
    form.tokenId.includes('!') &&
    form.tokenSecret.trim().length >= 8;

  return (
    <Modal
      open={open}
      wide
      title="Tambah koneksi Proxmox"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Batal
          </Button>
          <Button disabled={!ready} loading={create.isPending} onClick={() => create.mutate()}>
            Uji dan simpan
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          label="Nama koneksi"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          hint="Bebas, mis. Cluster rumah."
        />
        <div>
          <label className="text-sm font-medium text-slate-700" htmlFor="px-urls">
            Alamat node (satu per baris)
          </label>
          <textarea
            id="px-urls"
            rows={3}
            className="mt-1.5 w-full rounded-lg border border-slate-300 p-2 font-mono text-sm"
            placeholder={
              'https://192.168.1.11:8006\nhttps://192.168.1.12:8006\nhttps://192.168.1.13:8006'
            }
            value={form.urls}
            onChange={(e) => {
              setForm((f) => ({ ...f, urls: e.target.value }));
              setScanned([]);
              setConfirmed(false);
            }}
          />
          <p className="mt-1 text-sm text-slate-500">
            Untuk cluster, isi ketiga node: bila satu mati, panel memakai yang lain. Format
            https://host:8006 tanpa path.
          </p>
        </div>
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={!urlsValid}
            loading={scan.isPending}
            onClick={() => scan.mutate()}
          >
            Ambil sertifikat
          </Button>
          {urls.length > 0 && !urlsValid && (
            <p role="alert" className="mt-1 text-sm text-error">
              Alamat harus berbentuk https://host:8006 (maksimal 5, tanpa path).
            </p>
          )}
        </div>
        {scanned.length > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">
            <p className="font-medium text-amber-900">Cocokkan fingerprint dengan Proxmox</p>
            <p className="mt-1 text-amber-900">
              Di Proxmox: Datacenter, pilih node, System, Certificates. Fingerprint SHA-256 di sana
              harus sama persis. Panel hanya mau terhubung ke sertifikat yang Anda konfirmasi ini.
            </p>
            <ul className="mt-2 space-y-2">
              {scanned.map((s) => (
                <li key={s.url}>
                  <span className="font-medium">{s.url}</span>
                  {s.subject && <span className="text-slate-600"> ({s.subject})</span>}
                  <code className="mt-0.5 block break-all text-xs">{s.fingerprint}</code>
                </li>
              ))}
            </ul>
            <label className="mt-3 flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>Saya sudah mencocokkan fingerprint di atas dengan yang ada di Proxmox.</span>
            </label>
          </div>
        )}
        <Input
          label="Token ID"
          value={form.tokenId}
          onChange={(e) => setForm((f) => ({ ...f, tokenId: e.target.value }))}
          hint="Berbentuk user@realm!namatoken, mis. panel@pve!panel."
          autoComplete="off"
        />
        <Input
          label="Secret token"
          type="password"
          value={form.tokenSecret}
          onChange={(e) => setForm((f) => ({ ...f, tokenSecret: e.target.value }))}
          hint="Disimpan terenkripsi dan tidak pernah ditampilkan lagi."
          autoComplete="new-password"
        />
        <Input
          label="Pool"
          value={form.pool}
          onChange={(e) => setForm((f) => ({ ...f, pool: e.target.value }))}
          hint="Pool Proxmox tempat VM panel ditempatkan (bawaan: panel)."
        />
      </div>
    </Modal>
  );
}

function TestPanel({ result }: { result: TestResult }) {
  const { inventory, permissions } = result;
  const problems = permissions.filter((p) => p.missing.length > 0);
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p>
        Terhubung ke Proxmox VE <strong>{inventory.version ?? '(versi tidak terbaca)'}</strong>.
        Ditemukan {inventory.nodes.length} node. Pemeriksaan ini hanya membaca; tidak ada yang
        diubah di Proxmox.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {inventory.nodes.map((n) => (
          <div key={n.node} className="rounded-xl border border-slate-200 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-navy">{n.node}</span>
              <Badge tone={n.online ? 'success' : 'error'} dot>
                {n.online ? 'Online' : 'Offline'}
              </Badge>
            </div>
            {n.online && (
              <>
                <p className="mt-1 text-slate-600">
                  CPU {n.cpuPercent ?? '?'}% dari {n.cpuCores ?? '?'} inti · RAM bebas{' '}
                  {n.memFreeBytes != null ? formatBytes(n.memFreeBytes) : '?'}
                </p>
                <p className="mt-2 font-medium">Template</p>
                {n.templates.length === 0 ? (
                  <p className="text-amber-700">
                    Belum ada template Debian/Ubuntu (nama tpl-debian12-… atau tpl-ubuntu2404-…).
                  </p>
                ) : (
                  <ul className="list-disc pl-5">
                    {n.templates.map((t) => (
                      <li key={t.vmid}>
                        {t.os.label}{' '}
                        <span className="text-slate-500">
                          (#{t.vmid}, {t.name})
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {n.ignoredTemplates > 0 && (
                  <p className="text-xs text-slate-500">
                    {n.ignoredTemplates} template lain diabaikan (nama bukan Debian/Ubuntu).
                  </p>
                )}
                <p className="mt-2 font-medium">Storage</p>
                <p className="text-slate-600">
                  {n.storages.length
                    ? n.storages
                        .map(
                          (s) =>
                            `${s.name}${s.availBytes != null ? ` (${formatBytes(s.availBytes)} bebas)` : ''}`,
                        )
                        .join(', ')
                    : 'tidak ada'}
                </p>
                <p className="mt-2 font-medium">Bridge</p>
                <p className="text-slate-600">{n.bridges.join(', ') || 'tidak ada'}</p>
                {n.error && (
                  <p className="mt-1 text-xs text-amber-700">
                    Sebagian data gagal dibaca: {n.error}
                  </p>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      <div>
        <p className="font-medium">Hak token untuk membuat VM (saran)</p>
        {problems.length === 0 ? (
          <p className="mt-1 text-green-700">Semua hak yang diperiksa sudah cukup.</p>
        ) : (
          <p className="mt-1 text-amber-700">
            {problems.length} bagian masih kurang hak. Lengkapi sesuai docs/PROXMOX.md sebelum
            membuat VM dari panel.
          </p>
        )}
        <ul className="mt-2 space-y-1">
          {permissions.map((p) => (
            <li key={p.path} className="flex items-start gap-2">
              {p.unknown ? (
                <CircleHelp aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
              ) : p.missing.length ? (
                <XCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-error" />
              ) : (
                <CheckCircle2
                  aria-hidden="true"
                  className="mt-0.5 h-4 w-4 shrink-0 text-green-600"
                />
              )}
              <span>
                <code>{p.path}</code> <span className="text-slate-500">({p.purpose})</span>
                {p.unknown && <span className="text-slate-500"> tidak bisa diperiksa</span>}
                {p.missing.length > 0 && (
                  <span className="text-error"> kurang: {p.missing.join(', ')}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-slate-500">
          Pemeriksaan hak bersifat saran dan dibuat menurut dokumentasi Proxmox VE 8; hasil nyata
          terlihat saat VM dibuat.
        </p>
      </div>
    </div>
  );
}

export function AdminProxmoxPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['proxmox'],
    queryFn: () => api<{ items: Connection[] }>('/api/admin/proxmox'),
  });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Connection | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);

  const test = useMutation({
    mutationFn: (c: Connection) =>
      api<TestResult>(`/api/admin/proxmox/${c.id}/test`, { method: 'POST', body: {} }),
    onSuccess: async (r) => {
      setResult(r);
      await qc.invalidateQueries({ queryKey: ['proxmox'] });
    },
    onError: (e: Error) => toast.show('error', e.message),
  });
  const remove = useMutation({
    mutationFn: (c: Connection) => api(`/api/admin/proxmox/${c.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.show('success', 'Catatan koneksi dihapus dari panel. Proxmox tidak diubah.');
      setRemoving(null);
      await qc.invalidateQueries({ queryKey: ['proxmox'] });
    },
    onError: (e: Error) => toast.show('error', e.message),
  });

  return (
    <div>
      <PageHeader
        icon={<Cloud className="h-5 w-5" />}
        title="Proxmox"
        description="Hubungkan panel ke Proxmox (satu cluster atau server) agar VM bisa dibuat dari panel. Tahap ini hanya membaca: panel tidak mengubah atau menghapus apa pun di Proxmox."
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
            Tambah koneksi
          </Button>
        }
      />
      <div className="mt-4">
        <Table
          rows={list.data?.items}
          loading={list.isLoading}
          error={list.error?.message}
          rowKey={(c) => c.id}
          emptyMessage='Belum ada koneksi. Buat API token di Proxmox (lihat docs/PROXMOX.md), lalu klik "Tambah koneksi".'
          columns={[
            {
              header: 'Nama',
              render: (c) => (
                <div>
                  <p className="font-medium text-navy">{c.name}</p>
                  <p className="text-xs text-slate-500">
                    {c.endpoints.length} alamat · pool {c.pool}
                  </p>
                </div>
              ),
            },
            { header: 'Token', render: (c) => <code className="text-xs">{c.tokenId}</code> },
            {
              header: 'Terakhir berhasil',
              render: (c) => (c.lastOkAt ? formatTime(c.lastOkAt) : 'Belum'),
            },
            {
              header: 'Aksi',
              render: (c) => (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    loading={test.isPending && test.variables?.id === c.id}
                    onClick={() => test.mutate(c)}
                  >
                    Tes
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="!text-error"
                    onClick={() => setRemoving(c)}
                  >
                    Hapus catatan
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </div>

      <AddConnection open={adding} onClose={() => setAdding(false)} />

      <Modal
        open={!!result}
        wide
        title={`Hasil tes: ${result?.connection.name ?? ''}`}
        onClose={() => setResult(null)}
        footer={<Button onClick={() => setResult(null)}>Tutup</Button>}
      >
        {result && <TestPanel result={result} />}
      </Modal>

      <ConfirmDialog
        open={!!removing}
        title="Hapus catatan koneksi?"
        message={
          removing
            ? `Koneksi "${removing.name}" dihapus dari panel, termasuk token yang tersimpan. Tidak ada yang berubah di Proxmox. Token-nya sebaiknya dihapus juga di Proxmox bila tidak dipakai lagi.`
            : ''
        }
        confirmLabel="Hapus catatan"
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}
