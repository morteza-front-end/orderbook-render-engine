import { expect, test } from '@playwright/test'

/**
 * Performance gates for the React client — identical budgets to the Nuxt
 * client (INP < 200ms, zero >= 50ms long tasks at 100 events/s), proving
 * the framework-agnostic core keeps React on the same performance
 * envelope as Vue with `shallowRef`.
 */

const PERF_INIT = `
  window.__obPerf = { events: [], longTasks: [] };
  (() => {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__obPerf.events.push({ name: e.name, duration: e.duration, startTime: e.startTime });
        }
      }).observe({ type: 'event', durationThreshold: 16 });
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__obPerf.longTasks.push({ duration: e.duration, startTime: e.startTime });
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch {}
  })();
`

const WARMUP_MS = 6000
const MEASURE_MS = 8000
const INP_BUDGET_MS = 200
const LONG_TASK_BUDGET_MS = 50

declare global {
  interface Window {
    __obPerf: {
      events: { name: string; duration: number; startTime: number }[]
      longTasks: { duration: number; startTime: number }[]
    }
  }
}

test('React client: INP under 200ms and no 50ms long tasks under data pressure', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(String(err)))

  await page.bringToFront()
  await page.addInitScript(PERF_INIT)
  await page.goto('/?feed=synthetic&rate=100')

  await expect(page.getByTestId('status')).toHaveText('LIVE', { timeout: 20_000 })
  await expect(page.getByTestId('levels')).toContainText(/1,?[12]\d\d/)
  await page.waitForTimeout(WARMUP_MS)

  const windowStart = await page.evaluate(() => {
    return performance.now() as number
  })

  const rows = page.getByTestId('row')
  expect(await rows.count()).toBeGreaterThan(10)

  const tape = await page.getByTestId('bids-scroll').boundingBox()
  expect(tape).not.toBeNull()

  const deadline = Date.now() + MEASURE_MS
  let i = 0
  while (Date.now() < deadline) {
    const x = tape!.x + Math.random() * tape!.width
    const y = tape!.y + 8 + Math.random() * (tape!.height - 16)
    await page.mouse.click(x, y)
    await page.mouse.wheel(0, 60)
    if (i % 5 === 0) {
      await page.getByTestId('pause-btn').click()
      await page.getByTestId('pause-btn').click()
    }
    await page.waitForTimeout(120)
    i++
  }

  const windowEnd = await page.evaluate(() => performance.now())

  const perf = await page.evaluate(() => ({
    events: window.__obPerf.events,
    longTasks: window.__obPerf.longTasks,
  }))

  const inWindow = <T extends { startTime: number }>(xs: T[]): T[] =>
    xs.filter((x) => x.startTime >= windowStart && x.startTime <= windowEnd)

  const events = inWindow(perf.events)
  const longTasks = inWindow(perf.longTasks)
  const worstEvent = events.reduce((m, e) => Math.max(m, e.duration), 0)

  console.log('event entries:', events.length)
  console.log('worst interaction duration:', Math.round(worstEvent), 'ms')
  console.log('long tasks in window:', longTasks.map((t) => Math.round(t.duration)))

  expect(errors).toEqual([])
  expect(events.length, 'no interaction latency was recorded').toBeGreaterThan(0)
  expect(worstEvent, `INP budget exceeded: ${worstEvent}ms`).toBeLessThan(INP_BUDGET_MS)
  expect(
    longTasks.length,
    `main-thread tasks >= ${LONG_TASK_BUDGET_MS}ms detected: ${longTasks.map((t) => Math.round(t.duration))}`,
  ).toBe(0)
})
