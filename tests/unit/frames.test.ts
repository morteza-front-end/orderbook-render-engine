import { describe, expect, it } from 'vitest'
import { buildView, parseFrame, ROW_STRIDE } from '../../app/lib/orderbook/frames'

describe('parseFrame (Binance wire format)', () => {
  it('parses a REST snapshot frame', () => {
    const raw = JSON.stringify({ lastUpdateId: 42, bids: [['100.5', '1.25']], asks: [['101', '2']] })
    const frame = parseFrame(raw)
    expect(frame).not.toBeNull()
    expect(frame!.kind).toBe('snapshot')
    if (frame!.kind === 'snapshot') {
      expect(frame.snapshot.lastUpdateId).toBe(42)
      expect(frame.snapshot.bids).toEqual([[100.5, 1.25]])
      expect(frame.snapshot.asks).toEqual([[101, 2]])
    }
  })

  it('parses a WS diff frame with string levels', () => {
    const raw = JSON.stringify({ e: 'depthUpdate', U: 1, u: 5, pu: 0, b: [['99', '0']], a: [['102', '3']] })
    const frame = parseFrame(raw)
    expect(frame!.kind).toBe('diff')
    if (frame!.kind === 'diff') {
      expect(frame.event.U).toBe(1)
      expect(frame.event.u).toBe(5)
      expect(frame.event.pu).toBe(0)
      expect(frame.event.bids).toEqual([[99, 0]])
      expect(frame.event.asks).toEqual([[102, 3]])
    }
  })

  it('returns null for malformed payloads', () => {
    expect(parseFrame('not json')).toBeNull()
    expect(parseFrame('{"foo":1}')).toBeNull()
    expect(parseFrame(JSON.stringify({ U: 1, u: 2, b: 'nope', a: [] }))!.kind).toBe('diff')
  })
})

describe('buildView (worker-side view builder)', () => {
  const bids = new Map<number, number>([
    [100, 1],
    [99, 2],
    [98, 3],
  ])
  const asks = new Map<number, number>([
    [101, 1.5],
    [102, 2.5],
  ])

  it('packs flat [price, qty, total, dir] rows best-first with cumulative totals', () => {
    const v = buildView(bids, asks, new Map(), new Map(), 10)
    expect(v.bids.length / ROW_STRIDE).toBe(3)
    expect(v.asks.length / ROW_STRIDE).toBe(2)

    expect(v.bids[0]).toBe(100) // best bid first (desc)
    expect(v.bids[ROW_STRIDE]).toBe(99)
    expect(v.bids[ROW_STRIDE * 2]).toBe(98)
    expect(v.bids[ROW_STRIDE + 2]).toBe(3) // 1 + 2 cumulative
    expect(v.bids[ROW_STRIDE * 2 + 2]).toBe(6)

    expect(v.asks[0]).toBe(101) // best ask first (asc)
    expect(v.asks[ROW_STRIDE + 2]).toBeCloseTo(4) // 1.5 + 2.5
  })

  it('computes mid and spread from best levels', () => {
    const v = buildView(bids, asks, new Map(), new Map(), 10)
    expect(v.mid).toBeCloseTo(100.5)
    expect(v.spread).toBeCloseTo(1)
  })

  it('windows to the requested limit (top of book only)', () => {
    const v = buildView(bids, asks, new Map(), new Map(), 2)
    expect(v.bids.length / ROW_STRIDE).toBe(2)
    expect(v.bids[0]).toBe(100)
    expect(v.asks.length / ROW_STRIDE).toBe(2)
    expect(v.asks[0]).toBe(101)
  })

  it('flags first-appearance rows up and tracks flash direction across calls', () => {
    const prevBid = new Map<number, number>()
    const v0 = buildView(bids, asks, prevBid, new Map(), 10)
    expect(v0.bids[3]).toBe(1) // first appearance (row 0 = price 100)

    // qty at 100 jumps 1 -> 5 (delta > 5% threshold) => dir 1
    bids.set(100, 5)
    const v1 = buildView(bids, asks, prevBid, new Map(), 10)
    expect(v1.bids[3]).toBe(1)

    // sub-threshold noise (5 -> 5.01) => dir 0
    bids.set(100, 5.01)
    const v2 = buildView(bids, asks, prevBid, new Map(), 10)
    expect(v2.bids[3]).toBe(0)

    // decrease beyond threshold (5.01 -> 1) => dir -1
    bids.set(100, 1)
    const v3 = buildView(bids, asks, prevBid, new Map(), 10)
    expect(v3.bids[3]).toBe(-1)
  })

  it('returns empty arrays for an empty book without throwing', () => {
    const v = buildView(new Map(), new Map(), new Map(), new Map(), 10)
    expect(v.bids.length).toBe(0)
    expect(v.asks.length).toBe(0)
    expect(v.mid).toBe(0)
    expect(v.spread).toBe(0)
  })
})
