-- Jadwal (cron), worker (queue/proses latar belakang), dan aplikasi Node/Python yang dikelola panel di VM.
-- Berkas di VM: /etc/cron.d/panelvm-<nama> atau unit systemd panelvm-<worker|app>-<nama>.service.
CREATE TABLE vm_tasks (
  id TEXT PRIMARY KEY,
  vm_id TEXT NOT NULL REFERENCES vms (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('cron', 'worker', 'app')),
  name TEXT NOT NULL,
  site_id TEXT REFERENCES sites (id) ON DELETE SET NULL,
  domain TEXT,
  runtime TEXT CHECK (runtime IN ('node', 'python', 'other')),
  workdir TEXT NOT NULL,
  command TEXT NOT NULL,
  install_cmd TEXT,
  schedule TEXT,
  port INTEGER,
  git_url TEXT,
  git_branch TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (vm_id, name)
);
CREATE UNIQUE INDEX idx_tasks_port ON vm_tasks (vm_id, port) WHERE port IS NOT NULL;
CREATE UNIQUE INDEX idx_tasks_domain ON vm_tasks (vm_id, domain) WHERE domain IS NOT NULL;
