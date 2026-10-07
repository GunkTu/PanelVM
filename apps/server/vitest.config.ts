import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Test integrasi memakai SSH/MariaDB/apt sungguhan; beri ruang saat mesin sibuk agar tidak flake.
  test: { testTimeout: 30_000, hookTimeout: 60_000 },
});
