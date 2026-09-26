import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // soak test is opt-in (`pnpm run test:soak:unit`) to keep CI fast
    name: '@orderbook/core',
  },
})
