import type { ReactNode } from 'react';

export type BadgeTone = 'success' | 'error' | 'warning' | 'info' | 'neutral';

const tones: Record<BadgeTone, { box: string; dot: string }> = {
  success: { box: 'bg-green-50 text-green-800 ring-green-600/20', dot: 'bg-green-600' },
  error: { box: 'bg-red-50 text-red-800 ring-red-600/20', dot: 'bg-red-600' },
  warning: { box: 'bg-amber-50 text-amber-900 ring-amber-600/25', dot: 'bg-amber-500' },
  info: { box: 'bg-blue-50 text-blue-800 ring-blue-600/20', dot: 'bg-blue-600' },
  neutral: { box: 'bg-slate-100 text-slate-700 ring-slate-500/15', dot: 'bg-slate-400' },
};

export function Badge({
  tone = 'neutral',
  dot = false,
  children,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
}) {
  const t = tones[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${t.box}`}
    >
      {dot && <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />}
      {children}
    </span>
  );
}

/** Titik status kecil untuk VM/koneksi (dipasangkan dengan teks agar tidak bergantung pada warna saja). */
export function StatusDot({ tone }: { tone: BadgeTone }) {
  return (
    <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${tones[tone].dot}`} />
  );
}
