import type { DepthEvent, DepthSnapshot } from '../../lib/orderbook/depth-diff'

export interface SyntheticFeedOptions {
  symbol: string
  /** events per second (Binance depth@100ms ~ 10/s; burst mode uses 100/s) */
  ratePerSec?: number
  seed?: number
}

/**
 * Deterministic pseudo-random generator (mulberry32) so tests are repeatable.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const BASE_PRICE: Record<string, number> = {
  btcusdt: 65_000,
  ethusdt: 3_400,
  solusdt: 148,
}

/**
 * Generates a realistic Binance-style diff stream: a valid `U/u/pu` sequence
 * chain, mutations clustered around the mid price, and occasional level
 * deletions (qty=0). Used by E2E / soak tests where the real exchange is
 * unreachable or non-deterministic.
 */
export class SyntheticFeed {
  private nextId = 1
  private lastFinalId = 0
  private mid: number
  private readonly rand: () => number
  private readonly levels = new Map<string, number>()

  constructor(private readonly opts: SyntheticFeedOptions) {
    this.mid = BASE_PRICE[opts.symbol.toLowerCase()] ?? 100
    this.rand = rng(opts.seed ?? 0xc0ffee)
  }

  get ratePerSec(): number {
    return this.opts.ratePerSec ?? 10
  }

  /** REST-style snapshot with levels on both sides of the mid. */
  snapshot(levelsPerSide = 600): DepthSnapshot {
    const bids: [number, number][] = []
    const asks: [number, number][] = []
    const tick = this.mid * 0.0001
    for (let i = 0; i < levelsPerSide; i++) {
      const bidPrice = round(this.mid - tick * (i + 1) - this.rand() * tick * 0.5)
      const askPrice = round(this.mid + tick * (i + 1) + this.rand() * tick * 0.5)
      const bidQty = round2(0.5 + this.rand() * 4)
      const askQty = round2(0.5 + this.rand() * 4)
      this.levels.set(`b${bidPrice}`, bidQty)
      this.levels.set(`a${askPrice}`, askQty)
      bids.push([bidPrice, bidQty])
      asks.push([askPrice, askQty])
    }
    this.nextId = 1000
    this.lastFinalId = 999
    return { lastUpdateId: 999, bids, asks }
  }

  /** Next diff event; maintains a strictly valid sequence chain. */
  nextEvent(): DepthEvent {
    const U = this.nextId
    const mutations = 20 + Math.floor(this.rand() * 40)
    const bids: [number, number][] = []
    const asks: [number, number][] = []
    const tick = this.mid * 0.0001
    for (let i = 0; i < mutations; i++) {
      const side = this.rand() < 0.5 ? 'b' : 'a'
      const offset = Math.pow(this.rand(), 1.6) * 600
      const price = round(side === 'b' ? this.mid - tick * offset : this.mid + tick * offset)
      const key = `${side}${price}`
      const existing = this.levels.get(key)
      const roll = this.rand()
      let qty: number
      if (existing === undefined) {
        qty = round2(0.1 + this.rand() * 5)
      } else if (roll < 0.15) {
        qty = 0
      } else {
        const drift = (this.rand() - 0.5) * 2
        qty = round2(Math.max(0.01, existing + drift))
      }
      if (qty > 0) this.levels.set(key, qty)
      else this.levels.delete(key)
      ;(side === 'b' ? bids : asks).push([price, qty])
    }
    const u = U + 1 + Math.floor(this.rand() * 4)
    this.nextId = u + 1
    const pu = this.lastFinalId
    this.lastFinalId = u
    return { U, u, pu, bids, asks }
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

function round2(n: number): number {
  return Math.round(n * 1000) / 1000
}
