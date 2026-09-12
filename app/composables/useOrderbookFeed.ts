import { shallowRef, onScopeDispose, readonly } from 'vue'
import * as Comlink from 'comlink'
import { OrderBookStore, type OrderBookBatch, type OrderBookView } from '../lib/orderbook/store'
import { RingBuffer } from '../lib/ring-buffer'
import type { OrderBookWorkerApi, StatusMessage, FeedKind } from '../workers/protocol'
import { useSessionStore } from '../stores/session'

const RING_CAPACITY = 512 // power of two; ~5s of 100Hz burst before overwrite
const FLUSH_LIMIT = 600 // max rows per side materialized per frame
const STATS_INTERVAL_MS = 1000

export interface FeedOptions {
  symbol: string
  feed: FeedKind
  ratePerSec?: number
}

export interface OrderbookFeed {
  /** replaced (not mutated) at most once per frame — consume via shallowRef */
  view: Readonly<ReturnType<typeof shallowRef<OrderBookView>>>
  start(): Promise<void>
  restart(opts: FeedOptions): Promise<void>
  setPaused(paused: boolean): void
}

/**
 * Render engine bridge.
 *
 * worker --(coalesced batches)--> RingBuffer --(drain @ rAF)--> OrderBookStore
 *   --> shallowRef(view) --> virtualized lists
 *
 * - Reads from the buffer are synchronized to the display refresh rate via
 *   requestAnimationFrame instead of reactive watchers, so a 100Hz feed never
 *   causes more renders than the monitor can show.
 * - The whole lifecycle is tied to an AbortController; aborting (component
 *   unmount) stops the worker, cancels the rAF loop and drops every retained
 *   reference so no node survives component disposal.
 */
export function useOrderbookFeed(): OrderbookFeed {
  const session = useSessionStore()

  const ring = new RingBuffer<OrderBookBatch>(RING_CAPACITY)
  const book = new OrderBookStore(ring)

  const view = shallowRef<OrderBookView>({
    bids: [],
    asks: [],
    mid: 0,
    spread: 0,
    seq: 0,
    ts: 0,
  })

  let worker: Worker | null = null
  let api: Comlink.Remote<OrderBookWorkerApi> | null = null
  let rafId = 0
  let statsTimer: ReturnType<typeof setInterval> | null = null
  // serialized start/restart operations: a restart resolves only after its
  // options are live in the worker (no lost-update races with query params)
  let chain: Promise<void> = Promise.resolve()

  function enqueue(fn: () => Promise<void>): Promise<void> {
    const next = chain.then(fn, fn)
    chain = next.then(
      () => {},
      () => {},
    )
    return next
  }

  const abort = new AbortController()
  const { signal } = abort

  let paused = false
  let fps = 0
  let frameCount = 0
  let frameWindowStart = performance.now()

  // ------------------------------------------------------------ render loop

  function tick(): void {
    rafId = requestAnimationFrame(tick)
    if (paused) {
      // keep the ring from filling while the user has paused the tape
      ring.clear()
      return
    }
    const next = book.flush(FLUSH_LIMIT)
    // store.flush() returns the shared empty view when nothing changed:
    // skipping the write keeps the vdom completely idle between updates
    if (next.bids.length > 0 || next.asks.length > 0) {
      view.value = next
    }
    frameCount++
    const now = performance.now()
    if (now - frameWindowStart >= STATS_INTERVAL_MS) {
      fps = Math.round((frameCount * 1000) / (now - frameWindowStart))
      frameCount = 0
      frameWindowStart = now
    }
  }

  // ------------------------------------------------------------ worker wire

  function onBatch(batch: OrderBookBatch): void {
    if (signal.aborted) return
    book.ingest(batch)
  }

  function onStatus(msg: StatusMessage): void {
    if (signal.aborted) return
    session.setStatus(msg.status, msg.detail ?? '')
  }

  async function start(): Promise<void> {
    if (signal.aborted) return
    await enqueue(async () => {
      spawnWorker()
      book.reset()
      view.value = { bids: [], asks: [], mid: 0, spread: 0, seq: 0, ts: 0 }
      startLoop()
      startStats()
      await launch({ symbol: session.symbol, feed: session.feed as FeedKind, ratePerSec: session.rate })
    })
  }

  async function restart(opts: FeedOptions): Promise<void> {
    if (signal.aborted) return
    await enqueue(async () => {
      if (!api) return
      book.reset()
      view.value = { bids: [], asks: [], mid: 0, spread: 0, seq: 0, ts: 0 }
      await launch(opts)
    })
  }

  async function launch(opts: FeedOptions): Promise<void> {
    if (!api) return
    await api.start({
      symbol: opts.symbol,
      feed: opts.feed,
      ratePerSec: opts.ratePerSec,
      onBatch: Comlink.proxy(onBatch),
      onStatus: Comlink.proxy(onStatus),
    })
  }

  function spawnWorker(): void {
    disposeWorker()
    worker = new Worker(new URL('../workers/orderbook.worker.ts', import.meta.url), {
      type: 'module',
      name: 'orderbook',
    })
    api = Comlink.wrap<OrderBookWorkerApi>(worker)
  }

  function startLoop(): void {
    if (!rafId) {
      frameWindowStart = performance.now()
      frameCount = 0
      rafId = requestAnimationFrame(tick)
    }
  }

  function startStats(): void {
    if (statsTimer) return
    statsTimer = setInterval(async () => {
      if (signal.aborted) return
      const s = api ? await api.stats().catch(() => null) : null
      session.stats = {
        messages: s?.messages ?? 0,
        appliedEvents: s?.appliedEvents ?? 0,
        batches: s?.batches ?? 0,
        resyncs: s?.resyncs ?? 0,
        droppedBatches: ring.dropped,
        pendingBatches: ring.size,
        seq: s?.seq ?? 0,
        fps,
      }
    }, STATS_INTERVAL_MS)
  }

  function setPaused(next: boolean): void {
    paused = next
  }

  function disposeWorker(): void {
    if (worker) {
      worker.terminate()
      worker = null
      api = null
    }
  }

  function dispose(): void {
    if (signal.aborted) return
    abort.abort()
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    if (statsTimer) {
      clearInterval(statsTimer)
      statsTimer = null
    }
    disposeWorker()
    book.reset()
    ring.clear()
    view.value = { bids: [], asks: [], mid: 0, spread: 0, seq: 0, ts: 0 }
  }

  signal.addEventListener('abort', dispose)
  onScopeDispose(dispose)

  return {
    view: readonly(view),
    start,
    restart,
    setPaused,
  }
}
