-- Modul baru: software (installer) dan sites (situs web). VM yang sudah ada ikut mendapat akses.
UPDATE vms SET modules_enabled = json_set(modules_enabled, '$.software', json('true'), '$.sites', json('true'));

-- Job latar belakang (instalasi paket, deploy) dengan log yang bisa dipantau dari UI.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  vm_id TEXT NOT NULL REFERENCES vms (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  log TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX idx_jobs_vm ON jobs (vm_id, created_at);

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  vm_id TEXT NOT NULL REFERENCES vms (id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('laravel', 'php', 'static')),
  php_version TEXT,
  root_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (vm_id, domain)
);
