export type Stage = 'pending_2fa' | 'pending_setup' | 'active';

export interface User {
  id: string;
  email: string;
  role: 'admin' | 'client';
  status: 'active' | 'suspended';
  totpEnabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface Me {
  stage: Stage;
  user: User;
  csrfToken: string;
}

export interface Modules {
  terminal: boolean;
  files: boolean;
  database: boolean;
  monitoring: boolean;
  services: boolean;
  software: boolean;
  sites: boolean;
  previews: boolean;
}

export interface Vm {
  id: string;
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  status: 'online' | 'offline' | 'unknown';
  hostKeyFingerprint: string | null;
  hostKeyApproved: boolean;
  modules: Modules;
  createdAt: number;
  publicKey?: string;
  assignedTo?: { id: string; email: string } | null;
}

export interface ClientUser extends User {
  vm: { id: string; name: string } | null;
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: number;
}

export interface AuditItem {
  id: number;
  ts: number;
  userId: string | null;
  vmId: string | null;
  ip: string | null;
  action: string;
  target: string | null;
  result: string;
  meta: string | null;
}

export interface FileEntry {
  name: string;
  type: 'dir' | 'file' | 'link' | 'other';
  isLink: boolean;
  size: number;
  mode: string;
  mtime: number;
  uid: number;
  gid: number;
}

export interface Job {
  id: string;
  kind: string;
  title: string;
  status: 'running' | 'succeeded' | 'failed';
  log?: string;
  createdAt: number;
  finishedAt: number | null;
}

export interface Preview {
  id: string;
  vmId: string;
  port: number;
  label: string;
  /** Domain situs di Nginx VM yang dikirim sebagai header Host (opsional). */
  hostHeader: string | null;
  /** 'public' = siapa pun yang tahu alamatnya; 'password' = perlu kata sandi. */
  access: 'public' | 'password';
  /** Alamat publik preview. Ini kunci akses: siapa pun yang punya link bisa melihat aplikasinya. */
  url: string;
  createdAt: number;
  expiresAt: number;
  lastAccessAt: number | null;
  connections: number;
}

export interface AdminPreview extends Preview {
  vmName: string;
  vmStatus: 'online' | 'offline' | 'unknown';
  owner: string;
  live: boolean;
}

export interface Credentials {
  user: string;
  password: string;
  database: string | null;
  envSnippet: string;
}
