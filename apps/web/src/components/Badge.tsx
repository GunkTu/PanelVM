import type { ReactNode } from 'react';

export type BadgeTone = 'success' | 'error' | 'warning' | 'info' | 'neutral';

const tones: Record<BadgeTone, string> = {
  success: 'bg-green-100 text-green-900',
  error: 'bg-red-100 text-red-900',
  warning: 'bg-yellow-100 text-yellow-900',
  info: 'bg-blue-100 text-blue-900',
  neutral: 'bg-slate-100 text-slate-800',
};

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
