import * as Comlink from 'comlink'
import { FeedConnection } from './feed-connection'
import { ROW_STRIDE } from './orderbook/frames'
import { advanceSide, approach, smoothAlpha } from './orderbook/smoothing'
import { RingBuffer } from './ring-buffer'
import type {
  BookSnapshot,
  ClientStats,
  FeedMode,
  FeedStatus,
  OrderbookClientOptions,
  PooledRow,
  WorkerApi,
} from './types'

const RING_CAPACITY = 512
const STATS_INTERVAL_MS = 500
const DEFAULT_SMOOTHING_MS = 150

const EMPTY_SNAPSHOT: BookSnapshot = {
  version: 0,
  bids: [],
  asks: [],
  mid: 0,
  spread: 0,
  imbalance: 0.5,
}

/**
 * ORDERBOOK CLIENT — the complete render plane, framework-agnostic.
 *
 * Owns every high-frequency mechanism so UI frameworks only translate
 * snapshots into DOM:
 *
 *   FeedConnection (WS / synthetic)  ─►  RingBuffer (back-pressure boundary)
 *                                             │  rAF loop (display cadence)
 *                                             ▼
 *                              worker.ingestAndDrain(raws, rowLimit)
 *                                parse + diff + sort   [WORKER]
 *                                             ▼
 *                              transferred Float64Arrays (zero copy)
 *                                             ▼
 *                     display smoothing: values glide exponentially
 *                     toward targets (matched by price, zero-alloc)
 *                                             ▼
 *                     pooled row objects → NEW snapshot wrapper per frame
 *                                             ▼
 *           listeners notified — max once per animation frame, and only
 *           when the rendered content actually changed (a settled book
 *           keeps the same snapshot reference: no notify, no re-render)
 *
 * Contract with UI frameworks:
 *  - `getSnapshot()` returns a cached object whose identity changes at
 *    most once per animation frame → perfect for Vue `shallowRef` replace
 *    or React `useSyncExternalStore`.
 *  - Row arrays are pooled and mutated in place — steady-state rendering
 *    allocates nothing.
 *  - `stop()` is deterministic: socket, worker heap, rAF loop, ring buffer
 *    and pools are all released; nothing survives teardown.
 */
export class OrderbookClient {
  private readonly rowLimit: number
  private readonly statsIntervalMs: number
  private readonly smoothingMs: number
  private readonly ring = new RingBuffer<string>(RING_CAPACITY)
  private readonly listeners = new Set<() => void>()
  private abort = new AbortController()

  private worker: Worker | null = null
  private api: Comlink.Remote<WorkerApi> | null = null
  private connection: FeedConnection | null = null

  private symbol: string
  private mode: FeedMode
  private ratePerSec: number

  private paused = false
  private snapshot: BookSnapshot = EMPTY_SNAPSHOT
  private stats: ClientStats = {
    messages: 0,
    events: 0,
    seq: 0,
    resyncs: 0,
    dropped: 0,
    fps: 0,
    levels: 0,
    imbalance: 0.5,
  }
  private status: FeedStatus = 'idle'
  private version = 0

  private rafId = 0
  private pulling = false
  private frames = 0
  private fpsWindowStart = 0
  private fps = 0
  private lastStatsAt = 0
  private started = false

  // display rows: double-buffered so smoothing can read the previous
  // frame while writing the next one — steady-state rendering allocates
  // nothing (row objects are pooled and mutated in place)
  private bidDisplay: PooledRow[] = []
  private askDisplay: PooledRow[] = []
  private bidSwap: PooledRow[] = []
  private askSwap: PooledRow[] = []

  // smoothed book metrics (mid/spread/imbalance glide like the rows)
  private midDisplay = 0
  private spreadDisplay = 0
  private imbalanceDisplay = 0
  private lastDrainAt = 0

