import { useCallback, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Plus, SquareTerminal, X } from 'lucide-react';
import { Badge, Button, EmptyState, PageHeader, type BadgeTone } from '../../components';
import { TerminalView, type ConnState } from './TerminalView';

const MAX_TABS = 5;
const stateUi: Record<ConnState, { tone: BadgeTone; text: string }> = {
  connecting: { tone: 'info', text: 'Menghubungkan' },
  connected: { tone: 'success', text: 'Terhubung' },
  reconnecting: { tone: 'warning', text: 'Menyambung ulang' },
  closed: { tone: 'neutral', text: 'Ditutup' },
  error: { tone: 'error', text: 'Gagal' },
};

interface Tab {
  key: number;
  state: ConnState;
  message?: string;
}

export function TerminalPage() {
  const { vmId = '' } = useParams();
  const nextKey = useRef(2);
  const [tabs, setTabs] = useState<Tab[]>([{ key: 1, state: 'connecting' }]);
  const [active, setActive] = useState(1);

  const setState = useCallback((key: number, state: ConnState, message?: string) => {
    setTabs((t) => t.map((x) => (x.key === key ? { ...x, state, message } : x)));
  }, []);

  const add = () => {
    const key = nextKey.current++;
    setTabs((t) => [...t, { key, state: 'connecting' }]);
    setActive(key);
  };
  const close = (key: number) => {
    setTabs((t) => {
      const rest = t.filter((x) => x.key !== key);
      if (active === key && rest.length) setActive(rest[rest.length - 1]!.key);
      return rest;
    });
  };

  const current = tabs.find((t) => t.key === active);

  return (
    <div>
      <PageHeader
        icon={<SquareTerminal className="h-5 w-5" />}
        title="Terminal"
        description="Shell langsung ke VM. Buka beberapa tab bila perlu; sesi diputus otomatis saat Anda keluar atau akun ditangguhkan."
      />

      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Tab terminal">
        {tabs.map((t, i) => (
          <div
            key={t.key}
            className={`flex items-center gap-2 rounded-lg border py-1 pr-1.5 pl-3 text-sm transition-colors ${t.key === active ? 'border-navy bg-navy text-white shadow-(--shadow-card)' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={t.key === active}
              onClick={() => setActive(t.key)}
              className="font-medium"
            >
              Tab {i + 1}
            </button>
            <Badge tone={stateUi[t.state].tone} dot>
              {stateUi[t.state].text}
            </Badge>
            <button
              type="button"
              aria-label={`Tutup tab ${i + 1}`}
              onClick={() => close(t.key)}
              className="rounded-md p-1 opacity-70 transition-opacity hover:bg-black/10 hover:opacity-100"
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus className="h-4 w-4" />}
          disabled={tabs.length >= MAX_TABS}
          onClick={add}
        >
          Tab baru
        </Button>
      </div>

      {current?.message && (current.state === 'error' || current.state === 'closed') && (
        <p
          role="alert"
          className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          {current.message}
        </p>
      )}

      <div className="mt-3 overflow-hidden rounded-xl border border-slate-800 bg-[#0a0f1e] shadow-(--shadow-lift)">
        <div
          className="flex items-center gap-1.5 border-b border-white/10 px-3 py-2"
          aria-hidden="true"
        >
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-green-400/80" />
        </div>
        {tabs.map((t) => (
          <TerminalView
            key={t.key}
            vmId={vmId}
            active={t.key === active}
            onState={(s, m) => setState(t.key, s, m)}
          />
        ))}
        {tabs.length === 0 && (
          <div className="p-6">
            <EmptyState
              icon={<SquareTerminal className="h-6 w-6" />}
              title="Semua tab ditutup"
              description='Klik "Tab baru" untuk membuka terminal lagi.'
            />
          </div>
        )}
      </div>
    </div>
  );
}
