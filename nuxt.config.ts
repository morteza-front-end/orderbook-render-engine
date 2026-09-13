import tailwindcss from '@tailwindcss/vite'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  typescript: {
    tsConfig: {
      // include the root-level worker entry in app typecheck contexts
      include: ['../worker/**/*.ts'],
      compilerOptions: {
        strict: true,
        noUncheckedIndexedAccess: true,
      },
    },
  },
  vite: {
    plugins: [tailwindcss()],
    worker: {
      // Comlink + module worker must survive bundling as ES modules
      format: 'es',
    },
  },
})
