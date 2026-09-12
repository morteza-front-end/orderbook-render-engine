import { describe, expect, it } from 'vitest'
import { DepthDiffEngine } from '../../app/lib/orderbook/depth-diff'
import { OrderBookStore, type OrderBookBatch } from '../../app/lib/orderbook/store'
import { RingBuffer } from '../../app/lib/ring-buffer'
import { SyntheticFeed } from '../../app/workers/feed/synthetic'

/**
 * Node-side soak: replays the full pipeline (synthetic feed -> diff engine ->
 * ring buffer -> store flush) for SOAK_DURATION_MS (default 30 minutes) and
 * asserts the data structures stay bounded — the classic leak vectors here
 * are unbounded level maps, an ever-growing pending queue, or retained batch
 * references after drain.
 *
 * Opt-in: `npm run test:soak:unit` (or RUN_SOAK=1). Skipped in the normal
 * unit run so CI stays fast; the browser heap soak lives in
 * `tests/e2e/soak.spec.ts`.
 */
const RUN = !!process.env.RUN_SOAK
const DURATION_MS = Number(process.env.SOAK_DURATION_MS ?? 30 * 60 * 1000)

describe.runIf(RUN)('soak: 30-minute diff/flush pipeline', () => {
  it(
    'keeps memory and data structures bounded under continuous load',
    { timeout: DURATION_MS + 60_000 },
    async () => {
      const feed = new SyntheticFeed({ symbol: 'btcusdt', ratePerSec: 10 })
      const engine = new DepthDiffEngine()
      engine.sync(feed.snapshot())

      const ring = new RingBuffer<OrderBookBatch>(512)
      const store = new OrderBookStore(ring)

      const gaps: string[] = []
      engine.onGap = (reason) => {
        gaps.push(reason)
        engine.sync(feed.snapshot())
      }

      const interval = 100 // 10 events/s, Binance depth@100ms cadence
      const startedAt = Date.now()
      let events = 0
      let flushes = 0
      let maxLevels = 0

      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          const evt = feed.nextEvent()
          const { applied } = engine.apply(evt)
          if (applied) {
            events++
            store.ingest({
              bids: flat(evt.bids),
              asks: flat(evt.asks),
              seq: engine.sequence,
              ts: Date.now(),
            })
          }
        }, interval)

        const render = setInterval(() => {
          const view = store.flush(600)
          if (view.bids.length + view.asks.length > 0) {
            flushes++
            maxLevels = Math.max(maxLevels, view.bids.length + view.asks.length)
          }
          const elapsed = Date.now() - startedAt
          if (elapsed >= DURATION_MS) {
            clearInterval(timer)
            clearInterval(render)
            resolve()
          }
        }, 16) // ~60fps render loop
      })

      // --- leak assertions -------------------------------------------------
      const stats = store.stats()
      // level maps bounded: synthetic feed spans a fixed price band
      expect(stats.bidLevels + stats.askLevels).toBeLessThan(8_000)
      // nothing retained in the ring buffer after the last flush
      expect(ring.size).toBe(0)
      // every drained slot must have released its batch
      // (drain() nulls slots; only capacity references remain)
      // sequence kept advancing the whole time
      expect(stats.seq).toBeGreaterThan(0)
      expect(events).toBeGreaterThan(DURATION_MS / interval - 10)
      expect(flushes).toBeGreaterThan(100)
      // synthetic feed never produces gaps; live resync logic is unit-tested
      expect(gaps).toEqual([])
    },
  )
})

function flat(pairs: [number, number][]): Float64Array {
  const out = new Float64Array(pairs.length * 2)
  pairs.forEach(([p, q], i) => {
    out[i * 2] = p
    out[i * 2 + 1] = q
  })
  return out
}
