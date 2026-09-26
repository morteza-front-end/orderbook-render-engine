import { describe, expect, it } from 'vitest'
import { buildView } from '../src/orderbook/frames'
import { imbalanceFromTotals, pressureFromBidShare } from '../src/orderbook/imbalance'

describe('imbalanceFromTotals', () => {
  it('returns 0.5 share and ratio 1 for a balanced book', () => {
    expect(imbalanceFromTotals(10, 10)).toEqual({ bidShare: 0.5, ratio: 1 })
  })

  it('weights the bid share by window volume', () => {
    const { bidShare, ratio } = imbalanceFromTotals(30, 10)
    expect(bidShare).toBeCloseTo(0.75)
    expect(ratio).toBeCloseTo(3)
  })

  it('handles one-sided books without dividing by zero', () => {
    expect(imbalanceFromTotals(5, 0)).toEqual({ bidShare: 1, ratio: Number.MAX_SAFE_INTEGER })
    const askOnly = imbalanceFromTotals(0, 5)
    expect(askOnly.bidShare).toBe(0)
    expect(askOnly.ratio).toBe(0)
  })

  it('treats an empty book as neutral', () => {
    expect(imbalanceFromTotals(0, 0)).toEqual({ bidShare: 0.5, ratio: 1 })
  })
})

describe('pressureFromBidShare', () => {
  it('maps the share range (0,1) onto pressure (-1,1)', () => {
    expect(pressureFromBidShare(0.5)).toBeCloseTo(0)
    expect(pressureFromBidShare(1)).toBeCloseTo(1)
    expect(pressureFromBidShare(0)).toBeCloseTo(-1)
    expect(pressureFromBidShare(0.9)).toBeCloseTo(0.8)
  })
})

describe('buildView imbalance', () => {
  it('computes imbalance over the rendered window totals', () => {
    const bids = new Map<number, number>([
      [100, 3],
      [99, 3],
    ])
    const asks = new Map<number, number>([[101, 2]])
    const v = buildView(bids, asks, new Map(), new Map(), 10)
    // bid window total 6, ask window total 2 -> share 0.75
    expect(v.imbalance).toBeCloseTo(0.75)
  })

  it('reports 0 when the book is empty', () => {
    const v = buildView(new Map(), new Map(), new Map(), new Map(), 10)
    expect(v.imbalance).toBe(0)
  })
})
