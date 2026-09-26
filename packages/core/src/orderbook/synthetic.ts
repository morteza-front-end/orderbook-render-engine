/**
 * Deterministic Binance-wire-compatible feed for CI/E2E/soak runs where the
 * real exchange is unreachable or non-deterministic. Emits RAW JSON strings
 * so the entire pipeline — including parsing — is exercised identically to
 * the live feed; the only difference is the transport.
 */

const BASE_PRICE: Record<string, number> = {
  btcusdt: 65_000,
  ethusdt: 3_400,
  solusdt: 148,
}

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

function price(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2)
}

function qty(n: number): string {
  return (Math.round(n * 1000) / 1000).toFixed(3)
}

export class SyntheticFeed {
  private nextId = 1
  private lastFinalId = 0
  private readonly mid: number
  private readonly rand: () => number
  private readonly levels = new Map<string, number>()

  constructor(
    private readonly symbol: string,
    private readonly ratePerSec: number,
    seed = 0x5eed,
  ) {
    this.mid = BASE_PRICE[symbol.toLowerCase()] ?? 100
    this.rand = rng(seed)
  }

  /** REST-snapshot-shaped raw frame (600 levels per side). */
  snapshotRaw(): string {
    const bids: [string, string][] = []
    const asks: [string, string][] = []
    const tick = this.mid * 0.0001
    for (let i = 0; i < 600; i++) {
      const bp = price(this.mid - tick * (i + 1) - this.rand() * tick * 0.5)
      const ap = price(this.mid + tick * (i + 1) + this.rand() * tick * 0.5)
      const bq = qty(0.5 + this.rand() * 4)
      const aq = qty(0.5 + this.rand() * 4)
      this.levels.set(`b${bp}`, Number(bq))
      this.levels.set(`a${ap}`, Number(aq))
      bids.push([bp, bq])
      asks.push([ap, aq])
    }
    this.nextId = 1000
    this.lastFinalId = 999
    return JSON.stringify({ lastUpdateId: 999, bids, asks })
  }

  /** Next diff-event-shaped raw frame; maintains a strictly valid U/u/pu chain. */
  nextRaw(): string {
    const U = this.nextId
    const mutations = 20 + Math.floor(this.rand() * 40)
    const bids: [string, string][] = []
    const asks: [string, string][] = []
    const tick = this.mid * 0.0001
    for (let i = 0; i < mutations; i++) {
      const side = this.rand() < 0.5 ? 'b' : 'a'
      const offset = Math.pow(this.rand(), 1.6) * 600
      const p = price(side === 'b' ? this.mid - tick * offset : this.mid + tick * offset)
      const key = `${side}${p}`
      const existing = this.levels.get(key)
      const roll = this.rand()
      let q: number
      if (existing === undefined) {
        q = 0.1 + this.rand() * 5
      } else if (roll < 0.15) {
        q = 0
      } else {
        q = Math.max(0.01, existing + (this.rand() - 0.5) * 2)
      }
      if (q > 0) this.levels.set(key, q)
      else this.levels.delete(key)
      ;(side === 'b' ? bids : asks).push([p, qty(q)])
    }
    const u = U + 1 + Math.floor(this.rand() * 4)
    this.nextId = u + 1
    const pu = this.lastFinalId
    this.lastFinalId = u
    return JSON.stringify({
      e: 'depthUpdate',
      E: Date.now(),
      s: this.symbol.toUpperCase(),
      U,
      u,
      pu,
      b: bids,
      a: asks,
    })
  }

  get intervalMs(): number {
    return Math.max(4, Math.floor(1000 / this.ratePerSec))
  }
}
