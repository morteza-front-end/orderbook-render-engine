/// <reference lib="webworker" />
import * as Comlink from 'comlink'
import { DepthDiffEngine } from '../app/lib/orderbook/depth-diff'
import { buildView, parseFrame } from '../app/lib/orderbook/frames'

/**
 * ORDER BOOK WORKER — the entire data plane except the socket transport.
 *
 * Responsibilities (all off the main thread):
 *  - parsing raw Binance depth frames (REST snapshot + WS diff events)
 *  - sequence validation and delta merging into the local book
 *    (see DepthDiffEngine for the U/u/pu protocol rules)
 *  - sorting best-first, cumulative totals, flash flags
 *  - packing windowed Float64Arrays and TRANSFERRING them (zero copy) to
 *    the render loop, which only maps them into pooled DOM rows
 *
 * The main thread owns the WebSocket so teardown can close it explicitly;
 * raw frames are forwarded here unparsed. The main thread pulls state at
 * its own cadence (requestAnimationFrame) via `ingestAndDrain`, which
 * decouples message arrival rate from render rate.
 */

export type FeedMode = 'live' | 'synthetic'

export type FeedStatus =
  | 'idle'
  | 'syncing'
  | 'live'
  | 'stalled'
  | 'error'
  | 'closed'

export interface DrainResult {
  /** flat [price, qty, cumulativeTotal, dir] * rows, bids best-first (desc) */
  bids: Float64Array
  /** flat [price, qty, cumulativeTotal, dir] * rows, asks best-first (asc) */
  asks: Float64Array
  mid: number
  spread: number
  seq: number
  status: FeedStatus
  messages: number
  appliedEvents: number
  resyncs: number
}

export interface WorkerApi {
  /** reset the book and (live mode) begin fetching a fresh REST snapshot */
  start(symbol: string, mode: FeedMode): Promise<void>
  /** apply buffered raw frames, then return the current rendered view */
  ingestAndDrain(raws: string[], rowLimit: number): Promise<DrainResult>
  stop(): Promise<void>
}

const BINANCE_REST = 'https://api.binance.com/api/v3/depth'

class OrderBookWorker implements WorkerApi {
  private readonly engine = new DepthDiffEngine()
  private readonly prevBidQty = new Map<number, number>()
  private readonly prevAskQty = new Map<number, number>()
  private symbol = ''
  private mode: FeedMode = 'live'
  private session = 0
  private messages = 0
  private appliedEvents = 0
  private resyncs = 0
  private status: FeedStatus = 'idle'
  private detail = ''
  private malformed = 0

  constructor() {
    // any sequence violation resets the book; a fresh snapshot is fetched
    // (live) or the synthetic host is asked to restart its session (stalled)
    this.engine.onGap = () => this.resync('sequence-gap')
  }

  async start(symbol: string, mode: FeedMode): Promise<void> {
    this.session++
    this.symbol = symbol.toLowerCase()
    this.mode = mode
    this.messages = 0
    this.appliedEvents = 0
    this.resyncs = 0
    this.malformed = 0
    this.detail = ''
    this.engine.reset()
    this.prevBidQty.clear()
    this.prevAskQty.clear()
    this.status = 'syncing'
    if (mode === 'live') await this.fetchSnapshot()
  }

  async ingestAndDrain(raws: string[], rowLimit: number): Promise<DrainResult> {
    for (const raw of raws) {
      this.ingestOne(raw)
    }
    const view = buildView(this.engine.bids, this.engine.asks, this.prevBidQty, this.prevAskQty, rowLimit)
    const result: DrainResult = {
      bids: view.bids,
      asks: view.asks,
      mid: view.mid,
      spread: view.spread,
      seq: this.engine.sequence,
      status: this.status,
      messages: this.messages,
      appliedEvents: this.appliedEvents,
      resyncs: this.resyncs,
    }
    return Comlink.transfer(result, [view.bids.buffer, view.asks.buffer])
  }

  async stop(): Promise<void> {
    this.session++
    this.engine.reset()
    this.prevBidQty.clear()
    this.prevAskQty.clear()
    this.status = 'closed'
  }

  // ------------------------------------------------------------------ ingest

  private ingestOne(raw: string): void {
    this.messages++
    const frame = parseFrame(raw)
    if (frame === null) {
      this.malformed++
      return
    }
    if (frame.kind === 'snapshot') {
      this.engine.sync(frame.snapshot)
      this.status = 'live'
      return
    }
    const { applied } = this.engine.apply(frame.event)
    if (applied) this.appliedEvents++
  }

  private resync(reason: string): void {
    this.resyncs++
    this.detail = reason
    if (this.mode === 'live') {
      this.status = 'syncing'
      void this.fetchSnapshot()
    } else {
      // synthetic: the main thread sees `stalled` in the next drain result
      // and restarts its generator session (fresh snapshot frame)
      this.status = 'stalled'
    }
  }

  private async fetchSnapshot(): Promise<void> {
    const session = this.session
    try {
      const res = await fetch(`${BINANCE_REST}?symbol=${this.symbol.toUpperCase()}&limit=1000`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const raw = await res.text()
      if (session !== this.session) return // superseded by start()/stop()
      this.ingestOne(raw)
    } catch (err) {
      if (session !== this.session) return
      this.status = 'error'
      this.detail = String(err)
    }
  }
}

Comlink.expose(new OrderBookWorker())

export type { OrderBookWorker }
