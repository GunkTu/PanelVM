import type { ReactNode } from 'react';

export interface CardProps {
  children: ReactNode;
  className?: string;
  /** Beri padding bawaan. Matikan untuk tabel/daftar yang mepet ke tepi. */
  padded?: boolean;
  /** Efek angkat saat hover untuk kartu yang bisa diklik. */
  interactive?: boolean;
}

export function Card({ children, className = '', padded = true, interactive = false }: CardProps) {
  return (
    <div
      className={`card ${padded ? 'p-5' : ''} ${interactive ? 'transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-(--shadow-lift)' : ''} ${className}`}
    >
      {children}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-base font-semibold text-navy">{children}</h2>
      {action}
    </div>
  );
}
