import { useQuery } from '@tanstack/react-query';
import { Construction } from 'lucide-react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../../lib/api';
import type { MaintenanceInfo } from '../admin/AdminMaintenancePage';
import { useMeQuery } from './AuthContext';

/**
 * Saat maintenance aktif, non-admin melihat layar pemeliharaan (halaman login tetap terbuka agar admin bisa masuk).
 * Status dicek ulang tiap 20 detik sehingga layar hilang sendiri begitu maintenance dimatikan.
 */
export function MaintenanceGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { data: m } = useQuery({
    queryKey: ['maintenance'],
    retry: false,
    refetchInterval: 20_000,
    queryFn: () => api<MaintenanceInfo>('/api/maintenance'),
  });
  const { data: me } = useMeQuery();

  const onLogin = location.pathname.startsWith('/login');
  if (!m?.enabled || me?.user.role === 'admin' || onLogin) return <>{children}</>;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-canvas p-6 text-center">
      <span className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-navy text-yellow shadow-(--shadow-card)">
        <Construction aria-hidden="true" className="h-8 w-8" />
      </span>
      <h1 className="text-2xl font-semibold text-navy">Sedang dalam pemeliharaan</h1>
      <p className="mt-2 max-w-md text-slate-600">{m.message}</p>
      <p className="mt-1 max-w-md text-sm text-slate-500">
        Halaman ini akan terbuka otomatis begitu pemeliharaan selesai. Situs web Anda di VM tetap
        berjalan seperti biasa.
      </p>
    </main>
  );
}
