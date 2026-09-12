import type { RingBuffer } from '../ring-buffer'

/**
 * A single batched update transferred from the worker.
 * Typed arrays are laid out as flat [price0, qty0, price1, qty1, ...] pairs
 * so they can be moved with zero-copy transfer between worker and main thread.
 */
export interface OrderBookBatch {
  bids: Float64Array
  asks: Float64Array
  /** worker-side diff sequence id (lastUpdateId) */
  seq: number
  /** monotonic worker timestamp (ms) of the last event in this batch */
  ts: number
}

export interface DepthRow {
  price: number
  qty: number
  /** cumulative qty from the top of the book */
  total: number
  /** 0 = unchanged, 1 = qty increased, -1 = qty decreased/new */
  dir: 0 | 1 | -1
}

export interface OrderBookView {
  bids: DepthRow[]
  asks: DepthRow[]
  mid: number
  spread: number
  seq: number
  ts: number
}

export interface OrderBookStats {
  bidLevels: number
  askLevels: number
  seq: number
}

const EMPTY_VIEW: OrderBookView = {
  bids: [],
  asks: [],
  mid: 0,
  spread: 0,
  seq: 0,
  ts: 0,
}

/** relative qty change required to trigger a row flash animation */
const FLASH_THRESHOLD = 0.05

/**
 * Render-side pruning: the store only ever displays `flush(limit)` rows, so
 * levels beyond ~2x that window are dead weight that would otherwise make
 * the per-frame sort cost grow for the entire session (slow leak under a
 * 30-minute soak).
 */
function pruneSide(levels: Map<number, number>, keep: number, trigger: number, best: 'asc' | 'desc'): void {
  if (levels.size <= trigger) return
  const prices = Array.from(levels.keys()).sort((a, b) => (best === 'asc' ? a - b : b - a))
  for (let i = keep; i < prices.length; i++) {
    levels.delete(prices[i]!)
  }
}

/**
 * Pure, framework-free order book state for the main thread.
 *
 * - High-frequency batches from the worker land in a {@link RingBuffer}
 *   (aggregation / back-pressure boundary) instead of touching any reactive
 *   system.
 * - `flush()` is called exactly once per animation frame by the render loop;
 *   it drains the ring buffer, coalesces every pending tick into the level
 *   maps and produces sorted, windowed snapshots for the virtualized lists.
 * - No Vue/Pinia imports by design: render engine reads imperatively.
 */
export class OrderBookStore {
  private readonly bids = new Map<number, number>()
  private readonly asks = new Map<number, number>()
  private readonly prevBidQty = new Map<number, number>()
  private readonly prevAskQty = new Map<number, number>()
  /** reused row objects: 100Hz x 60fps without pooling means ~72k
   * allocations/s and GC pressure that shows up as 50ms+ main-thread tasks */
  private readonly bidRows: DepthRow[] = []
  private readonly askRows: DepthRow[] = []
  private seq = 0
  private ts = 0

  constructor(private readonly buffer: RingBuffer<OrderBookBatch>) {}

  get pending(): number {
    return this.buffer.size
  }

  get droppedBatches(): number {
    return this.buffer.dropped
  }

  /** Non-destructive stats for UI badges (cheap, no sorting). */
  stats(): OrderBookStats {
    return { bidLevels: this.bids.size, askLevels: this.asks.size, seq: this.seq }
  }

  /** Push a worker batch into the aggregation buffer. Never blocks. */
  ingest(batch: OrderBookBatch): void {
    this.buffer.push(batch)
  }

  /**
   * Drain the ring buffer, coalesce all batches, and emit a sorted view.
   * Returns the shared EMPTY view (by reference) when nothing changed so the
   * render loop can skip the shallowRef write entirely.
   */
  flush(limit: number): OrderBookView {
    let applied = 0
    let lastSeq = this.seq
    let lastTs = this.ts
    this.buffer.drain((batch) => {
      this.applyFlat(this.bids, batch.bids)
      this.applyFlat(this.asks, batch.asks)
      lastSeq = batch.seq
      lastTs = batch.ts
      applied++
    })
    if (applied === 0) return EMPTY_VIEW

    this.seq = lastSeq
    this.ts = lastTs
    // bound the mirrors: keep 2x the visible window, trigger at 3x
    pruneSide(this.bids, limit * 2, limit * 3, 'desc')
    pruneSide(this.asks, limit * 2, limit * 3, 'asc')
    const mid = this.computeMid()
    const spread = mid > 0 ? this.bestAsk() - this.bestBid() : 0
    return {
      bids: this.snapshotSide(this.bids, this.prevBidQty, this.bidRows, limit, 'desc'),
      asks: this.snapshotSide(this.asks, this.prevAskQty, this.askRows, limit, 'asc'),
      mid,
      spread,
      seq: lastSeq,
      ts: lastTs,
    }
  }

  reset(): void {
    this.bids.clear()
    this.asks.clear()
    this.prevBidQty.clear()
    this.prevAskQty.clear()
    this.bidRows.length = 0
    this.askRows.length = 0
    this.seq = 0
    this.ts = 0
    this.buffer.clear()
  }

  private applyFlat(map: Map<number, number>, flat: Float64Array): void {
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const price = flat[i]!
      const qty = flat[i + 1]!
      if (qty > 0) map.set(price, qty)
      else map.delete(price)
    }
  }

  private bestBid(): number {
    let best = 0
    for (const p of this.bids.keys()) {
      if (p > best) best = p
    }
    return best
  }

  private bestAsk(): number {
    let best = Number.POSITIVE_INFINITY
    for (const p of this.asks.keys()) {
      if (p < best) best = p
    }
    return best === Number.POSITIVE_INFINITY ? 0 : best
  }

  private computeMid(): number {
    const bid = this.bestBid()
    const ask = this.bestAsk()
    if (bid <= 0 || ask <= 0 || ask < bid) return 0
    return (bid + ask) / 2
  }

  /**
   * Builds the sorted, windowed snapshot for one side.
   * `pool` holds the row objects returned last frame — they are mutated in
   * place so a steady-state render loop performs zero row allocations.
   */
  private snapshotSide(
    levels: Map<number, number>,
    prevQty: Map<number, number>,
    pool: DepthRow[],
    limit: number,
    order: 'asc' | 'desc',
  ): DepthRow[] {
    const prices = Array.from(levels.keys())
    prices.sort((a, b) => (order === 'asc' ? a - b : b - a))
    const n = Math.min(limit, prices.length)
    let total = 0
    for (let i = 0; i < n; i++) {
      const price = prices[i]!
      const qty = levels.get(price)!
      total += qty
      const before = prevQty.get(price)
      let dir: 0 | 1 | -1 = 0
      if (before === undefined) {
        dir = 1 // new level in view
      } else {
        // only flash on meaningful moves: restarting 40 CSS animations per
        // frame is itself a long-task vector under burst load
        const delta = Math.abs(qty - before)
        if (delta > before * FLASH_THRESHOLD) dir = qty > before ? 1 : -1
      }
      const row = pool[i]
      if (row) {
        row.price = price
        row.qty = qty
        row.total = total
        row.dir = dir
      } else {
        pool[i] = { price, qty, total, dir }
      }
    }
    pool.length = n
    // Only the visible window participates in flash tracking; drop the rest
    // so the map cannot grow unbounded across a 30-minute soak.
    prevQty.clear()
    for (let i = 0; i < n; i++) {
      prevQty.set(prices[i]!, pool[i]!.qty)
    }
    return pool
  }
}
