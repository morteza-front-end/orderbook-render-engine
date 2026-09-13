import { describe, expect, it } from 'vitest'
import { parseFrame } from '../../app/lib/orderbook/frames'
import { SyntheticFeed } from '../../app/lib/orderbook/synthetic'
import { DepthDiffEngine } from '../../app/lib/orderbook/depth-diff'

describe('SyntheticFeed (raw wire-format emitter)', () => {
  it('emits a snapshot-shaped raw frame a worker can parse', () => {
    const feed = new SyntheticFeed('btcusdt', 10)
    const frame = parseFrame(feed.snapshotRaw())
    expect(frame!.kind).toBe('snapshot')
    if (frame!.kind === 'snapshot') {
      expect(frame.snapshot.bids.length).toBe(600)
      expect(frame.snapshot.asks.length).toBe(600)
      expect(frame.snapshot.lastUpdateId).toBeGreaterThan(0)
      for (const [p, q] of frame.snapshot.bids) {
        expect(Number.isFinite(p) && p > 0).toBe(true)
        expect(q).toBeGreaterThan(0)
      }
    }
  })

  it('emits a strictly valid U/u/pu chain the engine accepts without gaps', () => {
    const feed = new SyntheticFeed('ethusdt', 100)
    const engine = new DepthDiffEngine()
    const gaps: string[] = []
    engine.onGap = (r) => gaps.push(r)

    const snapFrame = parseFrame(feed.snapshotRaw())
    if (snapFrame?.kind !== 'snapshot') throw new Error('expected snapshot frame')
    engine.sync(snapFrame.snapshot)

    for (let i = 0; i < 5000; i++) {
      const frame = parseFrame(feed.nextRaw())
      expect(frame!.kind).toBe('diff')
      if (frame!.kind === 'diff') engine.apply(frame.event)
    }
    expect(gaps).toEqual([])
    expect(engine.isSynced).toBe(true)
    expect(engine.sequence).toBeGreaterThan(1000)
  })

  it('interval shrinks with rate but never below 4ms', () => {
    expect(new SyntheticFeed('btcusdt', 10).intervalMs).toBe(100)
    expect(new SyntheticFeed('btcusdt', 100).intervalMs).toBe(10)
    expect(new SyntheticFeed('btcusdt', 1000).intervalMs).toBeGreaterThanOrEqual(4)
  })
})
