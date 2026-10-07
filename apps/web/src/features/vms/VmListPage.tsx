import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Badge, Skeleton } from '../../components';
import { api } from '../../lib/api';
import type { Vm } from '../../lib/types';
import { useMe } from '../auth/AuthContext';

const tone = { online: 'success', offline: 'error', unknown: 'neutral' } as const;
const label = { online: 'Online', offline: 'Offline', unknown: 'Belum dicek' } as const;

export function VmListPage() {
  const { user } = useMe();
  const { data, isLoading, error } = useQuery({
    queryKey: ['vms'],
    queryFn: () => api<{ items: Vm[] }>('/api/vms'),
  });

  return (
    <div>
      <h1 className="text-2xl font-semibold text-navy">VM Saya</h1>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {isLoading && [0, 1].map((i) => <Skeleton key={i} className="h-28" />)}
        {error && (
          <p
            role="alert"
            className="rounded-md border border-error bg-red-50 p-4 text-sm text-red-900 sm:col-span-2"
          >
            {error.message}
          </p>
        )}
        {data?.items.map((vm) => (
          <Link
            key={vm.id}
            to={`/vms/${vm.id}/terminal`}
            className="rounded-lg border border-slate-200 p-4 transition-colors hover:border-navy"
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold text-navy">{vm.name}</span>
              <Badge tone={tone[vm.status]}>{label[vm.status]}</Badge>
            </div>
            <p className="mt-2 text-sm text-slate-600">
              {vm.sshUser}@{vm.host}:{vm.sshPort}
            </p>
          </Link>
        ))}
        {data && data.items.length === 0 && (
          <p className="rounded-md border border-dashed border-slate-300 p-6 text-sm text-slate-600 sm:col-span-2">
            {user.role === 'admin'
              ? 'Belum ada VM. Buka Kelola VM untuk mendaftarkan VM pertama.'
              : 'Akun Anda belum terhubung ke VM mana pun. Hubungi admin untuk dihubungkan.'}
          </p>
        )}
      </div>
    </div>
  );
}
