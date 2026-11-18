import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Construction } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, ConfirmDialog, Input, PageHeader, useToast } from '../../components';
import { api } from '../../lib/api';
import { formatTime } from '../../lib/format';

export interface MaintenanceInfo {
  enabled: boolean;
  message: string;
  since: number | null;
}

export function AdminMaintenancePage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({
    queryKey: ['maintenance'],
    queryFn: () => api<MaintenanceInfo>('/api/maintenance'),
  });
  // null = belum diedit; tampilkan pesan dari server.
  const [draft, setDraft] = useState<string | null>(null);
  const message = draft ?? data?.message ?? '';
  const [confirm, setConfirm] = useState(false);

  const save = useMutation({
    mutationFn: (enabled: boolean) =>
      api<MaintenanceInfo & { terminalsClosed: number }>('/api/admin/maintenance', {
        method: 'PUT',
        body: { enabled, message },
      }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['maintenance'] });
      setConfirm(false);
      toast.show(
        r.enabled ? 'warning' : 'success',
        r.enabled
          ? `Mode maintenance aktif. Pengguna biasa melihat halaman pemeliharaan${r.terminalsClosed ? ` dan ${r.terminalsClosed} terminal mereka diputus` : ''}. Anda (admin) tetap bisa bekerja.`
          : 'Mode maintenance dimatikan. Panel kembali normal untuk semua pengguna.',
      );
    },
    onError: (e: Error) => {
      setConfirm(false);
      toast.show('error', e.message);
    },
  });

  const enabled = data?.enabled ?? false;
  return (
    <div>
      <PageHeader
        icon={<Construction className="h-5 w-5" />}
        title="Mode Maintenance"
        description="Saat aktif, pengguna biasa melihat halaman pemeliharaan dan tidak bisa memakai panel. Admin tetap bisa masuk. Situs web milik pengguna (VM dan preview) tidak terpengaruh."
        actions={
          <Badge tone={enabled ? 'warning' : 'success'} dot>
            {enabled ? 'Aktif' : 'Nonaktif'}
          </Badge>
        }
      />
      <Card>
        <div className="flex max-w-xl flex-col gap-4">
          <Input
            label="Pesan untuk pengguna"
            hint="Maksimal 300 karakter. Kosongkan untuk memakai pesan bawaan."
            maxLength={300}
            value={message}
            onChange={(e) => setDraft(e.target.value)}
          />
          {enabled && data?.since && (
            <p className="text-sm text-slate-600">Aktif sejak {formatTime(data.since)}.</p>
          )}
          <div className="flex gap-2">
            {enabled ? (
              <>
                <Button
                  variant="secondary"
                  loading={save.isPending}
                  onClick={() => save.mutate(true)}
                >
                  Simpan pesan
                </Button>
                <Button loading={save.isPending} onClick={() => save.mutate(false)}>
                  Matikan maintenance
                </Button>
              </>
            ) : (
              <Button onClick={() => setConfirm(true)}>Aktifkan maintenance</Button>
            )}
          </div>
          <p className="text-xs text-slate-500">
            Alur update: aktifkan mode ini, tunggu deploy/upload pengguna selesai, lakukan update
            (git pull, build, restart), uji sebagai admin, lalu matikan.
          </p>
        </div>
      </Card>
      <ConfirmDialog
        open={confirm}
        title="Aktifkan mode maintenance?"
        message="Semua pengguna biasa langsung melihat halaman pemeliharaan dan terminal mereka diputus. Upload atau deploy yang sedang berjalan bisa gagal; pastikan tidak ada yang sibuk. Admin tidak terpengaruh."
        confirmLabel="Aktifkan"
        loading={save.isPending}
        onConfirm={() => save.mutate(true)}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}
