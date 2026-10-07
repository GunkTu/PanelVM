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
