import { useState, type CSSProperties } from 'react'
import type { BookSnapshot, ClientStats, FeedMode, FeedStatus, PooledRow } from '@orderbook/core'
import { useOrderbook } from './useOrderbook'

/**
 * ORDER BOOK MAIN COMPONENT — render plane only (React counterpart of the
 * Nuxt client's index.vue).
 *
 * Every high-frequency mechanism lives in `@orderbook/core`; this tree
 * only translates per-frame snapshots into DOM with the same discipline:
 *  - no component state touches book data (useSyncExternalStore only)
 *  - windowed lists: ~40 rows in the DOM for 1,200 levels
 *  - rows keyed by price, pooled in the core client (zero-alloc steady state)
 *  - passive scroll listeners + `contain: strict` on the tape scrollers
 */

const ROW_HEIGHT = 22
const LIST_HEIGHT = 420
const OVERSCAN = 8

const fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const STATUS_CLASSES: Record<FeedStatus, string> = {
  live: 'text-emerald-400 border-emerald-400',
  syncing: 'text-amber-400 border-amber-400',
  stalled: 'text-amber-400 border-amber-400',
  error: 'text-red-400 border-red-400',
  idle: 'text-zinc-500 border-zinc-700',
  closed: 'text-zinc-500 border-zinc-700',
}

// deep-linkable configuration, read once before the feed starts
function readQueryConfig(): { feed?: FeedMode; rate?: number } {
  const q = new URLSearchParams(window.location.search)
  const feed = q.get('feed')
  const rate = Number(q.get('rate'))
  return {
    feed: feed === 'live' || feed === 'synthetic' ? feed : undefined,
    rate: Number.isFinite(rate) && rate >= 1 && rate <= 1000 ? rate : undefined,
  }
}

function windowed(rows: PooledRow[], scrollTop: number): PooledRow[] {
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const visible = Math.ceil(LIST_HEIGHT / ROW_HEIGHT)
  const last = Math.min(rows.length, first + visible + OVERSCAN * 2)
  return rows.slice(first, last)
}

function offsetPx(scrollTop: number, count: number): number {
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  return Math.min(first, count) * ROW_HEIGHT
}

function depthWidth(row: PooledRow, max: number): string {
  return max > 0 ? `${Math.min(100, (row.t / max) * 100)}%` : '0%'
}

interface SideListProps {
  side: 'asks' | 'bids'
  snapshot: BookSnapshot
  selectedPrice: number
  onSelect: (price: number) => void
}

/**
 * The tape list. Deliberately NOT memoized on rows: the pooled row objects
 * are mutated in place by the core client, so shallow-compare memoization
 * would swallow updates — the correct invalidation signal is the snapshot
 * identity, which the parent re-renders on once per animation frame.
 */
