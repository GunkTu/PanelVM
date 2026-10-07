import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Plus, Server } from 'lucide-react';
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
import type { ClientUser, Modules, Vm } from '../../lib/types';

const MODULE_LABELS: Record<keyof Modules, string> = {
  terminal: 'Terminal',
  files: 'File manager',
  database: 'Database',
  monitoring: 'Monitoring',
  services: 'Service',
  software: 'Aplikasi (installer)',
  sites: 'Situs Web',
};
const tone = { online: 'success', offline: 'error', unknown: 'neutral' } as const;
const label = { online: 'Online', offline: 'Offline', unknown: 'Belum dicek' } as const;

function CreateVmModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ name: '', host: '', sshPort: '22', sshUser: 'root' });
  const create = useMutation({
    mutationFn: () =>
      api<Vm>('/api/vms', { method: 'POST', body: { ...form, sshPort: Number(form.sshPort) } }),
    onSuccess: async (vm) => {
      await qc.invalidateQueries({ queryKey: ['admin-vms'] });
      toast.show(
        'success',
        `VM "${vm.name}" ditambahkan. Lanjut: buka Kelola, pasang public key di VM, lalu setujui host key.`,
      );
      setForm({ name: '', host: '', sshPort: '22', sshUser: 'root' });
      onClose();
    },
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Modal open={open} title="Tambah VM" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Input label="Nama VM" value={form.name} onChange={set('name')} required />
        <Input label="Host (IP atau nama)" value={form.host} onChange={set('host')} required />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Port SSH"
            inputMode="numeric"
            value={form.sshPort}
            onChange={set('sshPort')}
            required
          />
          <Input label="User SSH" value={form.sshUser} onChange={set('sshUser')} required />
        </div>
        <p className="text-sm text-slate-500">
          Panel membuat kunci SSH khusus untuk VM ini. Private key tidak pernah keluar dari server
          panel.
        </p>
        {create.error && (
          <p role="alert" className="text-sm text-error">
            {create.error.message}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Batal
          </Button>
          <Button type="submit" loading={create.isPending}>
            Tambah
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ManageVmModal({ vm, onClose }: { vm: Vm; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [scan, setScan] = useState<{ fingerprint: string; changed: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [modules, setModules] = useState<Modules>(vm.modules);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-vms'] });
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ items: ClientUser[] }>('/api/users'),
  });

  const scanM = useMutation({
    mutationFn: () =>
      api<{ fingerprint: string; changed: boolean }>(`/api/vms/${vm.id}/host-key/scan`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: setScan,
  });
  const approve = useMutation({
    mutationFn: () =>
      api<Vm>(`/api/vms/${vm.id}/host-key/approve`, {
        method: 'POST',
        body: { fingerprint: scan?.fingerprint },
      }),
    onSuccess: async () => {
      setScan(null);
      await refresh();
      toast.show(
        'success',
        'Host key disetujui. Klik "Tes koneksi" untuk memastikan panel bisa masuk.',
      );
    },
  });
  const test = useMutation({
    mutationFn: () => api<Vm>(`/api/vms/${vm.id}/test`, { method: 'POST', body: {} }),
    onSuccess: async () => {
      await refresh();
      toast.show('success', 'Koneksi SSH berhasil. VM online.');
    },
    onError: async () => refresh(),
  });
  const assign = useMutation({
    mutationFn: (userId: string | null) =>
      api<Vm>(`/api/vms/${vm.id}/assignment`, { method: 'PUT', body: { userId } }),
    onSuccess: async () => {
      await Promise.all([refresh(), qc.invalidateQueries({ queryKey: ['users'] })]);
      toast.show('success', 'Akses client diperbarui.');
    },
  });
  const saveModules = useMutation({
    mutationFn: () => api<Vm>(`/api/vms/${vm.id}`, { method: 'PATCH', body: { modules } }),
    onSuccess: async () => {
      await refresh();
      toast.show('success', 'Modul VM disimpan.');
    },
  });
  const del = useMutation({
    mutationFn: () => api(`/api/vms/${vm.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await refresh();
      toast.show('success', `VM "${vm.name}" dihapus dari panel.`);
      onClose();
    },
  });
  const errors = [
    scanM.error,
    approve.error,
    test.error,
    assign.error,
    saveModules.error,
    del.error,
  ].filter(Boolean);

  const candidates = (users.data?.items ?? []).filter(
    (u) => u.status === 'active' && (!u.vm || u.vm.id === vm.id),
  );

  return (
    <Modal
      open
      title={`Kelola VM: ${vm.name}`}
      onClose={onClose}
      wide
      footer={
        <Button variant="ghost" onClick={onClose}>
          Tutup
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        {errors.map((e, i) => (
          <p
            key={i}
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"
          >
            {e!.message}
          </p>
        ))}

        <section>
          <h3 className="font-semibold text-navy">1. Public key panel</h3>
          <p className="mt-1 text-slate-600">
            Tambahkan baris ini ke <code>~/.ssh/authorized_keys</code> milik user{' '}
            <code>{vm.sshUser}</code> di VM.
          </p>
          <textarea
            readOnly
            rows={3}
            className="mt-2 w-full rounded-md border border-slate-300 p-2 font-mono text-xs"
            value={vm.publicKey ?? ''}
          />
          <Button
            variant="ghost"
            className="mt-1"
            onClick={() => void navigator.clipboard?.writeText(vm.publicKey ?? '')}
          >
            Salin
          </Button>
        </section>

        <section>
          <h3 className="font-semibold text-navy">2. Host key SSH</h3>
          <p className="mt-1">
            Status:{' '}
            {vm.hostKeyApproved ? (
              <Badge tone="success">Disetujui</Badge>
            ) : (
              <Badge tone="warning">Belum disetujui</Badge>
            )}
            {vm.hostKeyFingerprint && (
              <span className="ml-2 break-all font-mono text-xs">{vm.hostKeyFingerprint}</span>
            )}
          </p>
          <Button
            variant="secondary"
            className="mt-2"
            loading={scanM.isPending}
            onClick={() => scanM.mutate()}
          >
            Pindai host key
          </Button>
          {scan && (
            <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
              {scan.changed && (
                <p className="mb-2 font-semibold text-error">
                  Peringatan: fingerprint berbeda dari yang disetujui sebelumnya. Setujui hanya bila
                  VM memang dibangun ulang.
                </p>
              )}
              <p>Fingerprint yang disajikan VM:</p>
              <p className="break-all font-mono text-xs">{scan.fingerprint}</p>
              <p className="mt-1 text-slate-600">
                Cocokkan dengan hasil <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>{' '}
                di VM sebelum menyetujui.
              </p>
              <Button className="mt-2" loading={approve.isPending} onClick={() => approve.mutate()}>
                Setujui fingerprint ini
              </Button>
            </div>
          )}
        </section>

        <section>
          <h3 className="font-semibold text-navy">3. Koneksi</h3>
          <Button
            variant="secondary"
            className="mt-2"
            loading={test.isPending}
            disabled={!vm.hostKeyApproved}
            onClick={() => test.mutate()}
          >
            Tes koneksi
          </Button>
          {!vm.hostKeyApproved && (
            <span className="ml-2 text-slate-500">Setujui host key dulu.</span>
          )}
        </section>

        <section>
          <h3 className="font-semibold text-navy">Client pemilik VM</h3>
          <select
            aria-label="Client pemilik VM"
            className="mt-2 w-full h-10 px-3"
            value={vm.assignedTo?.id ?? ''}
            disabled={assign.isPending}
            onChange={(e) => assign.mutate(e.target.value || null)}
          >
            <option value="">(Tidak ada)</option>
            {candidates.map((u) => (
              <option key={u.id} value={u.id}>
                {u.email}
              </option>
            ))}
          </select>
          <p className="mt-1 text-slate-500">
            Mengubah pemilik langsung memutus sesi terminal yang sedang berjalan di VM ini.
          </p>
        </section>

        <section>
          <h3 className="font-semibold text-navy">Modul aktif</h3>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {(Object.keys(MODULE_LABELS) as (keyof Modules)[]).map((m) => (
              <label key={m} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={modules[m]}
                  onChange={(e) => setModules((s) => ({ ...s, [m]: e.target.checked }))}
                />
                {MODULE_LABELS[m]}
              </label>
            ))}
          </div>
          <Button
            variant="secondary"
            className="mt-2"
            loading={saveModules.isPending}
            onClick={() => saveModules.mutate()}
          >
            Simpan modul
          </Button>
        </section>

        <section className="border-t border-slate-200 pt-4">
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            Hapus VM dari panel
          </Button>
        </section>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title="Hapus VM dari panel"
        message="VM tidak dihapus dari Proxmox, hanya dilepas dari panel beserta kunci SSH-nya. Sesi terminal yang berjalan akan diputus."
        requireText={vm.name}
        confirmLabel="Hapus"
        loading={del.isPending}
        onConfirm={() => del.mutate()}
        onCancel={() => setConfirmDelete(false)}
      />
    </Modal>
  );
}

export function AdminVmsPage() {
  const [creating, setCreating] = useState(false);
  const [managingId, setManagingId] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-vms'],
    queryFn: () => api<{ items: Vm[] }>('/api/vms'),
  });
  const managing = data?.items.find((v) => v.id === managingId);

  return (
    <div>
      <PageHeader
        icon={<Server className="h-5 w-5" />}
        title="Kelola VM"
        description="Daftarkan VM, setujui host key SSH, hubungkan ke client, dan atur modul yang aktif."
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            Tambah VM
          </Button>
        }
      />
      <div>
        <Table
          rows={data?.items}
          loading={isLoading}
          error={error?.message}
          rowKey={(v) => v.id}
          emptyMessage="Belum ada VM. Klik Tambah VM untuk mendaftarkan VM pertama."
          columns={[
            { header: 'Nama', render: (v) => <span className="font-medium">{v.name}</span> },
            { header: 'Alamat', render: (v) => `${v.sshUser}@${v.host}:${v.sshPort}` },
            {
              header: 'Status',
              render: (v) => <Badge tone={tone[v.status]}>{label[v.status]}</Badge>,
            },
            {
              header: 'Host key',
              render: (v) =>
                v.hostKeyApproved ? (
                  <Badge tone="success">Disetujui</Badge>
                ) : (
                  <Badge tone="warning">Belum</Badge>
                ),
            },
            { header: 'Client', render: (v) => v.assignedTo?.email ?? '-' },
            {
              header: '',
              render: (v) => (
                <Button variant="ghost" onClick={() => setManagingId(v.id)}>
                  Kelola
                </Button>
              ),
            },
          ]}
        />
      </div>
      <CreateVmModal open={creating} onClose={() => setCreating(false)} />
      {managing && (
        <ManageVmModal key={managing.id} vm={managing} onClose={() => setManagingId(null)} />
      )}
    </div>
  );
}
