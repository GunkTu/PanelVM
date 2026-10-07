import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowRight,
  Database,
  FolderOpen,
  Globe,
  Package,
  Server,
  Settings2,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Skeleton,
  type BadgeTone,
} from '../../components';
import { api } from '../../lib/api';
import type { Modules, Vm } from '../../lib/types';
import { useMe } from '../auth/AuthContext';

const tone: Record<Vm['status'], BadgeTone> = {
  online: 'success',
  offline: 'error',
  unknown: 'neutral',
};
const label: Record<Vm['status'], string> = {
  online: 'Online',
  offline: 'Offline',
  unknown: 'Belum dicek',
};

const MODULES: { key: keyof Modules; path: string; label: string; icon: LucideIcon }[] = [
  { key: 'terminal', path: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { key: 'files', path: 'files', label: 'File', icon: FolderOpen },
  { key: 'database', path: 'databases', label: 'Database', icon: Database },
  { key: 'software', path: 'software', label: 'Aplikasi', icon: Package },
  { key: 'sites', path: 'sites', label: 'Situs', icon: Globe },
  { key: 'monitoring', path: 'monitoring', label: 'Monitoring', icon: Activity },
  { key: 'services', path: 'services', label: 'Service', icon: Settings2 },
];

export function VmListPage() {
  const { user } = useMe();
  const { data, isLoading, error } = useQuery({
    queryKey: ['vms'],
    queryFn: () => api<{ items: Vm[] }>('/api/vms'),
  });

  return (
    <div>
      <PageHeader
        icon={<Server className="h-5 w-5" />}
        title="VM Saya"
        description={
          user.role === 'admin'
            ? 'Semua VM yang terdaftar di panel. Buka salah satu untuk mengelolanya.'
            : 'VM yang terhubung ke akun Anda. Pilih untuk membuka terminal, file, database, dan lainnya.'
        }
      />

      {error && (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"
        >
          {error.message}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {isLoading &&
          [0, 1, 2].map((i) => <Skeleton key={i} className="h-40 rounded-(--radius-card)" />)}
        {data?.items.map((vm) => {
          const enabled = MODULES.filter((m) => vm.modules[m.key]);
          const first = enabled[0];
          return (
            <Link
              key={vm.id}
              to={`/vms/${vm.id}/${first?.path ?? 'terminal'}`}
              className="group block rounded-(--radius-card) focus-visible:outline-offset-4"
            >
              <Card interactive className="h-full">
                <div className="flex items-start justify-between gap-3">
                  <span
                    aria-hidden="true"
                    className="flex h-11 w-11 items-center justify-center rounded-xl bg-navy text-yellow shadow-(--shadow-card)"
                  >
                    <Server className="h-5 w-5" />
                  </span>
                  <Badge tone={tone[vm.status]} dot>
                    {label[vm.status]}
                  </Badge>
                </div>
                <p className="mt-4 truncate text-lg font-semibold text-navy">{vm.name}</p>
                <p className="mt-0.5 truncate font-mono text-xs text-slate-500">
                  {vm.sshUser}@{vm.host}:{vm.sshPort}
                </p>
                <ul className="mt-4 flex flex-wrap gap-1.5" aria-label="Fitur aktif">
                  {enabled.map((m) => (
                    <li
                      key={m.key}
                      className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600"
                    >
                      <m.icon aria-hidden="true" className="h-3.5 w-3.5" />
                      {m.label}
                    </li>
                  ))}
                </ul>
                <p className="mt-4 flex items-center gap-1 text-sm font-semibold text-navy">
                  Buka VM
                  <ArrowRight
                    aria-hidden="true"
                    className="h-4 w-4 transition-transform group-hover:translate-x-1"
                  />
                </p>
              </Card>
            </Link>
          );
        })}
      </div>

      {data && data.items.length === 0 && (
        <EmptyState
          icon={<Server className="h-6 w-6" />}
          title="Belum ada VM"
          description={
            user.role === 'admin'
              ? 'Daftarkan VM pertama dari menu Kelola VM, lalu hubungkan ke akun client.'
              : 'Akun Anda belum terhubung ke VM mana pun. Hubungi admin untuk dihubungkan.'
          }
          action={
            user.role === 'admin' ? (
              <Link to="/admin/vms">
                <Button>Kelola VM</Button>
              </Link>
            ) : undefined
          }
        />
      )}
    </div>
  );
}
