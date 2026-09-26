import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  // deployed under the shared domain's /react sub-path (see root README);
  // applies to both the dev server and production builds
  base: '/react/',
  plugins: [react(), tailwindcss()],
  worker: {
    // Comlink + module worker must survive bundling as ES modules
    format: 'es',
  },
  // @orderbook/core ships raw TypeScript source (internal package pattern);
  // Vite transforms workspace-linked source natively, no transpile config
  // is required — this entry exists to make the intent explicit.
  optimizeDeps: {
    include: ['@orderbook/core'],
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
  },
  preview: {
    host: '127.0.0.1',
    port: 4174,
  },
  build: {
    outDir: 'dist',
  },
})
