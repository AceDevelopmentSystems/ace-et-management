/// <reference types="vitest" />
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// The dev server proxies /api to the Nest API so the browser stays same-origin (no CORS needed).
// Point it elsewhere with API_TARGET, from the environment or a gitignored apps/web/.env.local file,
// e.g. API_TARGET=http://localhost:3001
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: {
      // Honour PORT (set by tooling), else Vite's usual 5173.
      port: Number(process.env.PORT ?? env.WEB_PORT ?? 5173),
      proxy: { '/api': { target: process.env.API_TARGET ?? env.API_TARGET ?? 'http://localhost:3000', changeOrigin: true } },
    },
    test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test-setup.ts'], css: false },
  };
});
