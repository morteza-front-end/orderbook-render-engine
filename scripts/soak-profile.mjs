import { chromium } from '@playwright/test'

const base = process.env.BASE ?? 'http://127.0.0.1:3000'
const durationMs = Number(process.env.DURATION ?? 90_000)

const browser = await chromium.launch({
  args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'],
})
const page = await browser.newPage()
await page.bringToFront()
page.on('pageerror', (e) => console.log('[pageerror]', String(e)))

await page.goto(`${base}/?feed=synthetic&rate=100`)
await page.waitForTimeout(5000)

// sustained-load long-task census over DURATION, bucketed per 15s so a slow
// leak (cost growing over time) is visible, plus occasional interactions
const result = await page.evaluate(async (durationMs) => {
  const buckets = []
  let current = []
  const started = performance.now()
  let lastBucket = started
  const obs = new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      if (e.startTime < started) continue
      current.push(Math.round(e.duration))
      if (e.startTime - lastBucket > 15_000) {
        buckets.push(current)
        current = []
        lastBucket = e.startTime
      }
    }
  })
  obs.observe({ type: 'longtask' })

  const tape = document.querySelector('[data-testid="bids-side"] .vl')
  const box = tape?.getBoundingClientRect()
  const end = Date.now() + durationMs
  let clicks = 0
  while (Date.now() < end) {
    if (box) {
      const x = box.x + Math.random() * box.width
      const y = box.y + 8 + Math.random() * (box.height - 16)
      const ev = new MouseEvent('click', { bubbles: true, clientX: x, clientY: y })
      document.elementFromPoint(x, y)?.dispatchEvent(ev)
      clicks++
    }
    await new Promise((r) => setTimeout(r, 120))
  }
  obs.disconnect()
  buckets.push(current)
  return {
    buckets: buckets.map((b) => ({ count: b.length, worst: b.length ? Math.max(...b) : 0 })),
    clicks,
    heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1,
  }
}, durationMs)

console.log(JSON.stringify(result, null, 2))
await browser.close()
