import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  root: __dirname,
  plugins: [vue(), tailwindcss()],
  build: {
    // Matches src/server's expected static dir (dist/web, resolved relative
    // to the compiled server entrypoint at dist/server/index.js).
    outDir: path.resolve(__dirname, '../../dist/web'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
