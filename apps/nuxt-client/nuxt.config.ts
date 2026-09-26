import tailwindcss from '@tailwindcss/vite'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  modules: ['@nuxt/eslint'],
  css: ['~/assets/css/main.css'],
  // deployed under the shared domain's /nuxt sub-path (see root README);
  // applies to both the dev server and production builds
  app: {
    baseURL: '/nuxt/',
  },
  typescript: {
    tsConfig: {
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
  // @orderbook/core ships raw TypeScript source (internal package pattern);
  // tell Nuxt to transpile it like first-party code
  build: {
    transpile: ['@orderbook/core'],
  },
})
