export const formatTime = (ms: number | null): string =>
  ms
    ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
    : '-';

/** Sisa waktu menuju `target` dalam bahasa Indonesia, mis. "1 hari 2 jam", "45 menit", atau "Berakhir". */
export function formatRemaining(target: number, now: number = Date.now()): string {
  const diff = target - now;
  if (diff <= 0) return 'Berakhir';
  const minutes = Math.floor(diff / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return hours > 0 ? `${days} hari ${hours} jam` : `${days} hari`;
  if (hours > 0) return `${hours} jam ${minutes % 60} menit`;
  return `${Math.max(1, minutes)} menit`;
}

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
