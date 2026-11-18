/** Kunci .env yang boleh diatur panel. Nilai selalu dibuat panel (nama/user tervalidasi, password alfanumerik). */
const KEY_RE = /^[A-Z][A-Z0-9_]{1,40}$/;
const VALUE_RE = /^[A-Za-z0-9_.:@/-]{0,128}$/;

/**
 * Atur beberapa variabel di isi berkas .env tanpa menyentuh baris lain. Baris yang sudah ada (termasuk yang
 * dikomentari "# KEY=") diganti di tempat; kunci yang belum ada ditambahkan di akhir. Nilai dibatasi karakter
 * aman sehingga tidak perlu kutipan dan tidak bisa menyisipkan baris baru.
 */
export function setEnvVars(content: string, vars: Record<string, string>): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content === '' ? [] : content.split(/\r?\n/);
  const done = new Set<string>();
  for (const [k, v] of Object.entries(vars)) {
    if (!KEY_RE.test(k)) throw new Error('Nama variabel .env tidak valid');
    if (!VALUE_RE.test(v)) throw new Error(`Nilai ${k} memuat karakter yang tidak diizinkan`);
  }
  const out = lines.map((line) => {
    const m = /^\s*(?:#\s*)?([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    const key = m?.[1];
    if (key && key in vars && !done.has(key)) {
      done.add(key);
      return `${key}=${vars[key]}`;
    }
    return line;
  });
  const missing = Object.keys(vars).filter((k) => !done.has(k));
  if (missing.length) {
    if (out.length && out[out.length - 1] === '') out.pop();
    for (const k of missing) out.push(`${k}=${vars[k]}`);
    out.push('');
  }
  return out.join(eol);
}

/**
 * Nama database/user bawaan dari domain: buang TLD, ganti karakter selain huruf/angka dengan "_",
 * awali "s_" bila tidak diawali huruf. Hasil selalu lolos IDENT (3-28 karakter, sisa ruang untuk "_u").
 */
export function dbNameFromDomain(domain: string): string {
  const base = domain
    .toLowerCase()
    .replace(/\.[a-z]{2,63}$/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  let name = /^[a-z]/.test(base) ? base : `s_${base}`;
  name = name.slice(0, 28).replace(/_+$/, '');
  return name.length >= 3 ? name : `${name}_db`.slice(0, 28);
}
