/**
 * Shared, framework-agnostic type surface of `@orderbook/core`.
 *
 * Everything the render plane needs to draw a book lives here: feed modes
 * and statuses, the worker RPC contract, the pooled row layout and the
 * per-frame snapshot handed to UI frameworks. No Vue, no React — this
 * package compiles standalone and is consumed by every client app.
 */

export type FeedMode = 'live' | 'synthetic'

export type FeedStatus =
  | 'idle'
  | 'syncing'
  | 'live'
  | 'stalled'
  | 'error'
  | 'closed'

/** Result of one worker drain: transferred Float64Arrays + book metrics. */
export interface DrainResult {
  /** flat [price, qty, cumulativeTotal, dir] * rows, bids best-first (desc) */
  bids: Float64Array
  /** flat [price, qty, cumulativeTotal, dir] * rows, asks best-first (asc) */
  asks: Float64Array
  mid: number
  spread: number
  /** order-book imbalance over the rendered depth window, in (0, 1) */
  imbalance: number
  seq: number
  status: FeedStatus
  /** last status transition reason (e.g. 'sequence-gap'); '' when clean */
  detail: string
  messages: number
  appliedEvents: number
  /** raw frames that failed wire-format parsing */
  malformed: number
  resyncs: number
}

/**
 * RPC surface exposed from the worker via Comlink. The main thread pulls
 * state at its own cadence (requestAnimationFrame) via `ingestAndDrain`,
 * which decouples message arrival rate from render rate.
 */
export interface WorkerApi {
  /** reset the book and (live mode) begin fetching a fresh REST snapshot */
  start(symbol: string, mode: FeedMode): Promise<void>
  /** apply buffered raw frames, then return the current rendered view */
  ingestAndDrain(raws: string[], rowLimit: number): Promise<DrainResult>
  stop(): Promise<void>
}

/**
 * One renderable depth row. Instances are POOLED and mutated in place by
 * the client — steady-state rendering allocates nothing.
 */
export interface PooledRow {
  /** price */
  p: number
  /** quantity */
  q: number
  /** cumulative side total at this row */
  t: number
  /** worker-computed flash direction: 1 up, -1 down, 0 none */
  d: number
}

/**
 * The per-frame book snapshot. A NEW wrapper object is produced once per
 * animation frame (identity change is the only reactivity signal); the
 * row arrays inside are the stable pooled objects.
 */
export interface BookSnapshot {
  /** monotonic frame counter — lets `useSyncExternalStore` detect changes */
  version: number
  bids: PooledRow[]
  asks: PooledRow[]
  mid: number
  spread: number
  /** bid-volume share of the rendered window, 0..1 (0.5 = balanced) */
  imbalance: number
}

/** UI chrome stats, refreshed on a slow cadence (default 500ms). */
export interface ClientStats {
  messages: number
  events: number
  seq: number
  resyncs: number
  dropped: number
  fps: number
  levels: number
  imbalance: number
}

export interface OrderbookClientOptions {
  /** default 'btcusdt' */
  symbol?: string
  /** default 'synthetic' */
  mode?: FeedMode
  /** synthetic feed rate, default 10 events/s */
  ratePerSec?: number
  /** rendered rows per side, default 600 */
  rowLimit?: number
  /**
   * Display smoothing time constant in ms: quantities, cumulative totals
   * and mid/spread/imbalance glide exponentially toward each drain target
   * (matched by price, frame-rate independent) so the tape animates
   * smoothly instead of stepping. Default 150; 0 disables (raw steps).
   */
  smoothingMs?: number
  /**
   * Bundler-friendly worker factory. Apps pass a one-line shim so the
   * bundler can resolve and bundle the worker entry:
   * `() => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`
   */
  workerFactory: () => Worker
  /** feed status transitions (max once per drain) */
  onStatus?: (status: FeedStatus) => void
  /** stats cadence, default 500ms */
  statsIntervalMs?: number
  /** stats emissions */
  onStats?: (stats: ClientStats) => void
}
