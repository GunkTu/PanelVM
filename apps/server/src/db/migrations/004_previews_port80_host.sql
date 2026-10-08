-- Preview boleh menunjuk port 80 (web standar) selain 1024-65535, dan bisa menetapkan header Host ke aplikasi
-- (Nginx di VM memilih situs berdasarkan nama domain). SQLite tidak bisa mengubah CHECK, jadi tabel dibangun ulang.
CREATE TABLE previews_new (
  id TEXT PRIMARY KEY,
  vm_id TEXT NOT NULL REFERENCES vms (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  subdomain TEXT NOT NULL UNIQUE,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  label TEXT NOT NULL DEFAULT '',
  host_header TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_access_at INTEGER,
  warned_at INTEGER
);
INSERT INTO previews_new (id, vm_id, user_id, subdomain, port, label, created_at, expires_at, last_access_at, warned_at)
  SELECT id, vm_id, user_id, subdomain, port, label, created_at, expires_at, last_access_at, warned_at FROM previews;
DROP TABLE previews;
ALTER TABLE previews_new RENAME TO previews;
CREATE INDEX idx_previews_vm ON previews (vm_id);
CREATE INDEX idx_previews_expires ON previews (expires_at);
