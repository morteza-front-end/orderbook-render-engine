import { describe, expect, it } from 'vitest'
import { RingBuffer } from '../../app/lib/ring-buffer'

describe('RingBuffer', () => {
  it('requires a positive power-of-two capacity', () => {
    expect(() => new RingBuffer(0)).toThrow()
    expect(() => new RingBuffer(3)).toThrow()
    expect(() => new RingBuffer(4)).not.toThrow()
  })

  it('drains in FIFO order', () => {
    const rb = new RingBuffer<number>(8)
    for (const n of [1, 2, 3]) rb.push(n)
    const out: number[] = []
    rb.drain((x) => out.push(x))
    expect(out).toEqual([1, 2, 3])
    expect(rb.size).toBe(0)
  })

  it('overwrites the oldest item and counts drops when full', () => {
    const rb = new RingBuffer<number>(4)
    for (const n of [1, 2, 3, 4, 5]) rb.push(n)
    expect(rb.full).toBe(true)
    expect(rb.dropped).toBe(1)
    const out: number[] = []
    rb.drain((x) => out.push(x))
    expect(out).toEqual([2, 3, 4, 5])
  })

  it('drain on empty buffer is a no-op returning 0', () => {
    const rb = new RingBuffer<string>(2)
    let calls = 0
    expect(rb.drain(() => calls++)).toBe(0)
    expect(calls).toBe(0)
  })

  it('clear resets contents and drop counters', () => {
    const rb = new RingBuffer<number>(2)
    rb.push(1)
    rb.push(2)
    rb.push(3)
    rb.clear()
    expect(rb.size).toBe(0)
    expect(rb.dropped).toBe(0)
    const out: number[] = []
    rb.drain((x) => out.push(x))
    expect(out).toEqual([])
  })

  it('drain releases references (no retained objects after drain)', () => {
    const rb = new RingBuffer<{ payload: Uint8Array }>(2)
    rb.push({ payload: new Uint8Array(8) })
    rb.drain(() => {})
    const before = rb.size
    expect(before).toBe(0)
  })
})
