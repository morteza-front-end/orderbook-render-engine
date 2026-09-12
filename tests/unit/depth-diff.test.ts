import { describe, expect, it, vi } from 'vitest'
import { DepthDiffEngine, type DepthEvent, type DepthSnapshot } from '../../app/lib/orderbook/depth-diff'

function snapshot(lastUpdateId: number, bids: [number, number][], asks: [number, number][]): DepthSnapshot {
  return { lastUpdateId, bids, asks }
}

function evt(U: number, u: number, pu: number, bids: [number, number][] = [], asks: [number, number][] = []): DepthEvent {
  return { U, u, pu, bids, asks }
}

describe('DepthDiffEngine (Binance diff protocol)', () => {
  it('buffers events until a snapshot synchronizes the book', () => {
    const e = new DepthDiffEngine()
    e.apply(evt(998, 1001, 997))
    expect(e.isSynced).toBe(false)
    expect(e.pendingCount).toBe(1)

    e.sync(snapshot(1000, [[100, 5]], [[101, 5]]))
    expect(e.isSynced).toBe(true)
    expect(e.bids.get(100)).toBe(5)
    // the buffered event straddles lastUpdateId (U<=1001<=u) and is applied
    expect(e.sequence).toBe(1001)
  })

  it('drops events where u <= lastUpdateId', () => {
    const e = new DepthDiffEngine()
    e.sync(snapshot(1000, [[100, 1]], [[101, 1]]))
    const r = e.apply(evt(900, 1000, 999, [[99, 1]]))
    expect(r).toEqual({ applied: false, gap: false })
    expect(e.bids.has(99)).toBe(false)
  })

  it('applies levels and deletes on qty=0', () => {
    const e = new DepthDiffEngine()
    e.sync(snapshot(1000, [[100, 1]], [[101, 1]]))
    e.apply(evt(1001, 1005, 1000, [[100, 2], [100.5, 3], [99, 0]], []))
    expect(e.bids.get(100)).toBe(2)
    expect(e.bids.get(100.5)).toBe(3)
    expect(e.bids.has(99)).toBe(false)
  })

  it('detects a sequence gap (pu mismatch), resets and reports it', () => {
    const onGap = vi.fn()
    const e = new DepthDiffEngine()
    e.onGap = onGap
    e.sync(snapshot(1000, [[100, 1]], [[101, 1]]))
    e.apply(evt(1001, 1005, 1000))
    const r = e.apply(evt(1100, 1110, 999)) // pu must equal previous u (1005)
    expect(r.gap).toBe(true)
    expect(onGap).toHaveBeenCalledWith('sequence-gap')
    expect(e.isSynced).toBe(false)
    expect(e.bids.size + e.asks.size).toBe(0)
  })

  it('maintains a valid chain when pu matches previous u', () => {
    const e = new DepthDiffEngine()
    e.sync(snapshot(1000, [[100, 1]], [[101, 1]]))
    expect(e.apply(evt(1001, 1005, 1000)).applied).toBe(true)
    expect(e.apply(evt(1006, 1010, 1005)).applied).toBe(true)
    expect(e.sequence).toBe(1010)
  })

  it('first post-snapshot event must bridge lastUpdateId+1', () => {
    const onGap = vi.fn()
    const e = new DepthDiffEngine()
    e.onGap = onGap
    e.sync(snapshot(2000, [[100, 1]], [[101, 1]]))
    // U=2100 does not cover 2001 -> stale stream, must gap
    const r = e.apply(evt(2100, 2110, 2099))
    expect(r.gap).toBe(true)
    expect(onGap).toHaveBeenCalledOnce()
  })

  it('prunes far levels with hysteresis so the book stays bounded', () => {
    const e = new DepthDiffEngine()
    e.sync(snapshot(1000, [[100, 1]], [[101, 1]]))
    const bids: [number, number][] = []
    for (let i = 0; i < 13_000; i++) bids.push([100 - i * 0.01, 1])
    const r = e.apply(evt(1001, 1002, 1000, bids, []))
    expect(r.applied).toBe(true)
    expect(e.bids.size).toBeLessThanOrEqual(12_000)
    expect(e.bids.size).toBeGreaterThanOrEqual(8_000)
    // best levels always survive pruning
    expect(e.bids.has(100)).toBe(true)
  })

  it('reset clears everything', () => {
    const e = new DepthDiffEngine()
    e.sync(snapshot(1000, [[100, 1]], [[101, 1]]))
    e.apply(evt(1001, 1005, 1000, [[100, 2]]))
    e.reset()
    expect(e.isSynced).toBe(false)
    expect(e.sequence).toBe(0)
    expect(e.pendingCount).toBe(0)
  })
})
