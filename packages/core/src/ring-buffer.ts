/**
 * Fixed-capacity ring buffer for aggregating high-frequency batches.
 *
 * Write is allocation-free after construction; the oldest slot is overwritten
 * when the buffer is full (back-pressure policy: newest data wins). The render
 * loop drains the buffer once per animation frame.
 */
export class RingBuffer<T> {
  private readonly buf: Array<T | undefined>
  private head = 0
  private tail = 0
  private _size = 0
  private _dropped = 0

  constructor(readonly capacity: number) {
    if (capacity <= 0 || (capacity & (capacity - 1)) !== 0) {
      throw new Error('RingBuffer capacity must be a positive power of two')
    }
    this.buf = new Array<T | undefined>(capacity)
  }

  get size(): number {
    return this._size
  }

  get dropped(): number {
    return this._dropped
  }

  get full(): boolean {
    return this._size === this.capacity
  }

  push(item: T): void {
    if (this.full) {
      this._dropped++
      this.tail = (this.tail + 1) & (this.capacity - 1)
      this._size--
    }
    this.buf[this.head] = item
    this.head = (this.head + 1) & (this.capacity - 1)
    this._size++
  }

  /** Invokes `fn` for each item in FIFO order, then clears the buffer. */
  drain(fn: (item: T) => void): number {
    let n = 0
    while (this._size > 0) {
      const item = this.buf[this.tail]
      this.buf[this.tail] = undefined
      this.tail = (this.tail + 1) & (this.capacity - 1)
      this._size--
      if (item !== undefined) {
        fn(item)
        n++
      }
    }
    return n
  }

  clear(): void {
    this.buf.fill(undefined)
    this.head = 0
    this.tail = 0
    this._size = 0
    this._dropped = 0
  }
}
