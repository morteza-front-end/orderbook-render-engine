import type * as Comlink from 'comlink'
import type { OrderBookBatch } from '../lib/orderbook/store'

export type FeedKind = 'live' | 'synthetic'

export type FeedStatus =
  | 'idle'
  | 'connecting'
  | 'syncing'
  | 'live'
  | 'error'
  | 'closed'

export interface StatusMessage {
  status: FeedStatus
  detail?: string
}

export interface WorkerStats {
  messages: number
  appliedEvents: number
  resyncs: number
  batches: number
  droppedByBackpressure: number
  seq: number
}

export interface StartOptions {
  symbol: string
  feed: FeedKind
  /** synthetic-only: events per second */
  ratePerSec?: number
}

export type BatchHandler = (batch: OrderBookBatch) => void
export type StatusHandler = (msg: StatusMessage) => void

/**
 * Contract exposed through Comlink from `orderbook.worker.ts`.
 *
 * The callbacks are separate top-level parameters (wrapped with
 * `Comlink.proxy` by the caller): Comlink's transfer handlers only apply to
 * direct arguments, never to values nested inside plain option objects.
 */
export interface OrderBookWorkerApi {
  start(
    opts: StartOptions,
    onBatch: Comlink.ProxyMarked & BatchHandler,
    onStatus: Comlink.ProxyMarked & StatusHandler,
  ): Promise<void>
  stop(): Promise<void>
  stats(): Promise<WorkerStats>
}
