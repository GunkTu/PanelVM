export const formatTime = (ms: number | null): string =>
  ms
    ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
    : '-';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

export const joinPath = (dir: string, name: string): string =>
  dir === '/' ? `/${name}` : `${dir}/${name}`;
export const parentPath = (p: string): string =>
  p === '/' ? '/' : p.slice(0, p.lastIndexOf('/')) || '/';
