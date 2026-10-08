import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Copy, ExternalLink, Eye, Lock, Plus, Radio, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  Skeleton,
  useToast,
} from '../../components';
import { api } from '../../lib/api';
import { formatRemaining, formatTime } from '../../lib/format';
import type { Preview } from '../../lib/types';
import { useMe } from '../auth/AuthContext';
import { useVmId } from '../layout/useVmId';

interface PreviewList {
  enabled: boolean;
  maxPerVm: number;
  maxTtlHours?: number;
  baseDomain?: string | null;
  items: Preview[];
}

export const TTL_OPTIONS = [
  { hours: 1, label: '1 jam' },
  { hours: 6, label: '6 jam' },
  { hours: 24, label: '1 hari' },
  { hours: 72, label: '3 hari' },
  { hours: 168, label: '7 hari' },
] as const;

const EMPTY_FORM = {
  port: '',
  label: '',
  alias: '',
  hostHeader: '',
  access: 'public' as 'public' | 'password',
  password: '',
  ttlHours: 24,
};

type Dialog = { kind: 'extend' | 'revoke' | 'access'; preview: Preview } | null;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function PreviewsPage() {
  const vmId = useVmId();
  const { user } = useMe();
  const toast = useToast();
  const qc = useQueryClient();
  const base = `/api/vms/${vmId}/previews`;
  const isOwner = user.role === 'client';

  const list = useQuery({
    queryKey: ['previews', vmId],
    retry: false,
    refetchInterval: 15_000,
    queryFn: () => api<PreviewList>(base),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['previews', vmId] });
  const onErr = (e: Error) => toast.show('error', e.message);

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [extendHours, setExtendHours] = useState(24);
  const closeDialog = () => setDialog(null);

  const create = useMutation({
    mutationFn: () =>
      api<Preview>(base, {
        method: 'POST',
        body: {
          port: Number(form.port),
          label: form.label.trim(),
          ttlHours: form.ttlHours,
          access: form.access,
          ...(form.access === 'password' ? { password: form.password } : {}),
          ...(form.alias ? { alias: form.alias } : {}),
          ...(form.hostHeader.trim() ? { hostHeader: form.hostHeader.trim() } : {}),
        },
      }),
    onSuccess: async (p) => {
      setCreating(false);
      setForm(EMPTY_FORM);
      const copied = await copyText(p.url);
      toast.show(
        'success',
        copied
          ? 'Preview dibuat dan link disalin. Pastikan aplikasimu berjalan di VM, lalu kirim link ke teman atau dosen.'
          : 'Preview dibuat. Salin link-nya dari daftar di bawah, lalu pastikan aplikasimu berjalan di VM.',
      );
      await refresh();
    },
    onError: onErr,
  });

  const [accessForm, setAccessForm] = useState<{ access: 'public' | 'password'; password: string }>(
    {
      access: 'password',
      password: '',
    },
  );
  const changeAccess = useMutation({
    mutationFn: (p: Preview) =>
      api<Preview>(`${base}/${p.id}/access`, {
        method: 'POST',
        body: {
          access: accessForm.access,
          ...(accessForm.access === 'password' ? { password: accessForm.password } : {}),
        },
      }),
    onSuccess: async () => {
      toast.show(
        'success',
        'Pengaturan akses diperbarui. Pengunjung yang sudah masuk harus memasukkan kata sandi lagi.',
      );
      setAccessForm({ access: 'password', password: '' });
      closeDialog();
      await refresh();
    },
    onError: onErr,
  });

  const extend = useMutation({
    mutationFn: (p: Preview) =>
      api<Preview>(`${base}/${p.id}/extend`, { method: 'POST', body: { ttlHours: extendHours } }),
    onSuccess: async () => {
      toast.show('success', 'Masa berlaku preview diperpanjang.');
      closeDialog();
      await refresh();
    },
    onError: onErr,
  });

  const revoke = useMutation({
    mutationFn: (p: Preview) => api(`${base}/${p.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.show('success', 'Preview dicabut. Link-nya langsung tidak bisa dibuka lagi.');
      closeDialog();
      await refresh();
    },
    onError: onErr,
  });

  const check = useMutation({
    mutationFn: (p: Preview) =>
      api<{ listening: boolean }>(`${base}/${p.id}/check`, { method: 'POST', body: {} }),
    onSuccess: (r, p) =>
      r.listening
        ? toast.show(
            'success',
            `Ada aplikasi yang berjalan di port ${p.port}. Preview siap dibuka.`,
          )
        : toast.show(
            'warning',
            `Belum ada aplikasi di port ${p.port}. Jalankan aplikasimu di VM (mis. npm run dev), lalu cek lagi.`,
          ),
    onError: onErr,
  });

  const copy = async (p: Preview) => {
    const ok = await copyText(p.url);
    toast.show(
      ok ? 'success' : 'warning',
      ok
        ? 'Link preview disalin.'
        : 'Browser menolak menyalin otomatis. Blok link-nya lalu salin manual.',
    );
  };

  const items = list.data?.items ?? [];
  const full = !!list.data && items.length >= list.data.maxPerVm;
  const aliasOk =
    form.alias === '' ||
    (/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(form.alias) && !form.alias.includes('--'));
  const passwordOk = form.access === 'public' || form.password.length >= 8;
  const accessPasswordOk = accessForm.access === 'public' || accessForm.password.length >= 8;
  const portNum = Number(form.port);
  const portValid =
    /^[0-9]{2,5}$/.test(form.port) && (portNum === 80 || (portNum >= 1024 && portNum <= 65535));

  return (
    <div>
      <PageHeader
        icon={<Eye className="h-5 w-5" />}
        title="Preview Web"
        description="Tampilkan aplikasi yang sedang kamu kembangkan di VM lewat link sementara, tanpa mengatur port, proxy, atau DNS. Cocok untuk ditunjukkan ke teman atau dosen."
        actions={
          isOwner && (
            <Button
              icon={<Plus className="h-4 w-4" />}
              onClick={() => setCreating(true)}
              disabled={!list.data?.enabled || full}
            >
              Buat preview
            </Button>
          )
        }
      />

      {list.data && !list.data.enabled && (
        <p
          role="status"
          className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          Fitur preview belum diaktifkan di server. Minta admin mengisi PREVIEW_BASE_DOMAIN dan
          menyiapkan DNS wildcard-nya.
        </p>
      )}
      {full && list.data && (
        <p
          role="status"
          className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900"
        >
          Batas {list.data.maxPerVm} preview aktif per VM sudah tercapai. Cabut salah satu untuk
          membuat yang baru.
        </p>
      )}
      {!isOwner && (
        <p role="status" className="mt-4 text-sm text-slate-600">
          Sebagai admin, kamu bisa memantau dan mencabut preview. Hanya pemilik VM yang bisa
          membuatnya.
        </p>
      )}

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {list.isLoading && [0, 1].map((i) => <Skeleton key={i} className="h-40" />)}
        {list.error && (
          <p
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-900 lg:col-span-2"
          >
            {list.error.message}
          </p>
        )}
        {items.map((p) => (
          <div key={p.id} className="card p-5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-semibold text-navy">{p.label || `Port ${p.port}`}</p>
                <p className="text-xs text-slate-500">
                  Port {p.port} di VM{p.hostHeader ? ` · Host ${p.hostHeader}` : ''}
                </p>
              </div>
              <span className="flex shrink-0 gap-1">
                {p.connections > 0 ? (
                  <Badge tone="success" dot>
                    Sedang dibuka
                  </Badge>
                ) : (
                  <Badge tone="neutral">Siaga</Badge>
                )}
                {p.access === 'password' ? (
                  <Badge tone="info">
                    <Lock aria-hidden="true" className="mr-1 inline h-3 w-3" />
                    Kata sandi
                  </Badge>
                ) : (
                  <Badge tone="warning">Publik</Badge>
                )}
              </span>
            </div>

            <div className="mt-3 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <a
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 flex-1 truncate font-mono text-xs text-info hover:underline"
                title={p.url}
              >
                {p.url}
              </a>
            </div>

            <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
              <Clock aria-hidden="true" className="h-3.5 w-3.5" />
              Berakhir dalam {formatRemaining(p.expiresAt)}
              <span className="text-slate-300">·</span>
              Akses terakhir {p.lastAccessAt ? formatTime(p.lastAccessAt) : 'belum ada'}
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                icon={<Copy className="h-4 w-4" />}
                variant="secondary"
                onClick={() => void copy(p)}
              >
                Salin link
              </Button>
              <a
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-navy hover:bg-slate-50"
              >
                <ExternalLink aria-hidden="true" className="h-4 w-4" />
                Buka
              </a>
              <Button
                size="sm"
                variant="ghost"
                icon={<Radio className="h-4 w-4" />}
                loading={check.isPending && check.variables?.id === p.id}
                onClick={() => check.mutate(p)}
              >
                Cek port
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<Lock className="h-4 w-4" />}
                onClick={() => {
                  setAccessForm({
                    access: 'password',
                    password: '',
                  });
                  setDialog({ kind: 'access', preview: p });
                }}
              >
                Akses
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setExtendHours(24);
                  setDialog({ kind: 'extend', preview: p });
                }}
              >
                Perpanjang
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="!text-error"
                icon={<Trash2 className="h-4 w-4" />}
                onClick={() => setDialog({ kind: 'revoke', preview: p })}
              >
                Cabut
              </Button>
            </div>
          </div>
        ))}
        {list.data?.enabled && items.length === 0 && (
          <EmptyState
            className="lg:col-span-2"
            icon={<Eye className="h-6 w-6" />}
            title="Belum ada preview"
            description={
              isOwner
                ? 'Jalankan aplikasimu di VM (mis. npm run dev di port 5173), klik "Buat preview", isi port-nya, lalu bagikan link yang dihasilkan.'
                : 'Pemilik VM belum membuat preview.'
            }
          />
        )}
      </div>

      <Modal
        open={creating}
        title="Buat preview"
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Batal
            </Button>
            <Button
              loading={create.isPending}
              disabled={!portValid || !aliasOk || !passwordOk}
              onClick={() => create.mutate()}
            >
              Buat link
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Input
            label="Port aplikasi di VM"
            inputMode="numeric"
            value={form.port}
            onChange={(e) => setForm((f) => ({ ...f, port: e.target.value.replace(/\D/g, '') }))}
            hint="Port tempat aplikasimu mendengarkan di VM, mis. 3000 (Node), 5173 (Vite), atau 80 (Nginx). Boleh 80 atau 1024-65535."
            autoFocus
          />
          <Input
            label="Label (opsional)"
            value={form.label}
            maxLength={60}
            onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            hint="Untuk membedakan preview, mis. Tugas Akhir."
          />
          <div>
            <Input
              label="Alias alamat (opsional)"
              value={form.alias}
              maxLength={30}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  alias: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''),
                }))
              }
              hint="3-30 huruf kecil, angka, atau tanda hubung. Kosongkan untuk alamat acak yang panjang dan sulit ditebak."
            />
            <p className="mt-1 break-all font-mono text-xs text-slate-500">
              https://pv-{form.alias || '<acak>'}.{list.data?.baseDomain ?? 'domain-anda'}
            </p>
            {!aliasOk && (
              <p role="alert" className="mt-1 text-sm text-error">
                Alias 3-30 karakter, hanya huruf kecil, angka, dan tanda hubung (tidak di
                awal/akhir, tidak dobel).
              </p>
            )}
          </div>
          <div>
            <label className="text-sm font-medium text-slate-700" htmlFor="acc">
              Siapa yang boleh membuka
            </label>
            <select
              id="acc"
              className="mt-1 h-10 w-full px-3"
              value={form.access}
              onChange={(e) =>
                setForm((f) => ({ ...f, access: e.target.value as 'public' | 'password' }))
              }
            >
              <option value="public">Publik (siapa pun yang tahu alamatnya)</option>
              <option value="password">Dengan kata sandi</option>
            </select>
            {form.access === 'public' && form.alias && (
              <p role="status" className="mt-1 text-sm text-amber-700">
                Alias mudah ditebak. Dengan akses publik, orang lain bisa menemukan preview ini.
                Pakai kata sandi bila isinya tidak untuk umum.
              </p>
            )}
          </div>
          {form.access === 'password' && (
            <Input
              label="Kata sandi preview"
              type="password"
              autoComplete="new-password"
              value={form.password}
              maxLength={128}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              hint="Minimal 8 karakter. Bagikan ke teman atau dosen bersama link-nya; kata sandi tidak bisa dilihat lagi setelah disimpan."
            />
          )}
          <Input
            label="Host situs (opsional)"
            value={form.hostHeader}
            onChange={(e) => setForm((f) => ({ ...f, hostHeader: e.target.value.toLowerCase() }))}
            hint="Isi domain situs di Nginx VM (mis. blog.contoh.com) bila VM menjalankan beberapa situs di port 80. Tanpa ini Nginx menampilkan situs default."
          />
          <div>
            <label className="text-sm font-medium text-slate-700" htmlFor="ttl">
              Berlaku selama
            </label>
            <select
              id="ttl"
              className="mt-1 h-10 w-full px-3"
              value={form.ttlHours}
              onChange={(e) => setForm((f) => ({ ...f, ttlHours: Number(e.target.value) }))}
            >
              {TTL_OPTIONS.map((o) => (
                <option key={o.hours} value={o.hours}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            Siapa pun yang memegang link bisa melihat aplikasimu sampai masa berlaku habis atau kamu
            mencabutnya. Jangan bagikan link ke orang yang tidak kamu percaya.
          </p>
        </div>
      </Modal>

      <Modal
        open={dialog?.kind === 'extend'}
        title="Perpanjang preview"
        onClose={closeDialog}
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog}>
              Batal
            </Button>
            <Button
              loading={extend.isPending}
              onClick={() => dialog && extend.mutate(dialog.preview)}
            >
              Perpanjang
            </Button>
          </>
        }
      >
        <label className="text-sm font-medium text-slate-700" htmlFor="ext">
          Berlaku selama (dihitung dari sekarang)
        </label>
        <select
          id="ext"
          className="mt-1 h-10 w-full px-3"
          value={extendHours}
          onChange={(e) => setExtendHours(Number(e.target.value))}
        >
          {TTL_OPTIONS.map((o) => (
            <option key={o.hours} value={o.hours}>
              {o.label}
            </option>
          ))}
        </select>
      </Modal>

      <Modal
        open={dialog?.kind === 'access'}
        title="Atur akses preview"
        onClose={closeDialog}
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog}>
              Batal
            </Button>
            <Button
              loading={changeAccess.isPending}
              disabled={!accessPasswordOk}
              onClick={() => dialog && changeAccess.mutate(dialog.preview)}
            >
              Simpan
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div>
            <label className="text-sm font-medium text-slate-700" htmlFor="acc2">
              Siapa yang boleh membuka
            </label>
            <select
              id="acc2"
              className="mt-1 h-10 w-full px-3"
              value={accessForm.access}
              onChange={(e) =>
                setAccessForm((f) => ({ ...f, access: e.target.value as 'public' | 'password' }))
              }
            >
              <option value="password">Dengan kata sandi (ganti atau atur baru)</option>
              <option value="public">Publik (siapa pun yang tahu alamatnya)</option>
            </select>
          </div>
          {accessForm.access === 'password' && (
            <Input
              label="Kata sandi baru"
              type="password"
              autoComplete="new-password"
              value={accessForm.password}
              maxLength={128}
              onChange={(e) => setAccessForm((f) => ({ ...f, password: e.target.value }))}
              hint="Minimal 8 karakter. Pengunjung yang sudah masuk akan diminta kata sandi lagi."
            />
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={dialog?.kind === 'revoke'}
        title="Cabut preview?"
        message="Link preview ini langsung tidak bisa dibuka lagi dan semua koneksi yang sedang berjalan diputus. Kamu bisa membuat link baru kapan saja."
        confirmLabel="Cabut preview"
        loading={revoke.isPending}
        onConfirm={() => dialog && revoke.mutate(dialog.preview)}
        onCancel={closeDialog}
      />
    </div>
  );
}
