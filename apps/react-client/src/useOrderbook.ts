import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  OrderbookClient,
  type BookSnapshot,
  type ClientStats,
  type FeedMode,
  type FeedStatus,
} from '@orderbook/core'

/**
 * useOrderbook — the React binding for `@orderbook/core`, engineered for
 * 1,000Hz inputs without drowning the scheduler:
 *
 *  1. `useSyncExternalStore` is the ONLY bridge between the data plane and
 *     React. The core client replaces its cached snapshot object at most
 *     once per animation frame (rAF drain loop), so React re-renders at
 *     display cadence — never at message cadence.
 *  2. getSnapshot returns a cached value; identity changes only when a
 *     frame lands (the same contract Vue gets via `shallowRef` replace).
 *  3. Rows are pooled and mutated in place inside the core client — the
 *     render path allocates nothing in steady state.
 *  4. Status/stats ride separate low-frequency callbacks (one setState per
 *     transition / 500ms) so they can never amplify render pressure.
 *
 * The client instance is created lazily during the first render (stable in
 * a ref) because getSnapshot must be callable before effects run. It is
 * started in an effect and torn down deterministically on unmount — and
 * the core client is re-entrant, so React StrictMode's dev double-mount
 * (start → stop → start) is safe.
 */

const INITIAL_STATS: ClientStats = {
  messages: 0,
  events: 0,
  seq: 0,
  resyncs: 0,
  dropped: 0,
  fps: 0,
  levels: 0,
  imbalance: 0.5,
}

export interface UseOrderbookOptions {
  symbol: string
  mode: FeedMode
  ratePerSec: number
  paused: boolean
}

export function useOrderbook(options: UseOrderbookOptions): {
  snapshot: BookSnapshot
  status: FeedStatus
  stats: ClientStats
} {
  const [status, setStatus] = useState<FeedStatus>('idle')
  const [stats, setStats] = useState<ClientStats>(INITIAL_STATS)
  const clientRef = useRef<OrderbookClient | null>(null)

  // stable callbacks captured once at client construction
  const handleStatus = useRef((s: FeedStatus) => setStatus(s))
  const handleStats = useRef((s: ClientStats) => setStats(s))

  if (clientRef.current === null) {
    clientRef.current = new OrderbookClient({
      symbol: options.symbol,
      mode: options.mode,
      ratePerSec: options.ratePerSec,
      workerFactory: () =>
        new Worker(new URL('../worker/orderbook.worker.ts', import.meta.url), {
          type: 'module',
          name: 'orderbook',
        }),
      onStatus: (s) => handleStatus.current(s),
      onStats: (s) => handleStats.current(s),
    })
  }
  const client = clientRef.current

  // -- the single reactive boundary: at most one re-render per rAF frame --
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client])
  const getSnapshot = useCallback(() => client.getSnapshot(), [client])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // lifecycle: deterministic teardown, StrictMode-safe re-entrancy
  useEffect(() => {
    client.start()
    return () => client.stop()
  }, [client])

  // feed control: soft restart on symbol/mode change, skip initial mount
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    client.restart({ symbol: options.symbol, mode: options.mode, ratePerSec: options.ratePerSec })
  }, [client, options.symbol, options.mode, options.ratePerSec])

  // tape freeze: worker keeps consuming, view stops changing
  useEffect(() => {
    client.setPaused(options.paused)
  }, [client, options.paused])

  return { snapshot, status, stats }
}
