import type { DepthEvent, DepthSnapshot } from './depth-diff'

/**
 * Wire-format parsing for Binance depth frames (runs inside the worker).
 *
 * Two frame shapes share one ingest channel:
 *  - REST snapshot: `{ lastUpdateId, bids: [string,string][], asks: ... }`
 *  - WS diff event: `{ e, E, s, U, u, pu, b: [string,string][], a: ... }`
 *
 * Discriminated by `lastUpdateId` (diff frames never carry it).
 */

export type ParsedFrame =
  | { kind: 'snapshot'; snapshot: DepthSnapshot }
  | { kind: 'diff'; event: DepthEvent }
  | null

export function parseFrame(raw: string): ParsedFrame {
  let msg: unknown
  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof msg !== 'object' || msg === null) return null
  const m = msg as Record<string, unknown>
  const bidLevels = m.bids
  const askLevels = m.asks

  if (typeof m.lastUpdateId === 'number' && Array.isArray(bidLevels) && Array.isArray(askLevels)) {
    return {
      kind: 'snapshot',
      snapshot: {
        lastUpdateId: m.lastUpdateId,
        bids: parseLevels(bidLevels),
        asks: parseLevels(askLevels),
      },
    }
  }
  if (typeof m.U === 'number' && typeof m.u === 'number') {
    return {
      kind: 'diff',
      event: {
        U: m.U,
        u: m.u,
        pu: typeof m.pu === 'number' ? m.pu : 0,
        bids: parseLevels(Array.isArray(m.b) ? m.b : []),
        asks: parseLevels(Array.isArray(m.a) ? m.a : []),
      },
    }
  }
  return null
}

function parseLevels(levels: unknown[]): [number, number][] {
  const out: [number, number][] = []
  for (const entry of levels) {
    if (Array.isArray(entry) && entry.length >= 2) {
      const price = Number.parseFloat(String(entry[0]))
      const qty = Number.parseFloat(String(entry[1]))
      if (Number.isFinite(price) && Number.isFinite(qty)) out.push([price, qty])
    }
  }
  return out
}

/** Flat row layout produced by the worker: [price, qty, cumulativeTotal, dir]* */
export const ROW_STRIDE = 4

export interface BookView {
  bids: Float64Array
  asks: Float64Array
  mid: number
  spread: number
}

/** relative qty change required to trigger a row flash */
const FLASH_THRESHOLD = 0.05

/**
 * Worker-side view builder: sorts each side best-first (bids descending,
 * asks ascending), computes cumulative depth totals and flash-direction
 * flags, and packs the top-`limit` window into flat Float64Arrays that are
 * transferred to the main thread with zero structural overhead.
 *
 * Runs entirely off the main thread; allocates only the two output arrays,
 * which are transferred out on every drain.
 */
export function buildView(
  bids: Map<number, number>,
  asks: Map<number, number>,
  prevBidQty: Map<number, number>,
  prevAskQty: Map<number, number>,
  limit: number,
): BookView {
  const bidPrices = [...bids.keys()].sort((a, b) => b - a)
  const askPrices = [...asks.keys()].sort((a, b) => a - b)
  const bidBuf = new Float64Array(Math.min(limit, bidPrices.length) * ROW_STRIDE)
  const askBuf = new Float64Array(Math.min(limit, askPrices.length) * ROW_STRIDE)

  packSide(bidBuf, bidPrices, bids, prevBidQty)
  packSide(askBuf, askPrices, asks, prevAskQty)

  const bestBid = bidPrices[0] ?? 0
  const bestAsk = askPrices[0] ?? 0
  const mid = bestBid > 0 && bestAsk > 0 && bestAsk >= bestBid ? (bestBid + bestAsk) / 2 : 0
  return { bids: bidBuf, asks: askBuf, mid, spread: mid > 0 ? bestAsk - bestBid : 0 }
}

function packSide(
  out: Float64Array,
  prices: number[],
  levels: Map<number, number>,
  prevQty: Map<number, number>,
): void {
  const n = out.length / ROW_STRIDE
  let total = 0
  for (let i = 0; i < n; i++) {
    const price = prices[i]!
    const qty = levels.get(price)!
    total += qty
    const before = prevQty.get(price)
    let dir = 0
    if (before === undefined) {
      dir = 1 // new level in view
    } else {
      const delta = Math.abs(qty - before)
      // flash only on meaningful moves: restarting dozens of CSS animations
      // per frame is itself a long-task vector under burst load
      if (delta > before * FLASH_THRESHOLD) dir = qty > before ? 1 : -1
    }
    const o = i * ROW_STRIDE
    out[o] = price
    out[o + 1] = qty
    out[o + 2] = total
    out[o + 3] = dir
  }
  // only the visible window participates in flash tracking; drop the rest so
  // the map cannot grow unbounded across a 30-minute soak
  prevQty.clear()
  for (let i = 0; i < n; i++) {
    prevQty.set(prices[i]!, levels.get(prices[i]!)!)
  }
}
