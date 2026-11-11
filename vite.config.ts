import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  base: './',
  plugins: [solid()],
  worker: { format: 'es' },
  build: { target: 'es2022', assetsInlineLimit: 0 },
  server: { port: 5183, strictPort: false },
});