  constructor(private readonly opts: OrderbookClientOptions) {
    this.symbol = opts.symbol ?? 'btcusdt'
    this.mode = opts.mode ?? 'synthetic'
    this.ratePerSec = opts.ratePerSec ?? 10
    this.rowLimit = opts.rowLimit ?? 600
    this.statsIntervalMs = opts.statsIntervalMs ?? STATS_INTERVAL_MS
    this.smoothingMs = opts.smoothingMs ?? DEFAULT_SMOOTHING_MS
  }

  // ----------------------------------------------------------------- public

  /** Spawn the worker, open the feed and start the rAF drain loop.
   *  Re-entrant: a client that was stopped can be started again (StrictMode
   *  dev remounts, HMR). */
  start(): void {
    if (this.started) return
    this.started = true
    this.abort = new AbortController()
    this.worker = this.opts.workerFactory()
    this.api = Comlink.wrap<WorkerApi>(this.worker)
    this.fpsWindowStart = performance.now()
    this.openConnection()
    this.rafId = requestAnimationFrame(this.frame)
  }

  /** Deterministic teardown: rAF, socket, timers, worker, ring, pools. */
  stop(): void {
    if (!this.started) return
    this.started = false
    this.abort.abort()
    cancelAnimationFrame(this.rafId)
    this.rafId = 0
    this.connection?.close()
    this.connection = null
    if (this.api) void this.api.stop().catch(() => {})
    this.worker?.terminate()
    this.worker = null
    this.api = null
    this.ring.clear()
    this.snapshot = EMPTY_SNAPSHOT
    this.listeners.clear()
  }

  /**
   * Soft restart on symbol/feed/rate changes: the worker instance is
   * reused, the transport is rebuilt, the view resets.
   */
  restart(next: Partial<{ symbol: string; mode: FeedMode; ratePerSec: number }> = {}): void {
    if (!this.started || this.abort.signal.aborted) return
    this.symbol = next.symbol ?? this.symbol
    this.mode = next.mode ?? this.mode
    this.ratePerSec = next.ratePerSec ?? this.ratePerSec
    this.connection?.close()
    this.ring.clear()
    this.snapshot = EMPTY_SNAPSHOT
    // metrics must not glide across symbol/feed switches
    this.midDisplay = 0
    this.spreadDisplay = 0
    this.imbalanceDisplay = 0
    this.lastDrainAt = 0
    this.openConnection()
  }

  /** Freeze the tape: the worker keeps consuming, the view stops changing. */
  setPaused(paused: boolean): void {
    this.paused = paused
  }

  isPaused(): boolean {
    return this.paused
  }

  /**
   * Register a listener invoked after each snapshot replace — at most once
   * per animation frame, and only when the rendered content changed (the
   * identity contract `useSyncExternalStore` needs: between notifies,
   * `getSnapshot()` returns the exact same reference). Returns an
   * unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Cached per-frame snapshot; identity changes only on rAF replaces. */
  getSnapshot(): BookSnapshot {
    return this.snapshot
  }

  getStats(): ClientStats {
    return this.stats
  }

  getStatus(): FeedStatus {
    return this.status
  }

  // ---------------------------------------------------------------- internal

  private openConnection(): void {
    this.connection = new FeedConnection({
      mode: this.mode,
      symbol: this.symbol,
      ratePerSec: this.ratePerSec,
      ring: this.ring,
      signal: this.abort.signal,
      onStatus: (s) => {
        this.status = s
        this.opts.onStatus?.(s)
      },
    })
    this.connection.open()
    void this.api?.start(this.symbol, this.mode).catch(() => {})
  }

  private readonly frame = (now: number): void => {
    this.rafId = requestAnimationFrame(this.frame)
    this.frames++
    if (now - this.fpsWindowStart >= 1000) {
      this.fps = Math.round((this.frames * 1000) / (now - this.fpsWindowStart))
      this.frames = 0
      this.fpsWindowStart = now
    }
    if (!this.pulling && this.api) void this.pull()
  }

