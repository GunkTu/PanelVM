import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { UserPlus, Users } from 'lucide-react';
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
import { formatTime } from '../../lib/format';
import type { ClientUser } from '../../lib/types';

type Pending = { kind: 'suspend' | 'reset-2fa'; user: ClientUser } | null;

export function AdminUsersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error } = useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ items: ClientUser[] }>('/api/users'),
  });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ email: '', password: '' });
  const [pending, setPending] = useState<Pending>(null);
  const [resetFor, setResetFor] = useState<ClientUser | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [limitFor, setLimitFor] = useState<ClientUser | null>(null);
  const [limitValue, setLimitValue] = useState('');

  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });

  const create = useMutation({
    mutationFn: () => api('/api/users', { method: 'POST', body: form }),
    onSuccess: async () => {
      await refresh();
      toast.show(
        'success',
        `Akun ${form.email} dibuat. Berikan password awal ke pengguna lewat jalur aman; 2FA diaktifkan saat login pertama.`,
      );
      setForm({ email: '', password: '' });
      setCreating(false);
    },
  });
  const setStatus = useMutation({
    mutationFn: (v: { user: ClientUser; status: 'active' | 'suspended' }) =>
      api(`/api/users/${v.user.id}`, { method: 'PATCH', body: { status: v.status } }),
    onSuccess: async (_r, v) => {
      await refresh();
      toast.show(
        'success',
        v.status === 'suspended'
          ? `${v.user.email} ditangguhkan dan semua sesinya diputus.`
          : `${v.user.email} diaktifkan kembali.`,
      );
      setPending(null);
    },
    onError: (e) => toast.show('error', e.message),
  });
  const reset2fa = useMutation({
    mutationFn: (u: ClientUser) =>
      api(`/api/users/${u.id}/reset-2fa`, { method: 'POST', body: {} }),
    onSuccess: async (_r, u) => {
      await refresh();
      toast.show(
        'success',
        `2FA ${u.email} direset. Pengguna akan diminta mengatur ulang saat login berikutnya.`,
      );
      setPending(null);
    },
    onError: (e) => toast.show('error', e.message),
  });
  const resetPw = useMutation({
    mutationFn: () =>
      api(`/api/users/${resetFor?.id}/reset-password`, {
        method: 'POST',
        body: { password: newPassword },
      }),
    onSuccess: () => {
      toast.show(
        'success',
        `Password ${resetFor?.email} diganti dan sesinya diputus. Berikan password baru lewat jalur aman.`,
      );
      setResetFor(null);
      setNewPassword('');
    },
  });

  const setLimit = useMutation({
    mutationFn: () =>
      api(`/api/users/${limitFor?.id}`, {
        method: 'PATCH',
        body: { maxSites: Number(limitValue) },
      }),
    onSuccess: async () => {
      await refresh();
      toast.show('success', `Batas situs ${limitFor?.email} diatur ke ${limitValue}.`);
      setLimitFor(null);
    },
    onError: (e) => toast.show('error', e.message),
  });
  const limitValid = /^\d{1,4}$/.test(limitValue) && Number(limitValue) <= 1000;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <div>
      <PageHeader
        icon={<Users className="h-5 w-5" />}
        title="Kelola Pengguna"
        description="Buat akun client, tangguhkan akses, dan reset 2FA atau password. Akun baru wajib mengaktifkan 2FA saat login pertama."
        actions={
          <Button icon={<UserPlus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            Tambah client
          </Button>
        }
      />
      <div>
        <Table
          rows={data?.items}
          loading={isLoading}
          error={error?.message}
          rowKey={(u) => u.id}
          emptyMessage="Belum ada client. Klik Tambah client untuk membuat akun pertama."
          columns={[
            { header: 'Email', render: (u) => <span className="font-medium">{u.email}</span> },
            {
              header: 'Status',
              render: (u) => (
                <Badge tone={u.status === 'active' ? 'success' : 'error'}>
                  {u.status === 'active' ? 'Aktif' : 'Ditangguhkan'}
                </Badge>
              ),
            },
            {
              header: '2FA',
              render: (u) =>
                u.totpEnabled ? (
                  <Badge tone="success">Aktif</Badge>
                ) : (
                  <Badge tone="warning">Belum</Badge>
                ),
            },
            { header: 'VM', render: (u) => u.vm?.name ?? '-' },
            {
              header: 'Situs web',
              render: (u) => (
                <button
                  type="button"
                  title="Ubah batas situs"
                  className="rounded px-1.5 py-0.5 text-sm hover:bg-slate-100"
                  onClick={() => {
                    setLimitFor(u);
                    setLimitValue(String(u.maxSites));
                  }}
                >
                  {u.siteCount} / {u.maxSites}
                </button>
              ),
            },
            { header: 'Login terakhir', render: (u) => formatTime(u.lastLoginAt) },
            {
              header: 'Aksi',
              render: (u) => (
                <div className="flex flex-wrap gap-1">
                  {u.status === 'active' ? (
                    <Button
                      variant="ghost"
                      onClick={() => setPending({ kind: 'suspend', user: u })}
                    >
                      Tangguhkan
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      onClick={() => setStatus.mutate({ user: u, status: 'active' })}
                    >
                      Aktifkan
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    onClick={() => setPending({ kind: 'reset-2fa', user: u })}
                  >
                    Reset 2FA
                  </Button>
                  <Button variant="ghost" onClick={() => setResetFor(u)}>
                    Reset password
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </div>

      <Modal open={creating} title="Tambah client" onClose={() => setCreating(false)}>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Input
            label="Email"
            type="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            required
          />
          <Input
            label="Password awal"
            type="password"
            autoComplete="new-password"
            hint="Minimal 12 karakter. Pengguna bisa menggantinya setelah masuk."
            value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            required
          />
          {create.error && (
            <p role="alert" className="text-sm text-error">
              {create.error.message}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Batal
            </Button>
            <Button type="submit" loading={create.isPending}>
              Buat akun
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={!!resetFor}
        title={`Reset password: ${resetFor?.email ?? ''}`}
        onClose={() => setResetFor(null)}
      >
        <div className="flex flex-col gap-3">
          <Input
            label="Password baru"
            type="password"
            autoComplete="new-password"
            hint="Minimal 12 karakter. Semua sesi pengguna ini akan diputus."
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          {resetPw.error && (
            <p role="alert" className="text-sm text-error">
              {resetPw.error.message}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setResetFor(null)}>
              Batal
            </Button>
            <Button loading={resetPw.isPending} onClick={() => resetPw.mutate()}>
              Ganti password
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!limitFor}
        title={`Batas situs web: ${limitFor?.email ?? ''}`}
        onClose={() => setLimitFor(null)}
      >
        <div className="flex flex-col gap-3">
          <Input
            label="Maksimal situs web"
            type="number"
            min={0}
            max={1000}
            hint={`Saat ini terpakai ${limitFor?.siteCount ?? 0}. Isi 0 untuk melarang membuat situs baru (situs yang sudah ada tetap jalan). Maksimal 1000.`}
            value={limitValue}
            onChange={(e) => setLimitValue(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setLimitFor(null)}>
              Batal
            </Button>
            <Button
              disabled={!limitValid}
              loading={setLimit.isPending}
              onClick={() => setLimit.mutate()}
            >
              Simpan
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={pending?.kind === 'suspend'}
        title="Tangguhkan akun"
        message={`${pending?.user.email ?? ''} langsung kehilangan akses dan semua sesi terminalnya diputus.`}
        confirmLabel="Tangguhkan"
        loading={setStatus.isPending}
        onConfirm={() => pending && setStatus.mutate({ user: pending.user, status: 'suspended' })}
        onCancel={() => setPending(null)}
      />
      <ConfirmDialog
        open={pending?.kind === 'reset-2fa'}
        title="Reset 2FA"
        message={`2FA dan recovery code ${pending?.user.email ?? ''} dihapus, dan semua sesinya diputus. Lakukan hanya setelah memastikan identitas pengguna.`}
        confirmLabel="Reset 2FA"
        loading={reset2fa.isPending}
        onConfirm={() => pending && reset2fa.mutate(pending.user)}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
