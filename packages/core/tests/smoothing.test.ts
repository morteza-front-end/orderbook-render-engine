import { describe, expect, it } from 'vitest'
import type { PooledRow } from '../src/types'
import { advanceSide, approach, smoothAlpha } from '../src/orderbook/smoothing'

/** flat [p, q, t, d] rows → Float64Array (targets) */
function flat(rows: [number, number, number, number][]): Float64Array {
  return Float64Array.from(rows.flat())
}

describe('smoothAlpha', () => {
  it('collapses to passthrough when smoothing is off or time stands still', () => {
    expect(smoothAlpha(16, 0)).toBe(1)
    expect(smoothAlpha(0, 150)).toBe(1)
  })

  it('is frame-rate independent: two half-steps equal one full step', () => {
    const one = smoothAlpha(32, 150)
    const half = smoothAlpha(16, 150)
    expect(1 - (1 - half) ** 2).toBeCloseTo(one, 10)
  })

  it('clamps long gaps so a tab switch cannot teleport values', () => {
    expect(smoothAlpha(10_000, 150)).toBe(smoothAlpha(100, 150))
  })
})

describe('approach', () => {
  it('moves a fraction of the remaining distance toward the target', () => {
    expect(approach(0, 100, 0.5)).toBe(50)
    expect(approach(50, 100, 0.5)).toBe(75)
  })

  it('snaps once the remaining distance is below display precision', () => {
    const almost = approach(99.996, 100, 0.5)
    expect(almost).toBe(100)
  })
})

describe('advanceSide', () => {
  it('glides rows partially toward targets and keeps gliding until settled', () => {
    const prev: PooledRow[] = [
      { p: 100, q: 1, t: 1, d: 0 },
      { p: 99, q: 2, t: 3, d: 0 },
    ]
    const out: PooledRow[] = []
    // bids arrive best-first (descending)
    const targets = flat([
      [100, 2, 2, 1],
      [99, 2, 4, 0],
    ])
    const moving = advanceSide(targets, prev, out, 0.5, true)
    expect(moving).toBe(true)
    expect(out[0]!.q).toBe(1.5) // halfway from 1 to 2
    expect(out[0]!.t).toBe(1.5)
    expect(out[1]!.q).toBe(2) // unchanged target — already settled
  })

  it('matches by price, not index, when levels shift around', () => {
    const prev: PooledRow[] = [
      { p: 100, q: 1, t: 1, d: 0 },
      { p: 98, q: 5, t: 6, d: 0 },
    ]
    const out: PooledRow[] = []
    // a new best level (101) appears; 98 leaves the window
    const targets = flat([
      [101, 9, 9, 1],
      [100, 2, 11, 0],
    ])
    advanceSide(targets, prev, out, 0.5, true)
    expect(out[0]!.q).toBe(9) // unseen price seeds at target
    expect(out[1]!.q).toBe(1.5) // price 100 keeps gliding from ITS previous value
    expect(out[1]!.t).toBe(6) // halfway from 1 to 11
  })

  it('matches ascending (asks) ordering the same way', () => {
    const prev: PooledRow[] = [{ p: 100, q: 1, t: 1, d: 0 }]
    const out: PooledRow[] = []
    const targets = flat([
      [100, 3, 3, -1],
      [101, 4, 7, 0],
    ])
    advanceSide(targets, prev, out, 0.5, false)
    expect(out[0]!.q).toBe(2) // 1 → 3 halfway
    expect(out[0]!.d).toBe(-1) // flash flags pass through raw
    expect(out[1]!.q).toBe(4) // new level seeds at target
  })

  it('reuses pooled row objects across frames (zero steady-state allocation)', () => {
    const out: PooledRow[] = []
    advanceSide(flat([[100, 1, 1, 0]]), [], out, 1, true)
    const row = out[0]!
    advanceSide(flat([[100, 5, 5, 0]]), [...out], out, 1, true)
    expect(out[0]).toBe(row)
    expect(out[0]!.q).toBe(5)
  })

  it('converges to the exact target over repeated frames', () => {
    let prev: PooledRow[] = [{ p: 100, q: 0, t: 0, d: 0 }]
    const out: PooledRow[] = []
    const targets = flat([[100, 10, 10, 0]])
    let moving = true
    for (let frame = 0; frame < 40 && moving; frame++) {
      moving = advanceSide(targets, prev, out, 0.25, true)
      prev = out.map((r) => ({ ...r }))
    }
    expect(moving).toBe(false)
    expect(out[0]!.q).toBe(10)
    expect(out[0]!.t).toBe(10)
  })

  it('truncates the buffer when the window shrinks', () => {
    const out: PooledRow[] = []
    advanceSide(flat([
      [100, 1, 1, 0],
      [99, 1, 2, 0],
    ]), [], out, 1, true)
    advanceSide(flat([[100, 1, 1, 0]]), [...out], out, 1, true)
    expect(out).toHaveLength(1)
  })

  it('reports no change when the targets match the settled display', () => {
    const prev: PooledRow[] = [
      { p: 100, q: 2, t: 2, d: 0 },
      { p: 99, q: 1, t: 3, d: 0 },
    ]
    const out: PooledRow[] = []
    const targets = flat([
      [100, 2, 2, 0],
      [99, 1, 3, 0],
    ])
    expect(advanceSide(targets, prev, out, 0.5, true)).toBe(false)
  })

  it('reports a change when levels swap in and out at constant length', () => {
    // worst case for length-based change detection: 101 replaces 99, every
    // retained value already settled — the row set still changed
    const prev: PooledRow[] = [
      { p: 100, q: 2, t: 2, d: 0 },
      { p: 99, q: 1, t: 3, d: 0 },
    ]
    const out: PooledRow[] = []
    const targets = flat([
      [101, 2, 2, 0],
      [100, 2, 2, 0],
    ])
    expect(advanceSide(targets, prev, out, 1, true)).toBe(true)
  })
})
