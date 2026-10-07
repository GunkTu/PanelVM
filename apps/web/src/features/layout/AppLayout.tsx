import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Bell,
  CheckCheck,
  ChevronRight,
  Database,
  FolderOpen,
  Globe,
  LayoutGrid,
  LogOut,
  Menu,
  Package,
  ScrollText,
  Server,
  Settings2,
  SquareTerminal,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useMatch } from 'react-router-dom';
import { Badge, Button, Skeleton, StatusDot, type BadgeTone } from '../../components';
import { api } from '../../lib/api';
import { formatTime } from '../../lib/format';
import type { NotificationItem, Vm } from '../../lib/types';
import { useMe } from '../auth/AuthContext';

const statusTone: Record<Vm['status'], BadgeTone> = {
  online: 'success',
  offline: 'error',
  unknown: 'neutral',
};
const statusLabel: Record<Vm['status'], string> = {
  online: 'Online',
  offline: 'Offline',
  unknown: 'Belum dicek',
};

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

const PAGE_TITLES: Record<string, string> = {
  terminal: 'Terminal',
  files: 'File Manager',
  databases: 'Database',
  software: 'Aplikasi',
  sites: 'Situs Web',
  monitoring: 'Monitoring',
  services: 'Service',
};
const ADMIN_TITLES: Record<string, string> = {
  '/admin/vms': 'Kelola VM',
  '/admin/users': 'Kelola Pengguna',
  '/admin/audit': 'Audit Log',
};

