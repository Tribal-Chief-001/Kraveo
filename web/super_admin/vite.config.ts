import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Never inline fonts/assets as data: URIs - the production CSP only allows font-src 'self'.
    assetsInlineLimit: 0,
  },
  server: {
    port: 3000
  }
});
