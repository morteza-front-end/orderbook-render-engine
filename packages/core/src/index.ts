/**
 * `@orderbook/core` — framework-agnostic high-frequency order-book engine.
 *
 * Public surface:
 *  - `OrderbookClient`      render-plane orchestrator (worker + ring + rAF)
 *  - `FeedConnection`       live WS / synthetic transport management
 *  - `DepthDiffEngine`      pure Binance diff-depth protocol engine
 *  - `parseFrame/buildView` wire-format parsing + worker view builder
 *  - `RingBuffer`           back-pressure boundary between transport/render
 *  - `SyntheticFeed`        deterministic Binance-wire-format feed for CI
 *  - imbalance helpers      order-book pressure metrics
 *
 * Worker entry: import '@orderbook/core/worker' inside a worker shim.
 */

export { OrderbookClient } from './client'
export { FeedConnection, type FeedConnectionOptions } from './feed-connection'
export { RingBuffer } from './ring-buffer'
export { DepthDiffEngine } from './orderbook/depth-diff'
export type {
  ApplyResult,
  DepthEvent,
  DepthSnapshot,
  LevelMap,
} from './orderbook/depth-diff'
export { buildView, parseFrame, ROW_STRIDE, type BookView, type ParsedFrame } from './orderbook/frames'
export { imbalanceFromTotals, pressureFromBidShare, type Imbalance } from './orderbook/imbalance'
export { SyntheticFeed } from './orderbook/synthetic'
export type {
  BookSnapshot,
  ClientStats,
  DrainResult,
  FeedMode,
  FeedStatus,
  OrderbookClientOptions,
  PooledRow,
  WorkerApi,
} from './types'
