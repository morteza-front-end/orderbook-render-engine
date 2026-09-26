import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.PORT ?? 4173)

/**
 * Two projects:
 *  - `e2e`  : functional + performance gates (INP < 200ms, no 50ms long task)
 *  - `soak` : 30-minute memory leak run (nightly workflow; SOAK_DURATION_MS)
 *
 * The app is served under its deployment base path (/nuxt) so e2e exercises
 * the exact routing used in production.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // serial execution: parallel pages contend for CPU and background pages
  // get their rAF throttled, which would poison the performance measurements
  workers: 1,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['github'], ['list']] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}/nuxt`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: process.env.E2E_DEV ? 'pnpm run dev' : 'pnpm run build && pnpm run preview',
    url: `http://127.0.0.1:${PORT}/nuxt`,
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
      testIgnore: /soak\.spec\.ts/,
    },
    {
      name: 'soak',
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
      testMatch: /soak\.spec\.ts/,
    },
  ],
})
