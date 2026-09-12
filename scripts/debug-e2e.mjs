import { chromium } from '@playwright/test'

const base = process.env.BASE ?? 'http://127.0.0.1:4173'

const browser = await chromium.launch()
const page = await browser.newPage()
page.on('console', (m) => console.log(`[console:${m.type()}]`, m.text()))
page.on('pageerror', (e) => console.log('[pageerror]', e.stack ?? String(e)))
page.on('requestfailed', (r) => console.log('[requestfailed]', r.url(), r.failure()?.errorText))
page.on('worker', (w) => {
  console.log('[worker] created:', w.url())
  w.on('close', () => console.log('[worker] closed:', w.url()))
})
await page.goto(`${base}/?feed=synthetic&rate=100`)
await page.waitForTimeout(8000)
const status = await page.getByTestId('status').innerText().catch(() => 'n/a')
const levels = await page.getByTestId('levels').innerText().catch(() => 'n/a')
console.log('status =', status, '| levels =', levels)
await browser.close()
