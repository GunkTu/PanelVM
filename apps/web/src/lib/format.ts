export const formatTime = (ms: number | null): string =>
  ms
    ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
    : '-';
