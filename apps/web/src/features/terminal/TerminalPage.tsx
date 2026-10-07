import { useCallback, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Badge, Button, type BadgeTone } from '../../components';
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
      <h1 className="text-2xl font-semibold text-navy">Terminal</h1>
      <div className="mt-3 flex flex-wrap items-center gap-2" role="tablist">
        {tabs.map((t, i) => (
          <div
            key={t.key}
            className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${t.key === active ? 'border-navy bg-navy text-white' : 'border-slate-300'}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={t.key === active}
              onClick={() => setActive(t.key)}
            >
              Tab {i + 1}
            </button>
            <Badge tone={stateUi[t.state].tone}>{stateUi[t.state].text}</Badge>
            <button type="button" aria-label={`Tutup tab ${i + 1}`} onClick={() => close(t.key)}>
              ×
            </button>
          </div>
        ))}
        <Button variant="ghost" disabled={tabs.length >= MAX_TABS} onClick={add}>
          + Tab baru
        </Button>
      </div>
      {current?.message && (current.state === 'error' || current.state === 'closed') && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-warning bg-yellow-50 p-3 text-sm text-yellow-900"
        >
          {current.message}
        </p>
      )}
      <div className="mt-3">
        {tabs.map((t) => (
          <TerminalView
            key={t.key}
            vmId={vmId}
            active={t.key === active}
            onState={(s, m) => setState(t.key, s, m)}
          />
        ))}
        {tabs.length === 0 && (
          <p className="rounded-md border border-dashed border-slate-300 p-6 text-sm text-slate-600">
            Semua tab ditutup. Klik "+ Tab baru" untuk membuka terminal.
          </p>
        )}
      </div>
    </div>
  );
}
