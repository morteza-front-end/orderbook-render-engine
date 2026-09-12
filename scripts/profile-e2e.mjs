import { chromium } from '@playwright/test'

const base = process.env.BASE ?? 'http://127.0.0.1:3000'

const browser = await chromium.launch({
  args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'],
})
const page = await browser.newPage()
await page.bringToFront()
page.on('pageerror', (e) => console.log('[pageerror]', String(e)))

await page.goto(`${base}/?feed=synthetic&rate=100`)
await page.waitForTimeout(5000)

async function countLongTasks(ms, label) {
  const n = await page.evaluate(async (ms) => {
    const tasks = []
    const obs = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) tasks.push(Math.round(e.duration))
    })
    obs.observe({ type: 'longtask' })
    await new Promise((r) => setTimeout(r, ms))
    obs.disconnect()
    return tasks
  }, ms)
  console.log(
    `${label}: ${n.length} longtasks` + (n.length ? `, worst=${Math.max(...n)}, all=[${n.join(',')}]` : ''),
  )
  return n
}

// baseline under pure feed load (no interactions)
await countLongTasks(6000, 'baseline(rate=100)')

// 1. disable flash animations
await page.addStyleTag({ content: '.obrow-flash{animation:none!important}' })
await countLongTasks(6000, 'no-flash-anim')
await page.addStyleTag({ content: '.obrow-flash{display:none!important}' })

// 2. disable depth bars (layout writes)
await page.addStyleTag({ content: '.obrow-depth{display:none!important}' })
await countLongTasks(6000, 'no-depth-bar')

// 3. hide asks list entirely
await page.evaluate(() => {
  document.querySelector('[data-testid="asks-side"]')?.setAttribute('style', 'display:none')
})
await countLongTasks(6000, 'asks-hidden')

// 4. hide bids list too (rAF loop still drains + sorts, nothing renders)
await page.evaluate(() => {
  document.querySelector('[data-testid="bids-side"]')?.setAttribute('style', 'display:none')
})
await countLongTasks(6000, 'both-lists-hidden')

await browser.close()