function NavGroup({
  title,
  items,
  onNavigate,
}: {
  title?: string;
  items: NavItem[];
  onNavigate: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-5 first:mt-0">
      {title && (
        <p className="mb-1.5 px-3 text-[0.68rem] font-semibold tracking-[0.12em] text-slate-400 uppercase">
          {title}
        </p>
      )}
      <ul className="flex flex-col gap-0.5">
        {items.map((it) => (
          <li key={it.to}>
            <NavLink
              to={it.to}
              end={it.end}
              onClick={onNavigate}
              className={({ isActive }) =>
                `group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${isActive ? 'bg-white/10 text-white' : 'text-slate-300 hover:bg-white/5 hover:text-white'}`
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span
                      aria-hidden="true"
                      className="absolute top-1.5 bottom-1.5 -left-3 w-1 rounded-r-full bg-yellow"
                    />
                  )}
                  <it.icon
                    aria-hidden="true"
                    className={`h-[1.15rem] w-[1.15rem] shrink-0 ${isActive ? 'text-yellow' : 'text-slate-400 group-hover:text-slate-200'}`}
                  />
                  {it.label}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Notifications() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const { data } = useQuery({
    queryKey: ['notifications'],
    refetchInterval: 60_000,
    queryFn: () => api<{ unread: number; items: NotificationItem[] }>('/api/notifications'),
  });
  const readAll = useMutation({
    mutationFn: () => api('/api/notifications/read-all', { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  // Tutup saat klik di luar atau tekan Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrap}>
      <button
        type="button"
        aria-label={`Notifikasi${data?.unread ? `, ${data.unread} belum dibaca` : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-lg p-2 text-slate-200 transition-colors hover:bg-white/10 hover:text-white"
      >
        <Bell aria-hidden="true" className="h-5 w-5" />
        {!!data?.unread && (
          <span className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-yellow px-1 text-[0.65rem] font-bold text-navy">
            {data.unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-200 bg-white text-slate-800 shadow-(--shadow-pop) animate-pop-in">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <span className="text-sm font-semibold text-navy">Notifikasi</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs font-medium text-info hover:underline"
              onClick={() => readAll.mutate()}
            >
              <CheckCheck aria-hidden="true" className="h-3.5 w-3.5" />
              Tandai semua dibaca
            </button>
          </div>
          <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
            {data?.items.length ? (
              data.items.map((n) => (
                <li
                  key={n.id}
                  className={`flex gap-3 px-4 py-3 text-sm ${n.read ? '' : 'bg-blue-50/60'}`}
                >
                  <span
                    aria-hidden="true"
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read ? 'bg-transparent' : 'bg-info'}`}
                  />
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900">{n.title}</p>
                    <p className="text-slate-600">{n.message}</p>
                    <p className="mt-1 text-xs text-slate-400">{formatTime(n.createdAt)}</p>
                  </div>
                </li>
              ))
            ) : (
              <li className="px-4 py-10 text-center text-sm text-slate-500">
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
  const location = useLocation();
  const vmMatch = useMatch('/vms/:vmId/*');
  const pageMatch = useMatch('/vms/:vmId/:page');
  const vmId = vmMatch?.params.vmId;
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);

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

  const vmModules: NavItem[] =
    vmId && vm.data
      ? (
          [
            ['terminal', 'Terminal', SquareTerminal],
            ['files', 'File Manager', FolderOpen],
            ['databases', 'Database', Database],
            ['software', 'Aplikasi', Package],
            ['sites', 'Situs Web', Globe],
            ['monitoring', 'Monitoring', Activity],
            ['services', 'Service', Settings2],
          ] as const
        )
          .filter(
            ([page]) =>
              vm.data.modules[
                ({ databases: 'database' } as Record<string, keyof Vm['modules']>)[page] ??
                  (page as keyof Vm['modules'])
              ],
          )
          .map(([page, label, icon]) => ({ to: `/vms/${vmId}/${page}`, label, icon }))
      : [];

  const adminItems: NavItem[] =
    user.role === 'admin'
      ? [
          { to: '/admin/vms', label: 'Kelola VM', icon: Server },
          { to: '/admin/users', label: 'Kelola Pengguna', icon: Users },
          { to: '/admin/audit', label: 'Audit Log', icon: ScrollText },
        ]
      : [];

  const pageTitle = pageMatch
    ? PAGE_TITLES[pageMatch.params.page ?? '']
    : (ADMIN_TITLES[location.pathname] ?? 'VM Saya');

  return (
    <div className="min-h-screen lg:flex">
      {menuOpen && (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-20 bg-navy-dark/60 backdrop-blur-sm animate-fade-in lg:hidden"
          onClick={closeMenu}
        />
      )}

      <aside
        aria-label="Navigasi utama"
        className={`z-30 flex w-72 shrink-0 flex-col bg-gradient-to-b from-navy to-navy-dark text-white transition-transform duration-200 max-lg:fixed max-lg:inset-y-0 max-lg:left-0 lg:sticky lg:top-0 lg:h-screen ${menuOpen ? 'max-lg:translate-x-0' : 'max-lg:-translate-x-full'}`}
      >
        <div className="flex items-center gap-3 px-5 pt-5 pb-4">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-yellow text-navy shadow-md"
          >
            <SquareTerminal className="h-5 w-5" />
          </span>
          <div className="leading-tight">
            <p className="text-base font-semibold tracking-tight">Panel VM</p>
            <p className="text-xs text-slate-400">Akses VM Proxmox</p>
          </div>
        </div>

        <div className="mx-4 rounded-xl border border-white/10 bg-white/5 p-3">
          <p className="text-[0.68rem] font-semibold tracking-[0.12em] text-slate-400 uppercase">
            VM aktif
          </p>
          {vmId ? (
            vm.isLoading ? (
              <Skeleton className="mt-2 h-5 w-32 !bg-white/10 !bg-none" />
            ) : (
              <>
                <p className="mt-1 truncate text-sm font-semibold">
                  {vm.data?.name ?? 'Tidak tersedia'}
                </p>
                {vm.data && (
                  <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-300">
                    <StatusDot tone={statusTone[vm.data.status]} />
                    {statusLabel[vm.data.status]}
                    <span className="text-slate-500">·</span>
                    <span className="truncate font-mono">{vm.data.host}</span>
                  </p>
                )}
              </>
            )
          ) : (
            <p className="mt-1 text-sm text-slate-300">Belum dipilih</p>
          )}
        </div>

        <nav aria-label="Menu utama" className="mt-5 flex-1 overflow-y-auto px-4 pb-4">
          <NavGroup
            items={[{ to: '/vms', label: 'VM Saya', icon: LayoutGrid, end: true }]}
            onNavigate={closeMenu}
          />
          <NavGroup title="VM ini" items={vmModules} onNavigate={closeMenu} />
          <NavGroup title="Admin" items={adminItems} onNavigate={closeMenu} />
        </nav>

        <div className="border-t border-white/10 p-4">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-sm font-semibold uppercase"
            >
              {user.email.slice(0, 1)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium" title={user.email}>
                {user.email}
              </p>
              <p className="text-xs text-slate-400">{user.role === 'admin' ? 'Admin' : 'Client'}</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={<LogOut className="h-4 w-4" />}
            className="mt-3 w-full !border-white/20 !bg-white/5 !text-white hover:!bg-white/10"
            loading={logout.isPending}
            onClick={() => logout.mutate()}
          >
            Keluar
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b border-white/10 bg-navy px-4 text-white shadow-sm sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              aria-label="Buka menu"
              onClick={() => setMenuOpen(true)}
              className="rounded-lg p-2 text-slate-200 transition-colors hover:bg-white/10 lg:hidden"
            >
              <Menu aria-hidden="true" className="h-5 w-5" />
            </button>
            <nav
              aria-label="Lokasi"
              className="flex min-w-0 items-center gap-1.5 text-sm text-slate-300"
            >
              {vm.data && pageMatch ? (
                <>
                  <span className="hidden truncate sm:inline">{vm.data.name}</span>
                  <ChevronRight
                    aria-hidden="true"
                    className="hidden h-4 w-4 shrink-0 text-slate-500 sm:inline"
                  />
                </>
              ) : null}
              <span className="truncate font-medium text-white">{pageTitle}</span>
            </nav>
          </div>
          <div className="flex items-center gap-2">
            {vm.data && (
              <Badge tone={statusTone[vm.data.status]} dot>
                {statusLabel[vm.data.status]}
              </Badge>
            )}
            <Notifications />
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl min-w-0 flex-1 p-4 sm:p-6 lg:p-8">
          <div key={location.pathname} className="animate-fade-in">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
