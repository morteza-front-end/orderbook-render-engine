import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.PORT ?? 4173)

/**
 * Two projects:
 *  - `e2e`  : functional + performance gates (INP < 200ms, no 50ms long task)
 *  - `soak` : 30-minute memory leak run (nightly workflow; SOAK_DURATION_MS)
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['github'], ['list']] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: process.env.E2E_DEV ? 'npm run dev' : 'npm run build && npm run preview',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    env: { PORT: String(PORT) },
  },
  projects: [
    {
      name: 'e2e',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /soak\.spec\.ts/,
    },
    {
      name: 'soak',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /soak\.spec\.ts/,
    },
  ],
})
