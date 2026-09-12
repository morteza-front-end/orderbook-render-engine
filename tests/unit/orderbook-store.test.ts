import { describe, expect, it } from 'vitest'
import { OrderBookStore, type OrderBookBatch } from '../../app/lib/orderbook/store'
import { RingBuffer } from '../../app/lib/ring-buffer'

function batch(bids: [number, number][], asks: [number, number][], seq = 1, ts = 0): OrderBookBatch {
  return {
    bids: pairsToFlat(bids),
    asks: pairsToFlat(asks),
    seq,
    ts,
  }
}

function pairsToFlat(pairs: [number, number][]): Float64Array {
  const out = new Float64Array(pairs.length * 2)
  pairs.forEach(([p, q], i) => {
    out[i * 2] = p
    out[i * 2 + 1] = q
  })
  return out
}

function makeStore(cap = 16): { ring: RingBuffer<OrderBookBatch>; store: OrderBookStore } {
  const ring = new RingBuffer<OrderBookBatch>(cap)
  return { ring, store: new OrderBookStore(ring) }
}

describe('OrderBookStore', () => {
  it('aggregates multiple ingested batches into a single flushed view', () => {
    const { store } = makeStore()
    store.ingest(batch([[100, 1], [99, 2]], [[101, 3]], 1))
    store.ingest(batch([[100, 5], [98, 0]], [[101, 0], [102, 4]], 2))
    const v = store.flush(100)
    expect(v.bids.map((r) => r.price)).toEqual([100, 99]) // desc
    expect(v.asks.map((r) => r.price)).toEqual([102]) // asc, 101 deleted
    expect(v.bids[0]!.qty).toBe(5)
    expect(v.seq).toBe(2)
  })

  it('computes mid, spread and cumulative totals', () => {
    const { store } = makeStore()
    store.ingest(batch([[100, 1], [99, 2]], [[101, 1.5], [102, 2.5]]))
    const v = store.flush(100)
    expect(v.mid).toBeCloseTo(100.5)
    expect(v.spread).toBeCloseTo(1)
    expect(v.bids[0]!.total).toBe(1)
    expect(v.bids[1]!.total).toBe(3)
    expect(v.asks[1]!.total).toBeCloseTo(4)
  })

  it('returns the same empty view reference when nothing is pending (skip-render signal)', () => {
    const { store } = makeStore()
    const a = store.flush(100)
    store.ingest(batch([[100, 1]], [[101, 1]]))
    store.flush(100)
    const c = store.flush(100)
    expect(a.bids.length).toBe(0)
    expect(a).toBe(c)
  })

  it('windows to the requested limit (top-N of book)', () => {
    const { store } = makeStore()
    const bidPairs: [number, number][] = []
    const askPairs: [number, number][] = []
    for (let i = 0; i < 100; i++) {
      bidPairs.push([100 - i, 1])
      askPairs.push([101 + i, 1])
    }
    store.ingest(batch(bidPairs, askPairs))
    const v = store.flush(10)
    expect(v.bids).toHaveLength(10)
    expect(v.bids[0]!.price).toBe(100) // best bid first
    expect(v.asks[0]!.price).toBe(101) // best ask first
  })

  it('flags flash direction against the previous flushed view', () => {
    const { store } = makeStore()
    store.ingest(batch([[100, 1]], [[101, 1]]))
    const v0 = store.flush(100)
    expect(v0.bids[0]!.dir).toBe(1) // first appearance
    store.ingest(batch([[100, 3]], [])) // qty up at 100
    const v = store.flush(100)
    expect(v.bids[0]!.dir).toBe(1)
    store.ingest(batch([[100, 2]], []))
    const v2 = store.flush(100)
    expect(v2.bids[0]!.dir).toBe(-1)
    store.ingest(batch([[100, 2]], []))
    const v3 = store.flush(100)
    expect(v3.bids[0]!.dir).toBe(0)
  })

  it('suppresses flashes for sub-threshold qty noise', () => {
    const { store } = makeStore()
    store.ingest(batch([[100, 10]], []))
    store.flush(100)
    store.ingest(batch([[100, 10.1]], [])) // +1% < 5% threshold
    const v = store.flush(100)
    expect(v.bids[0]!.dir).toBe(0)
  })

  it('handles ring-buffer overflow (newest wins) without corrupting the book', () => {
    const { store } = makeStore(4)
    for (let i = 0; i < 10; i++) {
      store.ingest(batch([[100, i + 1]], [[101, i + 1]], i + 1))
    }
    const v = store.flush(100)
    // all 10 batches coalesce; the last write for each level wins
    expect(v.bids[0]!.qty).toBe(10)
    expect(v.seq).toBe(10)
  })

  it('bounds level growth: far levels are pruned under sustained load', () => {
    const { store } = makeStore()
    // simulate 5000 batches touching 20 random far prices each
    let seed = 7
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (let b = 0; b < 5000; b++) {
      const bids: [number, number][] = []
      const asks: [number, number][] = []
      for (let i = 0; i < 20; i++) {
        bids.push([100 - rand() * 5000, 1])
        asks.push([101 + rand() * 5000, 1])
      }
      store.ingest(batch(bids, asks, b))
      store.flush(600)
    }
    const stats = store.stats()
    // without pruning the maps would hold ~100k levels; with hysteresis the
    // size oscillates between keep (2*limit) and trigger (3*limit)
    expect(stats.bidLevels).toBeLessThanOrEqual(1800)
    expect(stats.askLevels).toBeLessThanOrEqual(1800)
    expect(store.pending).toBe(0)
  })

  it('reset clears levels and pending batches', () => {
    const { ring, store } = makeStore()
    store.ingest(batch([[100, 1]], [[101, 1]]))
    store.reset()
    expect(store.pending).toBe(0)
    const v = store.flush(100)
    expect(v.bids.length + v.asks.length).toBe(0)
    expect(ring.size).toBe(0)
  })
})
