import * as Comlink from 'comlink'
import { FeedConnection } from './feed-connection'
import { ROW_STRIDE } from './orderbook/frames'
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
 *                     pooled row objects → NEW snapshot wrapper per frame
 *                                             ▼
 *                    listeners notified (max once per animation frame)
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

  // row pools: mutated in place so steady-state rendering allocates nothing
  private readonly bidPool: PooledRow[] = []
  private readonly askPool: PooledRow[] = []

  constructor(private readonly opts: OrderbookClientOptions) {
    this.symbol = opts.symbol ?? 'btcusdt'
    this.mode = opts.mode ?? 'synthetic'
    this.ratePerSec = opts.ratePerSec ?? 10
    this.rowLimit = opts.rowLimit ?? 600
    this.statsIntervalMs = opts.statsIntervalMs ?? STATS_INTERVAL_MS
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
   * per animation frame. Returns an unsubscribe function.
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

      if (!this.paused && (res.bids.length > 0 || res.asks.length > 0)) {
        this.copyRows(res.bids, this.bidPool)
        this.copyRows(res.asks, this.askPool)
        // replace (never mutate) — the one write that can trigger a re-render
        this.snapshot = {
          version: ++this.version,
          bids: this.bidPool,
          asks: this.askPool,
          mid: res.mid,
          spread: res.spread,
          imbalance: res.imbalance,
        }
        for (const listener of this.listeners) listener()
      }

      const now = performance.now()
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
