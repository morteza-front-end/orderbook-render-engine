import type { RingBuffer } from './ring-buffer'
import type { FeedMode, FeedStatus } from './types'
import { SyntheticFeed } from './orderbook/synthetic'

/**
 * Feed transport management — the only piece of the data plane that runs
 * on the main thread.
 *
 * Owns either:
 *  - the live Binance depth WebSocket (raw frames pushed untouched into
 *    the ring buffer; parsing happens in the worker), with automatic
 *    reconnect after socket loss, or
 *  - the deterministic synthetic generator (identical wire format, so
 *    CI exercises the exact same code path).
 *
 * Abort-signal driven: `close()` is idempotent and nothing survives an
 * abort — timers cleared, socket handlers nulled and closed with 1000.
 */

const BINANCE_WS = 'wss://stream.binance.com:9443/ws'
const RECONNECT_DELAY_MS = 2000

export interface FeedConnectionOptions {
  mode: FeedMode
  symbol: string
  ratePerSec: number
  /** raw frame sink — the back-pressure boundary between transport and render */
  ring: RingBuffer<string>
  /** cooperative cancellation; aborting tears the connection down */
  signal: AbortSignal
  onStatus?: (status: FeedStatus) => void
}

export class FeedConnection {
  private ws: WebSocket | null = null
  private synthetic: SyntheticFeed | null = null
  private syntheticTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: FeedConnectionOptions) {}

  get mode(): FeedMode {
    return this.opts.mode
  }

  open(): void {
    if (this.opts.signal.aborted) return
    if (this.opts.mode === 'live') this.openLiveSocket()
    else this.startSyntheticFeed()
  }

  close(): void {
    this.clearReconnect()
    this.closeSocket()
    this.stopSyntheticFeed()
  }

  /**
   * Synthetic chain broke (e.g. ring overflow dropped frames): restart the
   * generator session with a fresh snapshot frame. Returns false when not
   * running a synthetic feed.
   */
  restartSyntheticSession(): boolean {
    if (!this.synthetic) return false
    this.opts.ring.clear()
    this.opts.ring.push(this.synthetic.snapshotRaw())
    return true
  }

  // ------------------------------------------------------------------ live

  private openLiveSocket(): void {
    this.closeSocket()
    const socket = new WebSocket(`${BINANCE_WS}/${this.opts.symbol}@depth@100ms`)
    this.ws = socket
    socket.onmessage = (ev: MessageEvent) => {
      // raw payload forwarded untouched — parsing happens in the worker
      this.opts.ring.push(String(ev.data))
    }
    socket.onerror = () => {
      if (!this.opts.signal.aborted) this.opts.onStatus?.('error')
    }
    socket.onclose = () => {
      if (this.opts.signal.aborted || this.opts.mode !== 'live') return
      // reconnect with a fresh snapshot; the worker's chain check self-heals
      this.clearReconnect()
      this.reconnectTimer = setTimeout(() => {
        if (!this.opts.signal.aborted && this.opts.mode === 'live') this.openLiveSocket()
      }, RECONNECT_DELAY_MS)
    }
  }

  private closeSocket(): void {
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onerror = null
      this.ws.onclose = null
      this.ws.close(1000)
      this.ws = null
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  // ------------------------------------------------------------- synthetic

  private startSyntheticFeed(): void {
    this.stopSyntheticFeed()
    const feed = new SyntheticFeed(this.opts.symbol, this.opts.ratePerSec)
    this.synthetic = feed
    this.opts.ring.push(feed.snapshotRaw())
    this.syntheticTimer = setInterval(() => this.opts.ring.push(feed.nextRaw()), feed.intervalMs)
  }

  private stopSyntheticFeed(): void {
    if (this.syntheticTimer) {
      clearInterval(this.syntheticTimer)
      this.syntheticTimer = null
    }
    this.synthetic = null
  }
}
