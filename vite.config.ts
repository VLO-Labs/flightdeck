import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web app lives in src/web; the server serves dist/ in production.
// In dev, `npm run dev:web` proxies the API to the server on 8100.
export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: { outDir: '../../dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:8100' } },
});
