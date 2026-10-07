import type { Client as SshClient } from 'ssh2';
import { execRemote, type ExecOptions } from '../../ssh/exec.js';
import { CATALOG, PHP_VERSION, PG_VERSION, SUPPORTED_OS, type ItemId } from './catalog.js';

export interface OsInfo {
  id: string;
  versionId: string;
  codename: string;
  pretty: string;
  supported: boolean;
}

export function parseOsRelease(text: string): OsInfo {
  const kv: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) kv[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
  const id = (kv.ID ?? '').toLowerCase();
  return {
    id,
    versionId: kv.VERSION_ID ?? '',
    codename: /^[a-z]+$/.test(kv.VERSION_CODENAME ?? '') ? kv.VERSION_CODENAME! : '',
    pretty: kv.PRETTY_NAME ?? id,
    supported: SUPPORTED_OS.has(id),
  };
}

/** Hasil `dpkg-query -W -f='${Package}\t${db:Status-Abbrev}\t${Version}\n'`. Hanya status "ii" yang dianggap terpasang. */
export function parseDpkg(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const [pkg, status, version] = line.split('\t');
    if (pkg && status?.trim().startsWith('ii') && version) out.set(pkg, version);
  }
  return out;
}

/** Hasil `apt-cache policy`: paket -> Candidate (atau null). */
export function parsePolicy(text: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  let current: string | null = null;
  for (const line of text.split('\n')) {
    const head = /^(\S+):$/.exec(line);
    if (head) current = head[1]!;
    const cand = /^\s+Candidate:\s+(\S+)/.exec(line);
    if (cand && current) out.set(current, cand[1] === '(none)' ? null : cand[1]!);
  }
  return out;
}

export interface VersionedItem {
  version: string;
  installed: boolean;
  candidate: string | null;
}

export interface SoftwareStatus {
  os: OsInfo;
  items: {
    id: ItemId;
    title: string;
    description: string;
    installed: boolean;
    version: string | null;
    candidate: string | null;
    available: boolean;
    conflict?: string;
  }[];
  php: { repoInstalled: boolean; versions: VersionedItem[] };
  postgres: { versions: VersionedItem[] };
}

const run = (ssh: SshClient, argv: string[], opts: Pick<ExecOptions, 'sudo'>, timeoutMs = 30_000) =>
  execRemote(ssh, argv, { ...opts, timeoutMs }).catch(() => ({
    code: -1,
    stdout: '',
    stderr: '',
    truncated: false,
  }));

const FIXED_PACKAGES = [
  'nginx',
  'unzip',
  'zip',
  'curl',
  'git',
  'ca-certificates',
  'rsync',
  'mariadb-server',
  'mysql-server',
  'redis-server',
  'postgresql',
];

