-- Batas jumlah situs web per client (diatur admin). Admin tidak dibatasi. 0 = tidak boleh membuat situs.
ALTER TABLE users ADD COLUMN max_sites INTEGER NOT NULL DEFAULT 5 CHECK (max_sites BETWEEN 0 AND 1000);
