/**
 * Order-book imbalance (pressure) metrics — pure math, no platform deps.
 *
 * Imbalance compares resting bid vs ask volume over the same depth window
 * the renderer draws. It is the standard microstructure signal for
 * short-horizon directional pressure:
 *
 *   bidShare = bidVolume / (bidVolume + askVolume)   in (0, 1)
 *   ratio    = bidVolume / askVolume                 (> 1 = bid-heavy)
 *
 * Computed inside the worker from the window's cumulative totals so the
 * render plane never touches the level maps.
 */

export interface Imbalance {
  /** bid volume share of total window volume; 0.5 when book is balanced */
  bidShare: number
  /** bidVolume / askVolume; 1 when balanced, 0 when no bids, Infinity-free */
  ratio: number
}

/** Clamp helper keeps the share strictly inside (0, 1) for bar rendering. */
export function imbalanceFromTotals(bidTotal: number, askTotal: number): Imbalance {
  const total = bidTotal + askTotal
  if (!(total > 0)) return { bidShare: 0.5, ratio: 1 }
  const bidShare = bidTotal / total
  const ratio = askTotal > 0 ? bidTotal / askTotal : Number.MAX_SAFE_INTEGER
  return { bidShare, ratio }
}

/**
 * Map a bid share to a signed pressure value in [-1, 1].
 * Useful for gauges: 0 = balanced, +1 = all bids, -1 = all asks.
 */
export function pressureFromBidShare(bidShare: number): number {
  return Math.max(-1, Math.min(1, (bidShare - 0.5) * 2))
}
