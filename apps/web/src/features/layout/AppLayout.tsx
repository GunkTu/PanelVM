import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { NavLink, Outlet, useMatch } from 'react-router-dom';
import { Badge, Button, Skeleton } from '../../components';
import { api } from '../../lib/api';
import { formatTime } from '../../lib/format';
import type { NotificationItem, Vm } from '../../lib/types';
import { useMe } from '../auth/AuthContext';

const statusTone = { online: 'success', offline: 'error', unknown: 'neutral' } as const;
const statusLabel = { online: 'Online', offline: 'Offline', unknown: 'Belum dicek' } as const;

const navClass = ({ isActive }: { isActive: boolean }) =>
  `block rounded-md px-3 py-2 text-sm ${isActive ? 'bg-navy-dark text-yellow' : 'text-slate-200 hover:bg-navy-dark'}`;

function Notifications() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ['notifications'],
    refetchInterval: 60_000,
    queryFn: () => api<{ unread: number; items: NotificationItem[] }>('/api/notifications'),
  });
  const readAll = useMutation({
    mutationFn: () => api('/api/notifications/read-all', { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`Notifikasi${data?.unread ? `, ${data.unread} belum dibaca` : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-md p-2 text-white hover:bg-navy-dark"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {!!data?.unread && (
          <span className="absolute -right-0.5 -top-0.5 rounded-full bg-yellow px-1.5 text-xs font-bold text-navy">
            {data.unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-80 max-w-[90vw] rounded-md border border-slate-200 bg-white text-slate-800 shadow-lg">
          <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
            <span className="text-sm font-semibold text-navy">Notifikasi</span>
            <button
              type="button"
              className="text-xs text-info underline"
              onClick={() => readAll.mutate()}
            >
              Tandai semua dibaca
            </button>
          </div>
          <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
            {data?.items.length ? (
              data.items.map((n) => (
                <li key={n.id} className={`px-3 py-2 text-sm ${n.read ? '' : 'bg-blue-50'}`}>
                  <p className="font-medium">{n.title}</p>
                  <p className="text-slate-600">{n.message}</p>
                  <p className="mt-1 text-xs text-slate-400">{formatTime(n.createdAt)}</p>
                </li>
              ))
            ) : (
              <li className="px-3 py-6 text-center text-sm text-slate-500">
                Belum ada notifikasi.
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

export function AppLayout() {
  const { user } = useMe();
  const qc = useQueryClient();
  const match = useMatch('/vms/:vmId/*');
  const vmId = match?.params.vmId;

  const vm = useQuery({
    queryKey: ['vm', vmId],
    enabled: !!vmId,
    refetchInterval: 30_000,
    queryFn: () => api<Vm>(`/api/vms/${vmId}`),
  });

  const logout = useMutation({
    mutationFn: () => api('/api/auth/logout', { method: 'POST', body: {} }),
    onSettled: () => qc.setQueryData(['me'], null),
  });

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="w-full bg-navy p-4 text-white md:w-60 md:shrink-0">
        <p className="text-xs uppercase tracking-wide text-slate-300">VM aktif</p>
        {vmId ? (
          vm.isLoading ? (
            <Skeleton className="mt-1 h-5 w-32 bg-navy-dark" />
          ) : (
            <p className="mt-1 font-semibold">{vm.data?.name ?? 'Tidak tersedia'}</p>
          )
        ) : (
          <p className="mt-1 font-semibold">Belum dipilih</p>
        )}
        <nav className="mt-5 flex flex-col gap-1" aria-label="Menu utama">
          <NavLink to="/vms" className={navClass} end>
            VM Saya
          </NavLink>
          {vmId &&
            vm.data &&
            (
              [
                ['terminal', 'Terminal', 'terminal'],
                ['files', 'File Manager', 'files'],
                ['database', 'Database', 'databases'],
                ['software', 'Aplikasi', 'software'],
                ['sites', 'Situs Web', 'sites'],
                ['monitoring', 'Monitoring', 'monitoring'],
                ['services', 'Service', 'services'],
              ] as const
            )
              .filter(([m]) => vm.data.modules[m])
              .map(([m, text, path]) => (
                <NavLink key={m} to={`/vms/${vmId}/${path}`} className={navClass}>
                  {text}
                </NavLink>
              ))}
          {user.role === 'admin' && (
            <>
              <p className="mt-4 px-3 text-xs uppercase tracking-wide text-slate-400">Admin</p>
              <NavLink to="/admin/vms" className={navClass}>
                Kelola VM
              </NavLink>
              <NavLink to="/admin/users" className={navClass}>
                Kelola Pengguna
              </NavLink>
              <NavLink to="/admin/audit" className={navClass}>
                Audit Log
              </NavLink>
            </>
          )}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 bg-navy px-4 py-2 text-white">
          <div className="flex items-center gap-2">
            {vm.data && (
              <Badge tone={statusTone[vm.data.status]}>{statusLabel[vm.data.status]}</Badge>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Notifications />
            <span className="hidden text-sm text-slate-200 sm:inline">{user.email}</span>
            <Button
              variant="ghost"
              className="!border-slate-400 !text-white hover:!bg-navy-dark"
              loading={logout.isPending}
              onClick={() => logout.mutate()}
            >
              Keluar
            </Button>
          </div>
        </header>
        <main className="min-w-0 flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
