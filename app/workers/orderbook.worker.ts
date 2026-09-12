/// <reference lib="webworker" />
import * as Comlink from 'comlink'
import { DepthDiffEngine, type DepthEvent } from '../lib/orderbook/depth-diff'
import { SyntheticFeed } from './feed/synthetic'
import type { OrderBookWorkerApi, StartOptions, StatusMessage, WorkerStats, FeedKind, BatchHandler, StatusHandler } from './protocol'
import type { OrderBookBatch } from '../lib/orderbook/store'

const BINANCE_WS = 'wss://stream.binance.com:9443/ws'
const BINANCE_REST = 'https://api.binance.com/api/v3/depth'
/** minimum interval between coalesced batch posts to the main thread */
const MIN_POST_INTERVAL_MS = 16

/**
 * Order book worker: owns the exchange connection and the diff engine so raw
 * payloads, JSON parsing and book maintenance never touch the main thread.
 * Only compact, coalesced Float64Array batches cross the boundary.
 */
class OrderBookWorker implements OrderBookWorkerApi {
  private engine = new DepthDiffEngine()
  private ws: WebSocket | null = null
  private synthetic: SyntheticFeed | null = null
  private syntheticTimer: ReturnType<typeof setInterval> | null = null
  private postTimer: ReturnType<typeof setInterval> | null = null
  private stopping = false
  private feed: FeedKind = 'live'
  private symbol = ''

  // coalescing buffers (reused, no per-event allocation)
  private pendingBids: [number, number][] = []
  private pendingAsks: [number, number][] = []
  private lastPostAt = 0
  private batchSeq = 0

  // stats
  private messages = 0
  private appliedEvents = 0
  private resyncs = 0
  private batchesPosted = 0

  private onBatch: ((batch: OrderBookBatch) => void) | null = null
  private onStatus: ((msg: StatusMessage) => void) | null = null

  constructor() {
    this.engine.onGap = () => {
      this.resyncs++
      void this.resync('sequence-gap')
    }
  }

  async start(
    opts: StartOptions,
    onBatch: BatchHandler,
    onStatus: StatusHandler,
  ): Promise<void> {
    await this.stop()
    this.stopping = false
    this.feed = opts.feed
    this.symbol = opts.symbol.toLowerCase()
    this.onBatch = onBatch
    this.onStatus = onStatus
    this.engine.reset()

    this.postTimer = setInterval(() => this.flushBatch(), MIN_POST_INTERVAL_MS)
    if (opts.feed === 'synthetic') {
      this.startSynthetic(opts.ratePerSec ?? 10)
    } else {
      this.startLive()
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.clearTimers()
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onerror = null
      this.ws.onclose = null
      try {
        this.ws.close()
      } catch {
        /* already closed */
      }
      this.ws = null
    }
    this.synthetic = null
    this.engine.reset()
    this.pendingBids.length = 0
    this.pendingAsks.length = 0
    this.onBatch = null
    this.onStatus = null
  }

  async stats(): Promise<WorkerStats> {
    return {
      messages: this.messages,
      appliedEvents: this.appliedEvents,
      resyncs: this.resyncs,
      batches: this.batchesPosted,
      droppedByBackpressure: 0,
      seq: this.engine.sequence,
    }
  }

  // ---------------------------------------------------------------- live feed

  private startLive(): void {
    this.emitStatus('connecting')
    const url = `${BINANCE_WS}/${this.symbol}@depth@100ms`
    const ws = new WebSocket(url)
    this.ws = ws
    ws.onopen = () => {
      this.emitStatus('syncing')
      void this.fetchSnapshot()
    }
    ws.onmessage = (ev: MessageEvent) => this.handleRaw(ev.data as string)
    ws.onerror = () => {
      this.emitStatus('error', `websocket error: ${url}`)
    }
    ws.onclose = () => {
      if (!this.stopping) {
        this.emitStatus('closed')
        // exponential-ish reconnect with fresh snapshot
        setTimeout(() => {
          if (!this.stopping) this.startLive()
        }, 2000)
      }
    }
  }

