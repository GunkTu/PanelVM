import type { ReactNode } from 'react';

export interface TabItem<K extends string> {
  key: K;
  label: ReactNode;
}

/** Tab bergaya segmented control. Tiap tab adalah button role="tab" dengan aria-selected. */
export function Tabs<K extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: TabItem<K>[];
  value: K;
  onChange: (k: K) => void;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="inline-flex gap-1 rounded-xl bg-slate-200/60 p-1"
    >
      {items.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-all ${value === t.key ? 'bg-white text-navy shadow-(--shadow-card)' : 'text-slate-600 hover:text-navy'}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
