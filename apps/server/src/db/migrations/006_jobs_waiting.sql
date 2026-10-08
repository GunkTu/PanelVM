-- Job bisa berhenti menunggu tindakan pengguna (mis. memperbaiki .env sebelum migrasi) lalu dilanjutkan.
-- Status baru 'waiting' dan kolom wait_message; CHECK tidak bisa diubah, jadi tabel dibangun ulang.
CREATE TABLE jobs_new (
  id TEXT PRIMARY KEY,
  vm_id TEXT NOT NULL REFERENCES vms (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'waiting', 'succeeded', 'failed')),
  log TEXT NOT NULL DEFAULT '',
  wait_message TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
INSERT INTO jobs_new (id, vm_id, user_id, kind, title, status, log, created_at, finished_at)
  SELECT id, vm_id, user_id, kind, title, status, log, created_at, finished_at FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;
CREATE INDEX idx_jobs_vm ON jobs (vm_id, created_at);
