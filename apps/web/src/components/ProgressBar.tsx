/** Bar penggunaan: hijau, kuning (>= 75%), merah (>= 90%). Angka selalu ditampilkan di dekatnya (tidak bergantung warna). */
export function ProgressBar({
  percent,
  label,
  className = '',
}: {
  percent: number;
  label: string;
  className?: string;
}) {
  const p = Math.min(100, Math.max(0, percent));
  const tone = p >= 90 ? 'bg-error' : p >= 75 ? 'bg-yellow' : 'bg-success';
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(p)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={className}
    >
      <div className="h-2 overflow-hidden rounded-full bg-slate-200">
        <div
          className={`h-2 rounded-full ${tone} transition-all duration-500`}
          style={{ width: `${p}%` }}
        />
      </div>
    </div>
  );
}
