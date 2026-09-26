import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.PORT ?? 4174)

/**
 * Functional + performance gates for the React client (same budgets as the
 * Nuxt client: INP < 200ms, zero >= 50ms long tasks under 100 events/s).
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['github'], ['list']] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}/react`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: process.env.E2E_DEV ? 'pnpm run dev' : 'pnpm run build && pnpm run preview',
    url: `http://127.0.0.1:${PORT}/react`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    env: { PORT: String(PORT) },
  },
  projects: [
    {
      name: 'e2e',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
          ],
        },
      },
    },
  ],
})
