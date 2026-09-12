/**
 * Pure implementation of Binance's "diff depth stream" book management
 * protocol (https://binance-docs.github.io/apidocs/spot/en/#how-to-manage-a-local-order-book-correctly).
 *
 * Runs inside the Web Worker; no DOM or platform dependencies so it is
 * unit-testable in Node.
 */

export interface DepthEvent {
  /** first update id in event */
  U: number
  /** final update id in event */
  u: number
  /** final update id in last stream (ie 'pu' or 'pu' field) */
  pu: number
  bids: [price: number, qty: number][]
  asks: [price: number, qty: number][]
}

export interface DepthSnapshot {
  lastUpdateId: number
  bids: [price: number, qty: number][]
  asks: [price: number, qty: number][]
}

export interface ApplyResult {
  applied: boolean
  gap: boolean
}

export type LevelMap = Map<number, number>

export class DepthDiffEngine {
  readonly bids: LevelMap = new Map()
  readonly asks: LevelMap = new Map()
  private lastUpdateId = 0
  private lastFinalId = 0
  private synced = false
  private firstEvent = true
  private pending: DepthEvent[] = []
  private readonly maxPending: number

  onGap?: (reason: string) => void

  constructor(maxPending = 4096) {
    this.maxPending = maxPending
  }

  get isSynced(): boolean {
    return this.synced
  }

  get sequence(): number {
    return this.lastUpdateId
  }

  get pendingCount(): number {
    return this.pending.length
  }

  get depthSize(): number {
    return this.bids.size + this.asks.size
  }

  /** Buffer events that arrive before the REST snapshot lands. */
  buffer(evt: DepthEvent): void {
    this.pending.push(evt)
    if (this.pending.length > this.maxPending) {
      this.fail('pending-overflow')
    }
  }

  /** Apply the REST snapshot and replay buffered events per the spec. */
  sync(snapshot: DepthSnapshot): void {
    this.bids.clear()
    this.asks.clear()
    this.lastUpdateId = snapshot.lastUpdateId
    this.lastFinalId = snapshot.lastUpdateId
    this.firstEvent = true
    this.synced = true
    for (const [p, q] of snapshot.bids) {
      if (q > 0) this.bids.set(p, q)
    }
    for (const [p, q] of snapshot.asks) {
      if (q > 0) this.asks.set(p, q)
    }

    for (const evt of this.pending) {
      this.apply(evt)
    }
    this.pending.length = 0
  }

  /**
   * Apply one diff event. Follows the official rules:
   *  - drop when u <= lastUpdateId
   *  - the first event after the snapshot must bridge lastUpdateId+1
   *    (U <= lastUpdateId+1 <= u); its `pu` refers to the pre-snapshot
   *    stream and is therefore not validated
   *  - every later event must satisfy pu === previous u
   * Any violation resets the book and emits `onGap` (caller should resync).
   */
  apply(evt: DepthEvent): ApplyResult {
    if (!this.synced) {
      this.buffer(evt)
      return { applied: false, gap: false }
    }
    if (evt.u <= this.lastUpdateId) {
      return { applied: false, gap: false }
    }
    if (this.firstEvent) {
      if (!(evt.U <= this.lastUpdateId + 1 && evt.u >= this.lastUpdateId + 1)) {
        this.fail('sync-window-miss')
        return { applied: false, gap: true }
      }
      this.firstEvent = false
    } else if (evt.pu > 0 && evt.pu !== this.lastFinalId) {
      this.fail('sequence-gap')
      return { applied: false, gap: true }
    }
    for (const [price, qty] of evt.bids) {
      if (qty > 0) this.bids.set(price, qty)
      else this.bids.delete(price)
    }
    for (const [price, qty] of evt.asks) {
      if (qty > 0) this.asks.set(price, qty)
      else this.asks.delete(price)
    }
    this.lastUpdateId = evt.u
    this.lastFinalId = evt.u
    return { applied: true, gap: false }
  }

  reset(): void {
    this.bids.clear()
    this.asks.clear()
    this.pending.length = 0
    this.lastUpdateId = 0
    this.lastFinalId = 0
    this.firstEvent = true
    this.synced = false
  }

  private fail(reason: string): void {
    this.reset()
    this.onGap?.(reason)
  }
}
