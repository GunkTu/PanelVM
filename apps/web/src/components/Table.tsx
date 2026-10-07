import type { ReactNode } from 'react';
import { Skeleton } from './Skeleton';

export interface Column<T> {
  header: string;
  render: (row: T) => ReactNode;
}

export interface TableProps<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  /** Pesan saat data kosong; sebaiknya menyebut langkah berikutnya. */
  emptyMessage: string;
  error?: string;
}

export function Table<T>({ columns, rows, rowKey, loading, emptyMessage, error }: TableProps<T>) {
  if (error) {
    return (
      <p role="alert" className="rounded-md border border-error bg-red-50 p-4 text-sm text-red-900">
        {error}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            {columns.map((c) => (
              <th key={c.header} scope="col" className="px-4 py-2 font-medium">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {loading ? (
            Array.from({ length: 3 }, (_, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.header} className="px-4 py-3">
                    <Skeleton />
                  </td>
                ))}
              </tr>
            ))
          ) : rows && rows.length > 0 ? (
            rows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((c) => (
                  <td key={c.header} className="px-4 py-3">
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={columns.length} className="px-4 py-8 text-center text-slate-500">
                {emptyMessage}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
