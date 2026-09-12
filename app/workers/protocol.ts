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
  /** emitted on every coalesced batch (transferred Float64Arrays) */
  onBatch: (batch: OrderBookBatch) => void
  onStatus: (msg: StatusMessage) => void
}

/** Contract exposed through Comlink from `orderbook.worker.ts`. */
export interface OrderBookWorkerApi {
  start(opts: StartOptions): Promise<void>
  stop(): Promise<void>
  stats(): Promise<WorkerStats>
}