/** Kumpulkan status software dari VM dengan perintah baca-saja yang tetap. */
export async function collectStatus(
  ssh: SshClient,
  opts: Pick<ExecOptions, 'sudo'>,
): Promise<SoftwareStatus> {
  const dpkgFmt = '${Package}\t${db:Status-Abbrev}\t${Version}\n';
  const [osr, fixed, phpFpm, pgPk, policy, phpAvail, pgAvail, composer, repoList] =
    await Promise.all([
      run(ssh, ['cat', '/etc/os-release'], opts),
      run(ssh, ['dpkg-query', '-W', `-f=${dpkgFmt}`, ...FIXED_PACKAGES], opts),
      run(ssh, ['dpkg-query', '-W', `-f=${dpkgFmt}`, 'php*-fpm'], opts),
      run(ssh, ['dpkg-query', '-W', `-f=${dpkgFmt}`, 'postgresql-[0-9]*'], opts),
      run(
        ssh,
        [
          'apt-cache',
          'policy',
          'nginx',
          'mariadb-server',
          'mysql-server',
          'redis-server',
          'postgresql',
        ],
        opts,
      ),
      run(ssh, ['apt-cache', 'search', '--names-only', '^php[0-9]+\\.[0-9]+-fpm$'], opts),
      run(ssh, ['apt-cache', 'search', '--names-only', '^postgresql-[0-9]+$'], opts),
      run(
        ssh,
        [
          'sh',
          '-c',
          'command -v composer >/dev/null 2>&1 && COMPOSER_ALLOW_SUPERUSER=1 composer --version --no-ansi 2>/dev/null | head -n 1',
        ],
        opts,
      ),
      run(ssh, ['sh', '-c', 'ls /etc/apt/sources.list.d 2>/dev/null'], opts),
    ]);

  const os = parseOsRelease(osr.stdout);
  const installed = parseDpkg(fixed.stdout);
  const cand = parsePolicy(policy.stdout);

  const phpInstalled = parseDpkg(phpFpm.stdout);
  const phpVersions = new Map<string, VersionedItem>();
  for (const line of phpAvail.stdout.split('\n')) {
    const m = /^php(\d+\.\d+)-fpm\b/.exec(line);
    if (m && PHP_VERSION.test(m[1]!))
      phpVersions.set(m[1]!, { version: m[1]!, installed: false, candidate: null });
  }
  for (const [pkg, ver] of phpInstalled) {
    const m = /^php(\d+\.\d+)-fpm$/.exec(pkg);
    if (m && PHP_VERSION.test(m[1]!))
      phpVersions.set(m[1]!, {
        version: m[1]!,
        installed: true,
        candidate: phpVersions.get(m[1]!)?.candidate ?? ver,
      });
  }

  const pgInstalled = parseDpkg(pgPk.stdout);
  const pgVersions = new Map<string, VersionedItem>();
  for (const line of pgAvail.stdout.split('\n')) {
    const m = /^postgresql-(\d+)\b/.exec(line);
    if (m && PG_VERSION.test(m[1]!))
      pgVersions.set(m[1]!, { version: m[1]!, installed: false, candidate: null });
  }
  for (const [pkg, ver] of pgInstalled) {
    const m = /^postgresql-(\d+)$/.exec(pkg);
    if (m && PG_VERSION.test(m[1]!))
      pgVersions.set(m[1]!, { version: m[1]!, installed: true, candidate: ver });
  }
  const byVersion = (a: VersionedItem, b: VersionedItem) =>
    Number(b.version.replace('.', '')) - Number(a.version.replace('.', ''));

  const composerLine = composer.stdout.trim();
  const composerVersion = /Composer version (\S+)/.exec(composerLine)?.[1] ?? null;
  const mariadbInstalled = installed.has('mariadb-server');
  const mysqlInstalled = installed.has('mysql-server');
  const baseTools = ['unzip', 'zip', 'curl', 'git', 'rsync'];

  const row = (
    id: ItemId,
    isInstalled: boolean,
    version: string | null,
    candidate: string | null,
    extra: { conflict?: string; available?: boolean } = {},
  ) => ({
    id,
    title: CATALOG[id].title,
    description: CATALOG[id].description,
    installed: isInstalled,
    version,
    candidate,
    available: extra.available ?? true,
    ...(extra.conflict ? { conflict: extra.conflict } : {}),
  });

  const repoInstalled = /(ondrej|sury)/i.test(repoList.stdout);

  return {
    os,
    items: [
      row(
        'base-tools',
        baseTools.every((p) => installed.has(p)),
        null,
        null,
      ),
      row(
        'nginx',
        installed.has('nginx'),
        installed.get('nginx') ?? null,
        cand.get('nginx') ?? null,
        { available: cand.get('nginx') != null || installed.has('nginx') },
      ),
      row('composer', composerVersion !== null, composerVersion, null),
      row(
        'mariadb',
        mariadbInstalled,
        installed.get('mariadb-server') ?? null,
        cand.get('mariadb-server') ?? null,
        {
          available: cand.get('mariadb-server') != null || mariadbInstalled,
          conflict: mysqlInstalled
            ? 'MySQL sudah terpasang. MySQL dan MariaDB tidak bisa dipasang bersamaan.'
            : undefined,
        },
      ),
      row(
        'mysql',
        mysqlInstalled,
        installed.get('mysql-server') ?? null,
        cand.get('mysql-server') ?? null,
        {
          available: cand.get('mysql-server') != null || mysqlInstalled,
          conflict: mariadbInstalled
            ? 'MariaDB sudah terpasang. MySQL dan MariaDB tidak bisa dipasang bersamaan.'
            : undefined,
        },
      ),
      row(
        'redis',
        installed.has('redis-server'),
        installed.get('redis-server') ?? null,
        cand.get('redis-server') ?? null,
        { available: cand.get('redis-server') != null || installed.has('redis-server') },
      ),
    ],
    php: { repoInstalled, versions: [...phpVersions.values()].sort(byVersion) },
    postgres: { versions: [...pgVersions.values()].sort(byVersion) },
  };
}
