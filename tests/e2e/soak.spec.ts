import { expect, test } from '@playwright/test'

/**
 * Memory soak (nightly, 30 minutes by default):
 *  - keeps the synthetic feed at 100 events/s open for SOAK_DURATION_MS
 *  - samples the JS heap via CDP every SAMPLE_MS
 *  - fails if the heap grows monotonically (leak) or exceeds the budget
 *
 * Run locally:  npm run test:soak
 * Short probe:  SOAK_DURATION_MS=60000 npm run test:soak
 */

const DURATION_MS = Number(process.env.SOAK_DURATION_MS ?? 30 * 60 * 1000)
const SAMPLE_MS = Number(process.env.SOAK_SAMPLE_MS ?? 15_000)
const MAX_HEAP_MB = Number(process.env.SOAK_MAX_HEAP_MB ?? 350)
/** allowed steady-state growth between first and last third of the run */
const MAX_GROWTH_RATIO = 1.5

test.setTimeout(DURATION_MS + 120_000)

test(`soak: ${Math.round(DURATION_MS / 60000)}min open feed shows no memory leak`, async ({ page }) => {
  test.skip(!process.env.CI && DURATION_MS < 60_000, 'use SOAK_DURATION_MS >= 60000 for local runs')

  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(String(err)))

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('HeapProfiler.enable')

  await page.goto('/?feed=synthetic&rate=100')
  await expect(page.getByTestId('status')).toHaveText('LIVE', { timeout: 20_000 })
  await expect(page.getByTestId('levels')).toContainText(/1,?[12]\d\d/)

  interface Sample {
    t: number
    heapMb: number
    nodes: number
    listeners: number
    seq: number
  }
  const samples: Sample[] = []

  const started = Date.now()
  while (Date.now() - started < DURATION_MS) {
    await page.waitForTimeout(SAMPLE_MS)
    const s = await page.evaluate(() => {
      const nodes = document.getElementsByTagName('*').length
      const perf = performance as Performance & { memory?: { usedJSHeapSize: number } }
      const el = document.querySelector<HTMLElement>('[data-testid="stats"]')
      const m = el?.textContent?.match(/seq\s+([\d,]+)/)
      return {
        heapMb: perf.memory ? perf.memory.usedJSHeapSize / 1048576 : 0,
        nodes,
        listeners: (window as unknown as { __listenerCount?: number }).__listenerCount ?? -1,
        seq: m ? Number(m[1].replace(/,/g, '')) : -1,
      }
    })
    const sample: Sample = { t: Date.now() - started, ...s }
    samples.push(sample)
    console.log(
      `t+${Math.round(sample.t / 1000)}s heap=${sample.heapMb.toFixed(1)}MB nodes=${sample.nodes} seq=${sample.seq}`,
    )
  }

  // ---- leak assertions ------------------------------------------------------
  expect(errors).toEqual([])
  expect(samples.length).toBeGreaterThanOrEqual(3)

  // the feed must have been live the whole run
  const lastSeq = samples.at(-1)!.seq
  expect(lastSeq).toBeGreaterThan(samples[0]!.seq)

  // heap: compare medians of the first and last thirds to ignore GC noise
  const third = Math.max(1, Math.floor(samples.length / 3))
  const first = median(samples.slice(0, third).map((s) => s.heapMb))
  const last = median(samples.slice(-third).map((s) => s.heapMb))
  const maxHeap = Math.max(...samples.map((s) => s.heapMb))

  console.log(`heap first-third=${first.toFixed(1)}MB last-third=${last.toFixed(1)}MB max=${maxHeap.toFixed(1)}MB`)

  expect(maxHeap, `heap exceeded ${MAX_HEAP_MB}MB budget`).toBeLessThan(MAX_HEAP_MB)
  expect(
    last / Math.max(1, first),
    `heap grew monotonically: ${first.toFixed(1)}MB -> ${last.toFixed(1)}MB`,
  ).toBeLessThan(MAX_GROWTH_RATIO)

  // DOM must stay virtualized and bounded the entire run
  const maxNodes = Math.max(...samples.map((s) => s.nodes))
  expect(maxNodes, 'DOM node count grew unbounded').toBeLessThan(1200)

  // emit the timeline next to the HTML report for the architecture README
  const report = { durationMs: DURATION_MS, samples, first, last, maxHeap, maxNodes }
  await test.info().attach('soak-timeline.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  })
})

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}
