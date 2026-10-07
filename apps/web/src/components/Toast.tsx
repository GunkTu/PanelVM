import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type ToastKind = 'success' | 'error' | 'warning' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  show: (kind: ToastKind, message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const styles: Record<ToastKind, string> = {
  success: 'bg-green-50 border-success text-green-900',
  error: 'bg-red-50 border-error text-red-900',
  warning: 'bg-yellow-50 border-warning text-yellow-900',
  info: 'bg-blue-50 border-info text-blue-900',
};

/** Sukses/info hilang otomatis. Error dan peringatan tetap sampai ditutup. */
const AUTO_DISMISS_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);

  const show = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId.current++;
      setItems((l) => [...l, { id, kind, message }]);
      if (kind === 'success' || kind === 'info') setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className={`flex items-start justify-between gap-3 rounded-md border-l-4 px-4 py-3 text-sm shadow ${styles[t.kind]}`}
          >
            <span>{t.message}</span>
            <button type="button" aria-label="Tutup notifikasi" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast harus dipakai di dalam ToastProvider');
  return ctx;
}
