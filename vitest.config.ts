import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    // soak test is opt-in (`npm run test:soak:unit`) to keep CI fast
    name: 'unit',
  },
})
