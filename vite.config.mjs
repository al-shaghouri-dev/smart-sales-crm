import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Frontend lives in web/; production build is served by Express from dist/web.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/uploads': 'http://localhost:3000',
      '/webhooks': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true }
    }
  }
});
