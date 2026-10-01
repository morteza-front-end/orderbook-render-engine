import { expect, test, type Page } from '@playwright/test'

/**
 * Functional gates against the synthetic feed (deterministic, offline) —
 * the same assertions the Nuxt client must pass, proving the framework-
 * agnostic core drives both renderers identically.
 */

async function waitForLive(page: Page, timeout = 20_000): Promise<void> {
  await expect(page.getByTestId('status')).toHaveText('LIVE', { timeout })
  await expect(page.getByTestId('levels')).toContainText(/1,?[12]\d\d/, { timeout })
}

test('boots the worker pipeline and reaches LIVE with 500+ levels', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(String(err)))
  await page.goto('/?feed=synthetic')
  await waitForLive(page)

  await expect(page.getByTestId('mid')).not.toContainText('—')
  await expect(page.getByTestId('imbalance')).toBeVisible()
  expect(errors).toEqual([])
})

test('virtualization keeps the DOM bounded while the book holds 500+ rows', async ({ page }) => {
  await page.goto('/?feed=synthetic')
  await waitForLive(page)

  const domRows = await page.getByTestId('row').count()
  const levels = Number((await page.getByTestId('levels').innerText()).replace(/\D/g, ''))
  expect(levels).toBeGreaterThanOrEqual(500)
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

  const bids = page.getByTestId('bids-scroll').getByTestId('price').first()
  await expect(bids).toBeVisible()

  await page.getByTestId('pause-btn').click()
  await expect(page.getByTestId('pause-btn')).toHaveText('Resume')
  await page.waitForTimeout(300)

  const frozen = await bids.innerText()
  await page.waitForTimeout(1500)
  expect(await bids.innerText()).toBe(frozen)

  await page.getByTestId('pause-btn').click()
  await expect(page.getByTestId('pause-btn')).toHaveText('Pause')
  await expect
    .poll(async () => bids.innerText(), { timeout: 5000 })
    .not.toBe(frozen)
})

test('clicking a row selects it (interaction wiring through plain UI state)', async ({ page }) => {
  await page.goto('/?feed=synthetic')
  await waitForLive(page)

  await page.getByTestId('pause-btn').click()
  await expect(page.getByTestId('pause-btn')).toHaveText('Resume')

  const row = page.getByTestId('bids-scroll').getByTestId('row').nth(10)
  await row.click()
  await expect(row).toHaveClass(/ring-amber-400/)
})

test('switching to another symbol resets and rebuilds the book', async ({ page }) => {
  await page.goto('/?feed=synthetic')
  await waitForLive(page)

  await page.getByLabel('Symbol').selectOption('ethusdt')
  await expect(page.getByTestId('status')).toHaveText('LIVE', { timeout: 15_000 })
  await expect(page.getByTestId('levels')).toContainText(/1,?[12]\d\d/, { timeout: 15_000 })
})

test('useSyncExternalStore contract holds at 1000Hz (cached snapshot, no warnings, no errors)', async ({
  page,
}) => {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  await page.goto('/?feed=synthetic&rate=1000')
  await waitForLive(page)
  await page.waitForTimeout(4000)

  // getSnapshot() must return the same reference until content changed —
  // React logs "The result of getSnapshot should be cached..." otherwise
  const uncachedSnapshotWarnings = consoleErrors.filter((t) =>
    /getSnapshot|infinite loop/i.test(t),
  )
  expect(uncachedSnapshotWarnings).toEqual([])
  expect(pageErrors).toEqual([])
})
