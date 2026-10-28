import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Dev server setup.
 *
 * /socket.io is proxied to the local signaling server so the app works with
 * zero configuration: `npm run dev` at the repo root starts both processes and
 * the frontend talks to the same origin it was served from.
 *
 * For a deployed frontend set VITE_SIGNALING_URL at build time instead.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/socket.io': {
        target: process.env.SIGNALING_PROXY_TARGET || 'http://localhost:4000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
