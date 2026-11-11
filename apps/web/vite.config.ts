import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// PUBLIC_HOST is set in the dev compose (Coolify hot-reload service).
const publicHost = process.env.PUBLIC_HOST;
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: publicHost ? [publicHost] : [],
    hmr: publicHost ? { host: publicHost, protocol: 'wss', clientPort: 443 } : undefined,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
      '/health': { target: apiTarget },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
