import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // the landing page owns the root path of the deployed domain
  base: '/',
  build: {
    outDir: 'dist',
  },
})
