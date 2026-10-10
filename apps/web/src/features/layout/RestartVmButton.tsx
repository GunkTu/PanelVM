import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCw } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog, useToast } from '../../components';
import { api } from '../../lib/api';

interface Power {
  available: boolean;
  status: 'running' | 'stopped' | null;
}

/**
 * Tombol restart VM (reboot lewat Proxmox). Hanya muncul untuk VM yang dibuat lewat panel; VM yang didaftarkan
 * manual tidak punya tautan ke Proxmox sehingga tombolnya disembunyikan.
 */
export function RestartVmButton({ vmId, vmName }: { vmId: string; vmName: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const power = useQuery({
    queryKey: ['vm-power', vmId],
    retry: false,
    staleTime: 30_000,
    queryFn: () => api<Power>(`/api/vms/${vmId}/power`),
  });
  const reboot = useMutation({
    mutationFn: () => api(`/api/vms/${vmId}/power/reboot`, { method: 'POST', body: {} }),
    onSuccess: async () => {
      setOpen(false);
      toast.show(
        'info',
        `Perintah restart dikirim ke ${vmName}. Terminal akan terputus; tunggu sekitar 1 menit lalu sambungkan lagi.`,
      );
      await qc.invalidateQueries({ queryKey: ['vm-power', vmId] });
    },
    onError: (e: Error) => {
      setOpen(false);
      toast.show('error', e.message);
    },
  });

  if (!power.data?.available) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={power.data.status === 'stopped'}
        title={power.data.status === 'stopped' ? 'VM sedang mati' : 'Restart VM'}
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-slate-200 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40"
      >
        <RotateCw aria-hidden="true" className="h-4 w-4" />
        <span className="hidden sm:inline">Restart VM</span>
      </button>
      <ConfirmDialog
        open={open}
        title="Restart VM?"
        message={`VM ${vmName} akan di-restart. Semua proses di dalamnya berhenti sebentar, sesi terminal terputus, dan situs web tidak bisa diakses selama sekitar 1 menit. Pastikan tidak ada upload atau deploy yang sedang berjalan.`}
        confirmLabel="Restart"
        loading={reboot.isPending}
        onConfirm={() => reboot.mutate()}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
