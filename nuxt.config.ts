// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  modules: ['@pinia/nuxt', '@nuxt/eslint'],
  vite: {
    worker: {
      // Comlink + module worker must survive bundling as ES modules
      format: 'es',
    },
  },
})
