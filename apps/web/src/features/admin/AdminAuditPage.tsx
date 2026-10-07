import { useQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { Badge, PageHeader, Table } from '../../components';
import { api } from '../../lib/api';
import { formatTime } from '../../lib/format';
import type { AuditItem } from '../../lib/types';

export function AdminAuditPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['audit'],
    queryFn: () => api<{ items: AuditItem[] }>('/api/audit?limit=100'),
  });
  return (
    <div>
      <PageHeader
        icon={<ScrollText className="h-5 w-5" />}
        title="Audit Log"
        description="100 catatan terbaru. Isi file, password, dan keystroke tidak pernah dicatat."
      />
      <div>
        <Table
          rows={data?.items}
          loading={isLoading}
          error={error?.message}
          rowKey={(a) => String(a.id)}
          emptyMessage="Belum ada catatan audit."
          columns={[
            { header: 'Waktu', render: (a) => formatTime(a.ts) },
            {
              header: 'Aksi',
              render: (a) => <span className="font-mono text-xs">{a.action}</span>,
            },
            { header: 'Target', render: (a) => a.target ?? '-' },
            { header: 'IP', render: (a) => a.ip ?? '-' },
            {
              header: 'Hasil',
              render: (a) => (
                <Badge tone={a.result === 'ok' ? 'success' : 'error'}>{a.result}</Badge>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}
