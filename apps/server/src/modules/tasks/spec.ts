import { confAvailable, DOMAIN_RE } from '../sites/nginx.js';

/**
 * Pembangun berkas untuk cron, worker, dan aplikasi (Node/Python). Semua nilai divalidasi regex ketat sebelum
 * masuk ke berkas, dan berkas dikirim lewat stdin: tidak ada string pengguna yang disambung ke perintah shell.
 */
export type TaskKind = 'cron' | 'worker' | 'app';
export type Runtime = 'node' | 'python' | 'other';

export const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
/** Folder kerja hanya di /var/www atau /srv; tiap segmen diawali huruf/angka (menolak ".." dan file tersembunyi). */
export const WORKDIR_RE =
  /^\/(?:var\/www|srv)\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,3}$/;
/** Perintah = token dipisah satu spasi, tanpa tanda kutip, $, %, ;, |, &, <, >, `, atau tanda kurung. */
export const COMMAND_RE = /^[A-Za-z0-9_./:=@+,-]+(?: [A-Za-z0-9_./:=@+,-]+)*$/;
export const MAX_COMMAND = 300;
export const PORT_MIN = 3001;
export const PORT_MAX = 3999;

export const unitName = (kind: 'worker' | 'app', name: string): string =>
  `panelvm-${kind}-${name}.service`;
export const unitPath = (kind: 'worker' | 'app', name: string): string =>
  `/etc/systemd/system/${unitName(kind, name)}`;
export const cronPath = (name: string): string => `/etc/cron.d/panelvm-${name}`;
export const appRoot = (domain: string): string => `/var/www/${domain}`;

/** `{PORT}` boleh dipakai di perintah dan diganti dengan nomor port aplikasi. */
export const expandCommand = (cmd: string, port: number | null): string =>
  port === null ? cmd : cmd.replaceAll('{PORT}', String(port));

/** Kembalikan pesan galat (Indonesia) atau null bila perintah aman. */
export function commandProblem(cmd: string): string | null {
  if (cmd.length === 0 || cmd.length > MAX_COMMAND)
    return `Perintah wajib diisi, maksimal ${MAX_COMMAND} karakter.`;
  if (!COMMAND_RE.test(cmd.replaceAll('{PORT}', '0')))
    return 'Perintah hanya boleh berisi huruf, angka, dan karakter _ . / : = @ + , - dipisah spasi. Tanda kutip, $, %, ;, |, &, < dan > tidak diizinkan. Untuk perintah rumit, simpan sebagai skrip lalu panggil skripnya.';
  return null;
}

const FIELD_RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const PART_RE = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/;

/** Jadwal cron 5 kolom (atau @hourly dst.) yang valid per kolom. Nama bulan/hari ("mon") tidak didukung. */
export function validSchedule(s: string): boolean {
  if (/^@(?:hourly|daily|weekly|monthly|yearly)$/.test(s)) return true;
  const fields = s.split(' ');
  if (fields.length !== 5) return false;
  return fields.every((field, i) => {
    const [lo, hi] = FIELD_RANGES[i]!;
    return field.split(',').every((part) => {
      const m = PART_RE.exec(part);
      if (!m) return false;
      if (m[4] !== undefined && Number(m[4]) < 1) return false;
      if (m[1] === '*') return true;
      const a = Number(m[2]);
      const b = m[3] === undefined ? a : Number(m[3]);
      return a >= lo && b <= hi && a <= b;
    });
  });
}

/** Isi /etc/cron.d/panelvm-<nama>. Keluaran dibuang agar tidak memenuhi surat lokal. */
export function cronFile(t: {
  name: string;
  schedule: string;
  workdir: string;
  command: string;
}): string {
  if (!NAME_RE.test(t.name)) throw new Error('Nama tidak valid');
  if (!validSchedule(t.schedule)) throw new Error('Jadwal tidak valid');
  if (!WORKDIR_RE.test(t.workdir)) throw new Error('Folder kerja tidak valid');
  if (commandProblem(t.command)) throw new Error('Perintah tidak valid');
  return `# Dikelola PanelVM (${t.name}). Jangan diedit manual; ubah lewat panel.
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
${t.schedule} www-data cd ${t.workdir} && ${t.command} >/dev/null 2>&1
`;
}

export interface UnitInput {
  kind: 'worker' | 'app';
  name: string;
  workdir: string;
  /** Perintah mentah (boleh memuat {PORT}). */
  command: string;
  port: number | null;
  /** App memakai EnvironmentFile <folder>/.env (opsional) dan PORT. */
  withEnvFile: boolean;
}

/** Unit systemd. ExecStart lewat /usr/bin/env supaya `node`/`python3` dicari di PATH tanpa shell. */
export function systemdUnit(u: UnitInput): string {
  if (!NAME_RE.test(u.name)) throw new Error('Nama tidak valid');
  if (!WORKDIR_RE.test(u.workdir)) throw new Error('Folder kerja tidak valid');
  const problem = commandProblem(u.command);
  if (problem) throw new Error(problem);
  if (u.port !== null && !(Number.isInteger(u.port) && u.port >= PORT_MIN && u.port <= PORT_MAX))
    throw new Error('Port tidak valid');
  const exec = expandCommand(u.command, u.port);
  const env = [
    `Environment=HOME=${u.workdir}/.home`,
    ...(u.kind === 'app' ? ['Environment=NODE_ENV=production'] : []),
    ...(u.port !== null ? [`Environment=PORT=${u.port}`] : []),
    ...(u.withEnvFile ? [`EnvironmentFile=-${u.workdir}/.env`] : []),
  ].join('\n');
  return `# Dikelola PanelVM. Jangan diedit manual; ubah lewat panel.
[Unit]
Description=PanelVM ${u.kind} ${u.name}
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=${u.workdir}
${env}
ExecStart=/usr/bin/env ${exec}
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`;
}

/** Server block Nginx sebagai reverse proxy ke aplikasi di 127.0.0.1:<port> (WebSocket didukung). */
export function proxyConf(domain: string, port: number): string {
  if (!DOMAIN_RE.test(domain)) throw new Error('Domain tidak valid');
  if (!(Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX))
    throw new Error('Port tidak valid');
  return `server {
    listen 80;
    server_name ${domain};
    client_max_body_size 64M;

    access_log /var/log/nginx/${domain}.access.log;
    error_log /var/log/nginx/${domain}.error.log;

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 120s;
    }
}
`;
}

export const proxyConfPath = confAvailable;

/** Port pertama yang bebas di rentang aplikasi. */
export function nextFreePort(used: Iterable<number>): number | null {
  const taken = new Set(used);
  for (let p = PORT_MIN; p <= PORT_MAX; p++) if (!taken.has(p)) return p;
  return null;
}

export const RUNTIME_BIN: Record<Runtime, string | null> = {
  node: 'node',
  python: 'python3',
  other: null,
};
export const RUNTIME_HINT: Record<Runtime, string> = {
  node: 'Node.js belum terpasang di VM. Pasang lewat menu Aplikasi, lalu coba lagi.',
  python: 'Python 3 belum terpasang di VM. Pasang lewat menu Aplikasi, lalu coba lagi.',
  other: '',
};
