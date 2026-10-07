/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': { target: `http://localhost:${process.env.PANEL_API_PORT ?? 3000}`, ws: true },
    },
  },
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], globals: true },
});
