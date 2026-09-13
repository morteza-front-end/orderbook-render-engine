import { describe, expect, it } from 'vitest'
import { DepthDiffEngine } from '../../app/lib/orderbook/depth-diff'
import { buildView, parseFrame, ROW_STRIDE } from '../../app/lib/orderbook/frames'
import { SyntheticFeed } from '../../app/lib/orderbook/synthetic'

/**
 * Node-side soak: replays the full pipeline exactly as it runs in the
 * browser (raw frames -> parse -> diff engine -> view build) for
 * SOAK_DURATION_MS (default 30 minutes) and asserts the data structures
 * stay bounded — the classic leak vectors are unbounded level maps, a
 * growing pending queue, or unbounded flash-tracking maps.
 *
 * Opt-in: `npm run test:soak:unit` (RUN_SOAK=1). Skipped in the normal
 * unit run so CI stays fast; the browser heap soak lives in
 * `tests/e2e/soak.spec.ts`.
 */
const RUN = !!process.env.RUN_SOAK
const DURATION_MS = Number(process.env.SOAK_DURATION_MS ?? 30 * 60 * 1000)

describe.runIf(RUN)('soak: raw pipeline diff/view loop', () => {
  it(
    'keeps the engine bounded under continuous raw load',
    { timeout: DURATION_MS + 60_000 },
    async () => {
      const feed = new SyntheticFeed('btcusdt', 10)
      const engine = new DepthDiffEngine()
      const gaps: string[] = []
      engine.onGap = (reason) => {
        gaps.push(reason)
        const snap = parseFrame(feed.snapshotRaw())
        if (snap?.kind === 'snapshot') engine.sync(snap.snapshot)
      }

      // initial snapshot exactly as the component pushes it (ring head)
      const initialSnap = parseFrame(feed.snapshotRaw())
      if (initialSnap?.kind === 'snapshot') engine.sync(initialSnap.snapshot)

      const prevBid = new Map<number, number>()
      const prevAsk = new Map<number, number>()

      const startedAt = Date.now()
      let events = 0
      let views = 0
      let maxRows = 0

      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          const frame = parseFrame(feed.nextRaw())
          if (frame?.kind === 'diff') {
            const { applied } = engine.apply(frame.event)
            if (applied) events++
          }
        }, 100)

        const render = setInterval(() => {
          const view = buildView(engine.bids, engine.asks, prevBid, prevAsk, 600)
          const rows = (view.bids.length + view.asks.length) / ROW_STRIDE
          if (rows > 0) {
            views++
            maxRows = Math.max(maxRows, rows)
          }
          if (Date.now() - startedAt >= DURATION_MS) {
            clearInterval(timer)
            clearInterval(render)
            resolve()
          }
        }, 16) // ~60fps render cadence
      })

      // --- leak assertions ---------------------------------------------------
      // level maps bounded: engine hysteresis prunes at 12k/side
      expect(engine.bids.size + engine.asks.size).toBeLessThan(24_000)
      // flash-tracking maps only ever hold the visible window (<= 600/side)
      expect(prevBid.size).toBeLessThanOrEqual(600)
      expect(prevAsk.size).toBeLessThanOrEqual(600)
      expect(engine.pendingCount).toBe(0)
      // sequence kept advancing the whole time
      expect(engine.sequence).toBeGreaterThan(0)
      // tolerate setInterval drift (~5% late ticks is normal over minutes)
      expect(events).toBeGreaterThan((DURATION_MS / 100) * 0.85)
      expect(views).toBeGreaterThan(Math.max(10, (DURATION_MS / 1000) * 2))
      // the synthetic feed never breaks its own chain
      expect(gaps).toEqual([])
    },
  )
})
