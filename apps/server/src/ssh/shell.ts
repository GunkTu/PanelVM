/**
 * Quoting shell untuk perintah SSH exec.
 *
 * ssh2 `exec()` menerima SATU string yang dijalankan shell di VM, jadi setiap argumen WAJIB
 * di-quote. Aturan proyek: perintah selalu berupa daftar argumen tetap (argv); data dinamis
 * sebaiknya lewat stdin. `shellQuote` hanya dipakai untuk membungkus argumen yang sudah divalidasi.
 */
export function shellQuote(arg: string): string {
  if (arg.includes('\0')) throw new Error('Argumen perintah tidak boleh memuat karakter NUL');
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

const ENV_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface CommandOptions {
  env?: Record<string, string>;
  /** Jalankan lewat `sudo -n` (untuk user SSH non-root). */
  sudo?: boolean;
}

export function buildCommand(argv: string[], opts: CommandOptions = {}): string {
  if (argv.length === 0 || !argv[0]) throw new Error('Perintah kosong');
  const parts: string[] = [];
  if (opts.sudo) parts.push('sudo', '-n', '--');
  if (opts.env && Object.keys(opts.env).length) {
    parts.push('env');
    for (const [k, v] of Object.entries(opts.env)) {
      if (!ENV_KEY.test(k)) throw new Error('Nama variabel environment tidak valid');
      parts.push(`${k}=${v}`);
    }
  }
  parts.push(...argv);
  return parts.map(shellQuote).join(' ');
}

/** Bungkus argv agar dijalankan di direktori tertentu (skrip statis, argumen lewat parameter posisi). */
export function inDir(dir: string, argv: string[]): string[] {
  return ['sh', '-c', 'cd "$1" && shift && exec "$@"', 'sh', dir, ...argv];
}
