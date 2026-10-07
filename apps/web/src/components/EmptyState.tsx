import type { ReactNode } from 'react';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** State kosong yang menjelaskan apa yang terjadi dan langkah berikutnya. */
export function EmptyState({ icon, title, description, action, className = '' }: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center rounded-(--radius-card) border border-dashed border-slate-300 bg-white/60 px-6 py-12 text-center ${className}`}
    >
      {icon && (
        <span
          aria-hidden="true"
          className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500"
        >
          {icon}
        </span>
      )}
      <p className="font-semibold text-slate-800">{title}</p>
      {description && <p className="mt-1 max-w-md text-sm text-slate-600">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
