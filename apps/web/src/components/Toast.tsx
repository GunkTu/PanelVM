import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
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

const styles: Record<ToastKind, { box: string; icon: ReactNode }> = {
  success: {
    box: 'border-green-200 bg-green-50 text-green-900',
    icon: <CheckCircle2 className="h-5 w-5 text-green-600" />,
  },
  error: {
    box: 'border-red-200 bg-red-50 text-red-900',
    icon: <XCircle className="h-5 w-5 text-red-600" />,
  },
  warning: {
    box: 'border-amber-200 bg-amber-50 text-amber-900',
    icon: <AlertTriangle className="h-5 w-5 text-amber-600" />,
  },
  info: {
    box: 'border-blue-200 bg-blue-50 text-blue-900',
    icon: <Info className="h-5 w-5 text-blue-600" />,
  },
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
      <div className="fixed right-4 bottom-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-(--shadow-lift) animate-slide-in ${styles[t.kind].box}`}
          >
            <span aria-hidden="true" className="mt-0.5 shrink-0">
              {styles[t.kind].icon}
            </span>
            <span className="min-w-0 flex-1">{t.message}</span>
            <button
              type="button"
              aria-label="Tutup notifikasi"
              onClick={() => dismiss(t.id)}
              className="shrink-0 rounded-md p-0.5 opacity-60 transition-opacity hover:opacity-100"
            >
              <X aria-hidden="true" className="h-4 w-4" />
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
