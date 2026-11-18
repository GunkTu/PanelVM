-- phpMyAdmin per VM: dipasang panel di /opt/phpmyadmin, hanya mendengarkan 127.0.0.1 di VM dan dibuka lewat
-- tunnel preview yang dijaga tiket sekali pakai dari panel (bukan kata sandi). purpose = 'pma' menandai baris
-- preview milik sistem: tidak muncul di daftar preview pengguna dan tidak dihitung ke batas preview.
ALTER TABLE previews ADD COLUMN purpose TEXT;

CREATE TABLE vm_phpmyadmin (
  vm_id TEXT PRIMARY KEY REFERENCES vms (id) ON DELETE CASCADE,
  php_version TEXT NOT NULL,
  port INTEGER NOT NULL,
  version TEXT,
  installed_at INTEGER NOT NULL
);
