import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        privacy: resolve(__dirname, 'privacy/index.html'),
        terms: resolve(__dirname, 'terms/index.html'),
        refunds: resolve(__dirname, 'refunds/index.html'),
        contact: resolve(__dirname, 'contact/index.html'),
        notFound: resolve(__dirname, '404.html'),
      },
    },
  },
});
