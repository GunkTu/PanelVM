CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'client')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  totp_secret_enc TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_step INTEGER,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at INTEGER
);
CREATE INDEX idx_recovery_user ON recovery_codes (user_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  stage TEXT NOT NULL CHECK (stage IN ('pending_2fa', 'pending_setup', 'active')),
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  fail_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

CREATE TABLE known_devices (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, fingerprint)
);

CREATE TABLE vms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL,
  ssh_port INTEGER NOT NULL DEFAULT 22,
  ssh_user TEXT NOT NULL,
  ssh_private_key_enc TEXT NOT NULL,
  ssh_public_key TEXT NOT NULL,
  host_key_fingerprint TEXT,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('online', 'offline', 'unknown')),
  modules_enabled TEXT NOT NULL DEFAULT '{"terminal":true,"files":true,"database":true,"monitoring":true,"services":true}',
  created_at INTEGER NOT NULL
);

-- UNIQUE(vm_id): satu VM hanya untuk satu client. Constraint sengaja dipisah agar mudah dilonggarkan.
CREATE TABLE vm_access (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  vm_id TEXT NOT NULL REFERENCES vms (id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'client',
  UNIQUE (vm_id)
);
CREATE INDEX idx_vm_access_user ON vm_access (user_id);

CREATE TABLE db_instances (
  id TEXT PRIMARY KEY,
  vm_id TEXT NOT NULL REFERENCES vms (id) ON DELETE CASCADE,
  engine TEXT NOT NULL CHECK (engine IN ('mysql', 'postgres')),
  is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_notifications_user ON notifications (user_id, created_at);

-- Tanpa foreign key agar riwayat tetap ada setelah user/VM dihapus. Append-only dari sisi aplikasi.
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id TEXT,
  vm_id TEXT,
  ip TEXT,
  action TEXT NOT NULL,
  target TEXT,
  result TEXT NOT NULL,
  meta TEXT
);
CREATE INDEX idx_audit_ts ON audit_logs (ts);

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs bersifat append-only');
END;
