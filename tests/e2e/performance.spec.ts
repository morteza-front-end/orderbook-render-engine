import { expect, test, type Page } from '@playwright/test'

/**
 * Performance gates (blocking in CI):
 *  - INP budget: worst interaction latency stays under 200ms under load
 *  - Main-thread budget: zero tasks >= 50ms (longtask) during measurement
 *
 * Load profile: synthetic feed at 100 events/s (10x the Binance
 * depth@100ms cadence) driven through the full pipeline: worker -> ring
 * buffer -> rAF drain -> virtualized render.
 *
 * INP is approximated with the Event Timing API (`event` entries with a
 * 16ms threshold — stricter than Chrome's 40ms default) taking the worst
 * interaction duration inside the measurement window.
 */

const PERF_INIT = `
  window.__obPerf = { events: [], longTasks: [], marks: {} };
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

const WARMUP_MS = 4000
const MEASURE_MS = 8000
const INP_BUDGET_MS = 200
const LONG_TASK_BUDGET_MS = 50

async function readSeq(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="stats"]')
    const m = el?.textContent?.match(/seq\s*([\d,.]+)/)
    return m ? Number(m[1]!.replace(/[,.]/g, '')) : -1
  })
}

test('INP stays under 200ms and main-thread tasks under 50ms under data pressure', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(String(err)))

  // single-worker config + explicit focus: rAF must never be throttled
  // while we measure interaction latency
  await page.bringToFront()
  await page.addInitScript(PERF_INIT)
  await page.goto('/?feed=synthetic&rate=100')

  // ---- warmup: snapshot applied, feed bursting, renderer at full rate ----
  await expect(page.getByTestId('status')).toHaveText('LIVE', { timeout: 20_000 })
  await expect(page.getByTestId('levels')).toContainText(/1[12]\d\d/)
  await page.waitForTimeout(WARMUP_MS)

  // ---- measurement window -------------------------------------------------
  const windowStart = await page.evaluate(() => {
    window.__obPerf.marks.start = performance.now()
    return window.__obPerf.marks.start as number
  })

  const rows = page.locator('.vl-row')
  const rowCount = await rows.count()
  expect(rowCount).toBeGreaterThan(10)

  // interaction mix: raw clicks on the tape (trusted events through the real
  // row handlers), list scrolling and control toggles — continuously while
  // 100 events/s flow through the pipeline. Raw coordinate clicks avoid
  // Playwright's actionability retries, which cannot settle on rows that
  // legitimately change every frame.
  const tape = await page.getByTestId('bids-side').locator('.vl').boundingBox()
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

  // ---- verification --------------------------------------------------------
  const perf = await page.evaluate(() => ({
    events: window.__obPerf.events,
    longTasks: window.__obPerf.longTasks,
  }))

  const inWindow = <T extends { startTime: number }>(xs: T[]): T[] =>
    xs.filter((x) => x.startTime >= windowStart && x.startTime <= windowEnd)

  const events = inWindow(perf.events)
  const longTasks = inWindow(perf.longTasks)

  const interactions = new Map<string, number>()
  for (const e of events) {
    interactions.set(e.name, Math.max(interactions.get(e.name) ?? 0, e.duration))
  }
  const worstEvent = events.reduce((m, e) => Math.max(m, e.duration), 0)

  console.log('event entries:', events.length)
  console.log('worst per interaction type:', Object.fromEntries(interactions))
  console.log('long tasks in window:', longTasks.map((t) => Math.round(t.duration)))
  console.log('feed sequence still advancing:', await readSeq(page))

  expect(errors).toEqual([])
  expect(events.length, 'no interaction latency was recorded').toBeGreaterThan(0)
  expect(worstEvent, `INP budget exceeded: ${worstEvent}ms`).toBeLessThan(INP_BUDGET_MS)
  expect(
    longTasks.length,
    `main-thread tasks >= ${LONG_TASK_BUDGET_MS}ms detected: ${longTasks.map((t) => Math.round(t.duration))}`,
  ).toBe(0)
})