  private async fetchSnapshot(): Promise<void> {
    const symbol = this.symbol.toUpperCase()
    try {
      const res = await fetch(`${BINANCE_REST}?symbol=${symbol}&limit=1000`)
      if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`)
      const snap = (await res.json()) as {
        lastUpdateId: number
        bids: [string, string][]
        asks: [string, string][]
      }
      this.engine.sync({
        lastUpdateId: snap.lastUpdateId,
        bids: snap.bids.map(([p, q]) => [Number.parseFloat(p), Number.parseFloat(q)]),
        asks: snap.asks.map(([p, q]) => [Number.parseFloat(p), Number.parseFloat(q)]),
      })
      // publish the initial book as one batch so the UI can render instantly
      const bids: [number, number][] = Array.from(this.engine.bids.entries())
      const asks: [number, number][] = Array.from(this.engine.asks.entries())
      this.postMessage(bids, asks)
      this.emitStatus('live')
    } catch (err) {
      this.emitStatus('error', `snapshot failed: ${String(err)}`)
      setTimeout(() => {
        if (!this.stopping && this.ws?.readyState === WebSocket.OPEN) void this.fetchSnapshot()
      }, 2000)
    }
  }

  private handleRaw(raw: string): void {
    this.messages++
    const msg = JSON.parse(raw) as {
      U?: number
      u?: number
      pu?: number
      b?: [string, string][]
      a?: [string, string][]
    }
    if (msg.U === undefined || msg.u === undefined) return
    const evt: DepthEvent = {
      U: msg.U,
      u: msg.u,
      pu: msg.pu ?? 0,
      bids: (msg.b ?? []).map(([p, q]) => [Number.parseFloat(p), Number.parseFloat(q)]),
      asks: (msg.a ?? []).map(([p, q]) => [Number.parseFloat(p), Number.parseFloat(q)]),
    }
    this.applyEvent(evt)
  }

  // ----------------------------------------------------------- synthetic feed

  private startSynthetic(ratePerSec: number): void {
    this.emitStatus('syncing')
    const feed = new SyntheticFeed({ symbol: this.symbol, ratePerSec, seed: 0x5eed })
    this.synthetic = feed
    const snap = feed.snapshot()
    this.engine.sync(snap)
    this.postMessage(
      snap.bids.map(([p, q]) => [p, q]),
      snap.asks.map(([p, q]) => [p, q]),
    )
    this.emitStatus('live')
    const interval = Math.max(4, Math.floor(1000 / ratePerSec))
    this.syntheticTimer = setInterval(() => {
      if (this.stopping || !this.synthetic) return
      this.messages++
      this.applyEvent(this.synthetic.nextEvent())
    }, interval)
  }

  // ------------------------------------------------------------------ engine

  private applyEvent(evt: DepthEvent): void {
    const { applied, gap } = this.engine.apply(evt)
    if (gap) return // onGap handler already scheduled a resync
    if (!applied) return
    this.appliedEvents++
    for (const level of evt.bids) this.pendingBids.push(level)
    for (const level of evt.asks) this.pendingAsks.push(level)
  }

  private async resync(reason: string): Promise<void> {
    if (this.stopping) return
    this.emitStatus('syncing', `resync after ${reason}`)
    if (this.feed === 'synthetic' && this.synthetic) {
      this.engine.sync(this.synthetic.snapshot())
      this.emitStatus('live')
      return
    }
    if (this.ws) {
      // hard restart to re-chain the sequence ids
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }
    this.startLive()
  }

  // ------------------------------------------------------------------ posting

  private flushBatch(): void {
    if (this.pendingBids.length === 0 && this.pendingAsks.length === 0) return
    const bids = this.pendingBids
    const asks = this.pendingAsks
    this.pendingBids = []
    this.pendingAsks = []
    this.postMessage(bids, asks)
  }

  private postMessage(bids: [number, number][], asks: [number, number][]): void {
    if (!this.onBatch) return
    const bidBuf = pairsToF64(bids)
    const askBuf = pairsToF64(asks)
    this.batchesPosted++
    this.batchSeq = this.engine.sequence
    this.onBatch(
      Comlink.transfer({ bids: bidBuf, asks: askBuf, seq: this.batchSeq, ts: Date.now() }, [
        bidBuf.buffer,
        askBuf.buffer,
      ]) as OrderBookBatch,
    )
  }

  private emitStatus(status: StatusMessage['status'], detail?: string): void {
    this.onStatus?.({ status, detail })
  }

  private clearTimers(): void {
    if (this.postTimer) {
      clearInterval(this.postTimer)
      this.postTimer = null
    }
    if (this.syntheticTimer) {
      clearInterval(this.syntheticTimer)
      this.syntheticTimer = null
    }
  }
}

function pairsToF64(pairs: [number, number][]): Float64Array {
  const out = new Float64Array(pairs.length * 2)
  for (let i = 0; i < pairs.length; i++) {
    out[i * 2] = pairs[i]![0]
    out[i * 2 + 1] = pairs[i]![1]
  }
  return out
}

Comlink.expose(new OrderBookWorker())

export type { OrderBookWorkerApi }
