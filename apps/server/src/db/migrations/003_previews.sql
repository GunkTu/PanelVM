-- Modul baru: preview (tunnel HTTP/WebSocket ke port aplikasi di dalam VM lewat SSH). VM yang sudah ada ikut mendapat akses.
UPDATE vms SET modules_enabled = json_set(modules_enabled, '$.previews', json('true'));

-- Satu baris = satu alamat preview aktif. Mencabut preview = menghapus barisnya.
-- `subdomain` adalah kunci akses (acak 128 bit), jangan dicatat di audit log.
CREATE TABLE previews (
  id TEXT PRIMARY KEY,
  vm_id TEXT NOT NULL REFERENCES vms (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  subdomain TEXT NOT NULL UNIQUE,
  port INTEGER NOT NULL CHECK (port BETWEEN 1024 AND 65535),
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_access_at INTEGER,
  warned_at INTEGER
);
CREATE INDEX idx_previews_vm ON previews (vm_id);
CREATE INDEX idx_previews_expires ON previews (expires_at);