  private async pull(): Promise<void> {
    this.pulling = true
    try {
      const raws: string[] = []
      this.ring.drain((r) => raws.push(r))
      const res = await this.api!.ingestAndDrain(raws, this.rowLimit)
      if (this.abort.signal.aborted) return

      if (res.status === 'stalled') this.connection?.restartSyntheticSession()
      if (res.status !== this.status) {
        this.status = res.status
        this.opts.onStatus?.(res.status)
      }

      const now = performance.now()
      if (!this.paused && (res.bids.length > 0 || res.asks.length > 0)) {
        // display smoothing: glide every value toward its drain target with
        // a frame-rate-independent exponential approach (matched by price,
        // double-buffered pools). `smoothingMs: 0` falls back to raw steps.
        const alpha = smoothAlpha(now - this.lastDrainAt, this.smoothingMs)
        this.lastDrainAt = now
        let changed = true
        if (this.smoothingMs > 0) {
          // write into the swap buffers first, then publish ONLY when the
          // rendered content actually changed — a settled book keeps the
          // exact same snapshot reference (no re-render, no notify), which
          // is the identity contract useSyncExternalStore requires
          const bidsChanged = advanceSide(res.bids, this.bidDisplay, this.bidSwap, alpha, true)
          const asksChanged = advanceSide(res.asks, this.askDisplay, this.askSwap, alpha, false)
          this.midDisplay = approach(this.midDisplay, res.mid, alpha)
          this.spreadDisplay = approach(this.spreadDisplay, res.spread, alpha)
          this.imbalanceDisplay = approach(this.imbalanceDisplay, res.imbalance, alpha)
          changed =
            bidsChanged ||
            asksChanged ||
            this.midDisplay !== res.mid ||
            this.spreadDisplay !== res.spread ||
            this.imbalanceDisplay !== res.imbalance
          if (changed) {
            // the just-written swap buffers become the displayed pools
            const bidNext = this.bidSwap
            this.bidSwap = this.bidDisplay
            this.bidDisplay = bidNext
            const askNext = this.askSwap
            this.askSwap = this.askDisplay
            this.askDisplay = askNext
          }
        } else {
          this.copyRows(res.bids, this.bidDisplay)
          this.copyRows(res.asks, this.askDisplay)
          this.midDisplay = res.mid
          this.spreadDisplay = res.spread
          this.imbalanceDisplay = res.imbalance
        }
        if (changed) {
          // replace (never mutate) — the one write that can trigger a re-render
          this.snapshot = {
            version: ++this.version,
            bids: this.bidDisplay,
            asks: this.askDisplay,
            mid: this.midDisplay,
            spread: this.spreadDisplay,
            imbalance: this.imbalanceDisplay,
          }
          for (const listener of this.listeners) listener()
        }
      }

      if (now - this.lastStatsAt >= this.statsIntervalMs) {
        this.lastStatsAt = now
        this.stats = {
          messages: res.messages,
          events: res.appliedEvents,
          seq: res.seq,
          resyncs: res.resyncs,
          dropped: this.ring.dropped,
          fps: this.fps,
          levels: (res.bids.length + res.asks.length) / ROW_STRIDE,
          imbalance: res.imbalance,
        }
        this.opts.onStats?.(this.stats)
      }
    } catch {
      // worker torn down mid-call during stop() — nothing to do
    } finally {
      this.pulling = false
    }
  }

  private copyRows(flat: Float64Array, pool: PooledRow[]): void {
    const n = flat.length / ROW_STRIDE
    for (let i = 0; i < n; i++) {
      const o = i * ROW_STRIDE
      const row = pool[i]
      if (row) {
        row.p = flat[o]!
        row.q = flat[o + 1]!
        row.t = flat[o + 2]!
        row.d = flat[o + 3]!
      } else {
        pool[i] = { p: flat[o]!, q: flat[o + 1]!, t: flat[o + 2]!, d: flat[o + 3]! }
      }
    }
    pool.length = n
  }
}