function SideList({ side, snapshot, selectedPrice, onSelect }: SideListProps) {
  const [scrollTop, setScrollTop] = useState(0)
  const isAsk = side === 'asks'
  const rows = snapshot[side]
  const windowRows = windowed(rows, scrollTop)
  // asks render reversed (worst on top) so the best ask hugs the mid bar
  const ordered = isAsk ? [...windowRows].reverse() : windowRows
  const maxTotal = rows.at(-1)?.t ?? 0

  return (
    <div
      data-testid={isAsk ? 'asks-scroll' : 'bids-scroll'}
      className="ob-scroll relative overflow-y-auto overflow-x-hidden"
      style={{ height: `${LIST_HEIGHT}px` }}
      onScroll={(e) => setScrollTop((e.target as HTMLElement).scrollTop)}
    >
      <div className="relative" style={{ height: `${rows.length * ROW_HEIGHT}px` }}>
        <div
          className="ob-window absolute inset-x-0 top-0"
          style={{ transform: `translateY(${offsetPx(scrollTop, rows.length)}px)` }}
        >
          {ordered.map((row) => (
            <div
              key={row.p}
              data-testid="row"
              className={`ob-row relative grid h-[22px] cursor-pointer grid-cols-3 items-center px-2 font-mono text-xs tabular-nums hover:bg-white/5${
                selectedPrice === row.p ? ' ring-1 ring-inset ring-amber-400' : ''
              }`}
              style={{ '--flash-color': isAsk ? 'rgb(239 68 80 / 0.22)' : 'rgb(16 185 129 / 0.22)' } as CSSProperties}
              onClick={() => onSelect(row.p)}
            >
              <div
                className={`absolute inset-y-0 left-0 ${isAsk ? 'bg-red-500/10' : 'bg-emerald-500/10'}`}
                style={{ width: depthWidth(row, maxTotal) }}
                aria-hidden="true"
              />
              <span className={`absolute inset-0 ${row.d !== 0 ? 'ob-flash' : ''}`} aria-hidden="true" />
              <span
                data-testid="price"
                className={`relative text-left ${isAsk ? 'text-red-400' : 'text-emerald-400'}`}
              >
                {fmt.format(row.p)}
              </span>
              <span className="relative text-right">{fmt.format(row.q)}</span>
              <span className="relative text-right">{fmt.format(row.t)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function StatsBar({ stats }: { stats: ClientStats }) {
  return (
    <div
      data-testid="stats"
      className="mb-2 flex flex-wrap gap-x-3.5 gap-y-1 font-mono text-[11px] tabular-nums text-zinc-500"
    >
      <span>msgs {stats.messages.toLocaleString()}</span>
      <span>events {stats.events.toLocaleString()}</span>
      <span>seq {stats.seq.toLocaleString()}</span>
      <span>fps {stats.fps}</span>
      <span data-testid="levels">levels {stats.levels.toLocaleString()}</span>
      {stats.dropped > 0 && (
        <span data-testid="dropped" className="text-amber-400">
          dropped {stats.dropped}
        </span>
      )}
      {stats.resyncs > 0 && (
        <span data-testid="resyncs" className="text-amber-400">
          resyncs {stats.resyncs}
        </span>
      )}
    </div>
  )
}

export default function App() {
  const query = readQueryConfig()
  const [symbol, setSymbol] = useState('btcusdt')
  const [feedMode, setFeedMode] = useState<FeedMode>(query.feed ?? 'synthetic')
  const ratePerSec = query.rate ?? 10
  const [paused, setPaused] = useState(false)
  const [selectedPrice, setSelectedPrice] = useState(0)

  const { snapshot, status, stats } = useOrderbook({ symbol, mode: feedMode, ratePerSec, paused })

  const midLabel = snapshot.mid > 0 ? fmt.format(snapshot.mid) : '—'
  const spreadLabel = snapshot.spread > 0 ? fmt.format(snapshot.spread) : '—'
  const imbalancePct = snapshot.imbalance > 0 ? `${(snapshot.imbalance * 100).toFixed(1)}%` : '—'

  return (
    <main className="min-h-screen bg-[#0b0e14] px-3 py-6 font-sans">
      <section className="mx-auto max-w-2xl rounded-lg bg-[#131722] p-3 text-zinc-300">
        <header className="mb-2 flex flex-wrap items-center gap-3">
          <h1 className="text-sm font-semibold tracking-wide text-zinc-300">Order Book Render Engine — React</h1>
          <label className="flex items-center gap-1.5 text-xs text-zinc-500">
            <span>Symbol</span>
            <select
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              className="cursor-pointer rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
            >
              <option value="btcusdt">BTCUSDT</option>
              <option value="ethusdt">ETHUSDT</option>
              <option value="solusdt">SOLUSDT</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-zinc-500">
            <span>Feed</span>
            <select
              value={feedMode}
              data-testid="feed-select"
              onChange={(e) => setFeedMode(e.target.value as FeedMode)}
              className="cursor-pointer rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
            >
              <option value="synthetic">Synthetic</option>
              <option value="live">Binance live</option>
            </select>
          </label>
          <button
            data-testid="pause-btn"
            type="button"
            className="cursor-pointer rounded border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-600"
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <span
            data-testid="status"
            className={`ml-auto rounded-full border px-2.5 py-0.5 text-[11px] font-semibold tracking-widest ${STATUS_CLASSES[status]}`}
          >
            {status.toUpperCase()}
          </span>
        </header>

        <StatsBar stats={stats} />

        {/* asks: worst on top, best ask adjacent to the mid bar */}
        <div data-testid="asks-side">
          <div className="px-2 pb-0.5 text-[11px] font-semibold tracking-wide text-red-400">Asks</div>
          <SideList side="asks" snapshot={snapshot} selectedPrice={selectedPrice} onSelect={setSelectedPrice} />
        </div>

        <div data-testid="mid" className="my-1 border-y border-zinc-800 px-2 py-1.5">
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-base font-bold tabular-nums text-zinc-200">{midLabel}</span>
            <span className="font-mono text-[11px] tabular-nums text-zinc-500">spread {spreadLabel}</span>
          </div>
          {/* order-book imbalance gauge: bid-volume share of the window */}
          <div className="mt-1.5 flex items-center gap-2" data-testid="imbalance">
            <span className="font-mono text-[10px] uppercase tracking-widest text-emerald-400">bid</span>
            <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-red-500/25">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-emerald-500/60"
                style={{ width: imbalancePct === '—' ? '0%' : imbalancePct }}
              />
            </div>
            <span className="font-mono text-[10px] uppercase tracking-widest text-red-400">ask</span>
            <span className="w-12 text-right font-mono text-[11px] tabular-nums text-zinc-400">{imbalancePct}</span>
          </div>
        </div>

        {/* bids: best bid on top, descending */}
        <div data-testid="bids-side">
          <SideList side="bids" snapshot={snapshot} selectedPrice={selectedPrice} onSelect={setSelectedPrice} />
          <div className="px-2 pt-0.5 text-[11px] font-semibold tracking-wide text-emerald-400">Bids</div>
        </div>
      </section>
    </main>
  )
}
