import type { PooledRow } from '../types'
import { ROW_STRIDE } from './frames'

/**
 * Display smoothing — the presentation-layer interpolation stage between
 * worker drains.
 *
 * Raw drains replace quantities, cumulative totals and book metrics
 * stepwise, which reads as "jumping" numbers even at a locked 60 FPS.
 * This module glides every displayed value toward its drain target with a
 * frame-rate-independent exponential approach, so the tape animates
 * continuously instead of stepping.
 *
 * Performance contract (same envelope as the rest of the core):
 *  - pure functions, no closures, no allocation in `advanceSide`'s steady
 *    state (row objects are reused from the caller's double buffer)
 *  - O(n) two-pointer merge over price-sorted rows, no Maps
 */

/**
 * Snap-together epsilon: half of the last rendered digit for the standard
 * 2-decimal tape formatting. Below this distance the value is
 * indistinguishable from its target, so it snaps to keep idle text stable.
 */
const SNAP_EPS = 0.005

/** longest gap (ms) treated as one animation step — tab switches must not teleport */
const MAX_STEP_MS = 100

/**
 * Frame-rate-independent approach factor for a smoothing time constant.
 * `tauMs <= 0` (smoothing off) or a non-positive step collapses to 1 —
 * pure passthrough.
 */
export function smoothAlpha(dtMs: number, tauMs: number): number {
  if (tauMs <= 0 || dtMs <= 0) return 1
  const dt = Math.min(dtMs, MAX_STEP_MS)
  return 1 - Math.exp(-dt / tauMs)
}

/**
 * Move `cur` toward `target` by `alpha`, snapping when the remaining
 * distance is below the display epsilon. Returns the new display value.
 */
export function approach(cur: number, target: number, alpha: number): number {
  const next = cur + (target - cur) * alpha
  return Math.abs(target - next) <= SNAP_EPS ? target : next
}

/**
 * Glide one side's displayed rows toward the latest drain targets.
 *
 * `targets` is the worker's flat `[price, qty, total, dir] * rows` array;
 * `prev` holds the previous frame's displayed rows. Both are sorted by
 * price in the same direction (`descending` = bids best-first, asks are
 * ascending), so values are matched BY PRICE with a two-pointer merge —
 * a level keeps gliding even while levels enter and leave the window
 * around it, and rows never glide across price levels. Prices without a
 * previous display value seed AT target (no fake full-scale sweeps).
 *
 * Writes into `out` (the caller's swap buffer; may alias neither input)
 * and returns whether the rendered content changed in any way — a value
 * still gliding, a level entering or leaving the window — i.e. whether
 * the caller should publish a new snapshot and notify listeners. A
 * settled book returns false, which lets `getSnapshot()` keep returning
 * the exact same reference until something actually changed.
 */
export function advanceSide(
  targets: Float64Array,
  prev: PooledRow[],
  out: PooledRow[],
  alpha: number,
  descending: boolean,
): boolean {
  let changed = false
  const rows = targets.length / ROW_STRIDE
  let j = 0
  let matched = 0
  for (let i = 0; i < rows; i++) {
    const o = i * ROW_STRIDE
    const p = targets[o]!
    const qTarget = targets[o + 1]!
    const tTarget = targets[o + 2]!
    // advance the previous-frame cursor to the first row at/after this price
    while (j < prev.length && (descending ? prev[j]!.p > p : prev[j]!.p < p)) j++
    let qPrev = qTarget
    let tPrev = tTarget
    if (j < prev.length && prev[j]!.p === p) {
      qPrev = prev[j]!.q
      tPrev = prev[j]!.t
      matched++
    } else {
      // unseen price: mounts a new row, so the view must repaint
      changed = true
    }
    const q = approach(qPrev, qTarget, alpha)
    const t = approach(tPrev, tTarget, alpha)
    const row = out[i]
    if (row) {
      row.p = p
      row.q = q
      row.t = t
      row.d = targets[o + 3]!
    } else {
      out[i] = { p, q, t, d: targets[o + 3]! }
    }
    if (q !== qTarget || t !== tTarget) changed = true
  }
  out.length = rows
  // prices that left the window unmount rows — also a repaint
  if (matched !== prev.length) changed = true
  return changed
}
