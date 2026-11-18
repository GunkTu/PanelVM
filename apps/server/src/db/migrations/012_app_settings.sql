-- Pengaturan aplikasi sederhana (kunci -> JSON). Dipakai mode maintenance agar bertahan melewati restart panel.
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
