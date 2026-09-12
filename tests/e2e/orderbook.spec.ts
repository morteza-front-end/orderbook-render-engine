import { expect, test, type Page } from '@playwright/test'

/**
 * Functional gates against the synthetic feed (deterministic, offline).
 * Live Binance is exercised manually via the Feed selector.
 */

async function waitForLive(page: Page, timeout = 20_000): Promise<void> {
  await expect(page.getByTestId('status')).toHaveText('LIVE', { timeout })
  await expect(page.getByTestId('levels')).toContainText(/\d+/, { timeout })
}

test('boots the worker pipeline and reaches LIVE with 500+ levels', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(String(err)))
  await page.goto('/?feed=synthetic')
  await waitForLive(page)

  // snapshot has 600 levels per side -> 1200 total in view limit
  await expect(page.getByTestId('levels')).toContainText(/1[12]\d\d/, { timeout: 15_000 })
  await expect(page.getByTestId('mid')).not.toContainText('—')
  expect(errors).toEqual([])
})

test('virtualization keeps the DOM bounded while the book holds 500+ rows', async ({ page }) => {
  await page.goto('/?feed=synthetic')
  await waitForLive(page)

  const domRows = await page.locator('.vl-row').count()
  const levelsText = await page.getByTestId('levels').innerText()
  const levels = Number(levelsText.replace(/\D/g, ''))
  expect(levels).toBeGreaterThanOrEqual(500)
  // two lists * (~20 visible + 2*8 overscan) must be far below the dataset
  expect(domRows).toBeLessThan(100)
})

test('sequence advances continuously (rAF loop is draining the ring buffer)', async ({ page }) => {
  await page.goto('/?feed=synthetic')
  await waitForLive(page)

  const readSeq = async () =>
    Number(
      (await page.getByTestId('stats').innerText())
        .split('seq')[1]!
        .trim()
        .split(/\s+/)[0]!
        .replace(/\D/g, ''),
    )
  const a = await readSeq()
  await page.waitForTimeout(2500)
  const b = await readSeq()
  expect(b).toBeGreaterThan(a)
})

test('pause freezes the tape, resume continues it', async ({ page }) => {
  await page.goto('/?feed=synthetic')
  await waitForLive(page)

  // tape = the rendered view (rAF flush). While paused, the worker keeps
  // consuming the feed but the view must stop changing entirely.
  const bids = page.getByTestId('bids-side').locator('.vl-row .price')
  await expect(bids.first()).toBeVisible()

  await page.getByTestId('pause-btn').click()
  await expect(page.getByTestId('pause-btn')).toHaveText('Resume')
  await page.waitForTimeout(300) // let any in-flight frame land

  const frozen = await bids.first().innerText()
  await page.waitForTimeout(1500)
  expect(await bids.first().innerText()).toBe(frozen)

  await page.getByTestId('pause-btn').click()
  await expect(page.getByTestId('pause-btn')).toHaveText('Pause')
  // with the tape resumed the best bid changes within a couple of seconds
  await expect
    .poll(async () => bids.first().innerText(), { timeout: 5000 })
    .not.toBe(frozen)
})

test('clicking a row selects it (interaction wiring through Pinia session store)', async ({ page }) => {
  await page.goto('/?feed=synthetic')
  await waitForLive(page)

  // freeze the tape first so the clicked row cannot be replaced mid-click
  await page.getByTestId('pause-btn').click()
  await expect(page.getByTestId('pause-btn')).toHaveText('Resume')

  const row = page.getByTestId('bids-side').locator('.vl-row').nth(10)
  await row.click()
  await expect(page.locator('.obrow.selected')).toBeVisible()
  await expect(page.locator('.obrow.selected')).toHaveCount(1)
})

test('switching to another symbol resets and rebuilds the book', async ({ page }) => {
  await page.goto('/?feed=synthetic')
  await waitForLive(page)

  await page.getByLabel('Symbol').selectOption('ethusdt')
  await expect(page.getByTestId('status')).toHaveText('LIVE', { timeout: 15_000 })
  await expect(page.getByTestId('levels')).toContainText(/1[12]\d\d/, { timeout: 15_000 })
})
