<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import * as Comlink from 'comlink'
import { RingBuffer } from '~/lib/ring-buffer'
import { SyntheticFeed } from '~/lib/orderbook/synthetic'
import { ROW_STRIDE } from '~/lib/orderbook/frames'
import type { FeedStatus, WorkerApi } from '../../worker/orderbook.worker'

/**
 * ORDER BOOK MAIN COMPONENT — render plane only.
 *
 * WebSocket (raw frames)  ─►  RingBuffer (back-pressure boundary)
 *                                   │  rAF loop (display cadence)
 *                                   ▼
 *                     worker.ingestAndDrain(raws, 600)
 *                       parse + diff + sort   [WORKER]
 *                                   ▼
 *                     transferred Float64Arrays
 *                                   ▼
 *              pooled row objects → snapshot.value (shallowRef replace)
 *                                   ▼
 *                windowed v-for over raw HTML (Tailwind)
 *
 * - NO reactive state touches book data: the only signal is a shallowRef
 *   whose value is replaced (never mutated) exclusively inside rAF.
 * - The ring buffer decouples message arrival rate from render cadence:
 *   frames accumulate between animation frames and are batch-forwarded in
 *   one RPC; overflow (dropped > 0) breaks the worker's U/u/pu chain, which
 *   self-heals via a fresh snapshot resync.
 * - Teardown: one AbortController. onBeforeUnmount aborts; the abort
 *   listener explicitly closes the WebSocket, terminates the worker and
 *   cancels the animation frame — nothing survives unmount.
 */

const BINANCE_WS = 'wss://stream.binance.com:9443/ws'

const ROW_HEIGHT = 22
const LIST_HEIGHT = 420
const OVERSCAN = 8
const ROW_LIMIT = 600
const STATS_INTERVAL_MS = 500

// ------------------------------------------------------------------ UI state (never book data)

const symbol = ref('btcusdt')
const feedMode = ref<'live' | 'synthetic'>('synthetic')
const ratePerSec = ref(10)
const paused = ref(false)
const selectedPrice = ref(0)
const status = ref<FeedStatus>('idle')
const uiStats = ref({ messages: 0, events: 0, seq: 0, resyncs: 0, dropped: 0, fps: 0, levels: 0 })

// --------------------------------------------------------------- book state (shallowRef only)

interface PooledRow {
  p: number
  q: number
  t: number
  d: number
}

interface BookSnapshot {
  bids: PooledRow[]
  asks: PooledRow[]
  mid: number
  spread: number
}

const EMPTY_SNAPSHOT: BookSnapshot = { bids: [], asks: [], mid: 0, spread: 0 }

/** the single reactive boundary for book data — value replaced in rAF only */
const snapshot = shallowRef<BookSnapshot>(EMPTY_SNAPSHOT)

// row pools: mutated in place so steady-state rendering allocates nothing
const bidPool: PooledRow[] = []
const askPool: PooledRow[] = []

// --------------------------------------------------------------------- feed plumbing

const ring = new RingBuffer<string>(512)

let worker: Worker | null = null
let api: Comlink.Remote<WorkerApi> | null = null
let ws: WebSocket | null = null
let synthetic: SyntheticFeed | null = null
let syntheticTimer: ReturnType<typeof setInterval> | null = null
let rafId = 0
let pulling = false
let frames = 0
let fpsWindowStart = 0
let fps = 0
let lastStatsAt = 0

// deep-linkable configuration, resolved synchronously in setup so the
// change watchers below never race the initial connect()
if (import.meta.client) {
  const q = new URLSearchParams(window.location.search)
  const feed = q.get('feed')
  if (feed === 'live' || feed === 'synthetic') feedMode.value = feed
  const rate = Number(q.get('rate'))
  if (Number.isFinite(rate) && rate >= 1 && rate <= 1000) ratePerSec.value = rate
}

// -------------------------------------------------------------------- abort lifecycle

const abort = new AbortController()

onBeforeUnmount(() => abort.abort())

abort.signal.addEventListener(
  'abort',
  () => {
    // explicit, ordered teardown — no orphaned socket, worker or rAF loop
    cancelAnimationFrame(rafId)
    rafId = 0
    closeSocket()
    if (syntheticTimer) {
      clearInterval(syntheticTimer)
      syntheticTimer = null
    }
    synthetic = null
    if (api) void api.stop().catch(() => {})
    worker?.terminate()
    worker = null
    api = null
    ring.clear()
    snapshot.value = EMPTY_SNAPSHOT
  },
  { once: true },
)

// ---------------------------------------------------------------------- worker + feeds

async function connect(): Promise<void> {
  if (abort.signal.aborted) return
  await api?.start(symbol.value, feedMode.value).catch(() => {})
  if (abort.signal.aborted) return
  if (feedMode.value === 'live') {
    openLiveSocket()
  } else {
    startSyntheticFeed()
  }
}

function openLiveSocket(): void {
  closeSocket()
  const socket = new WebSocket(`${BINANCE_WS}/${symbol.value}@depth@100ms`)
  ws = socket
  socket.onmessage = (ev: MessageEvent) => {
    // raw payload forwarded untouched — parsing happens in the worker
    ring.push(String(ev.data))
  }
  socket.onerror = () => {
    if (!abort.signal.aborted) status.value = 'error'
  }
  socket.onclose = () => {
    if (abort.signal.aborted || feedMode.value !== 'live') return
    // reconnect with a fresh snapshot; the worker's chain check self-heals
    setTimeout(() => {
      if (!abort.signal.aborted && feedMode.value === 'live') void connect()
    }, 2000)
  }
}

function startSyntheticFeed(): void {
  stopSyntheticFeed()
  const feed = new SyntheticFeed(symbol.value, ratePerSec.value)
  synthetic = feed
  ring.push(feed.snapshotRaw())
  syntheticTimer = setInterval(() => ring.push(feed.nextRaw()), feed.intervalMs)
}

function stopSyntheticFeed(): void {
  if (syntheticTimer) {
    clearInterval(syntheticTimer)
    syntheticTimer = null
  }
  synthetic = null
}

function closeSocket(): void {
  if (ws) {
    ws.onopen = null
    ws.onmessage = null
    ws.onerror = null
    ws.onclose = null
    ws.close(1000)
    ws = null
  }
}

/** soft restart when symbol/feed changes (worker reused, socket rebuilt) */
async function restartFeeds(): Promise<void> {
  if (abort.signal.aborted) return
  closeSocket()
  stopSyntheticFeed()
  ring.clear()
  snapshot.value = EMPTY_SNAPSHOT
  await connect()
}

/** synthetic chain broke (e.g. ring overflow) — begin a fresh generator session */
function restartSyntheticSession(): void {
  if (!synthetic) return
  ring.clear()
  ring.push(synthetic.snapshotRaw())
}

// ---------------------------------------------------------------------- rAF render loop

function frame(now: number): void {
  rafId = requestAnimationFrame(frame)
  frames++
  if (now - fpsWindowStart >= 1000) {
    fps = Math.round((frames * 1000) / (now - fpsWindowStart))
    frames = 0
    fpsWindowStart = now
  }
  if (!pulling && api) void pull()
}

async function pull(): Promise<void> {
  pulling = true
  try {
    const raws: string[] = []
    ring.drain((r) => raws.push(r))
    const res = await api!.ingestAndDrain(raws, ROW_LIMIT)
    if (abort.signal.aborted) return

    if (res.status === 'stalled') restartSyntheticSession()
    status.value = res.status

    if (!paused.value && (res.bids.length > 0 || res.asks.length > 0)) {
      copyRows(res.bids, bidPool)
      copyRows(res.asks, askPool)
      // replace (never mutate) — the one write that can trigger a re-render
      snapshot.value = {
        bids: bidPool,
        asks: askPool,
        mid: res.mid,
        spread: res.spread,
      }
    }

    const now = performance.now()
    if (now - lastStatsAt >= STATS_INTERVAL_MS) {
      lastStatsAt = now
      uiStats.value = {
        messages: res.messages,
        events: res.appliedEvents,
        seq: res.seq,
        resyncs: res.resyncs,
        dropped: ring.dropped,
        fps,
        levels: (res.bids.length + res.asks.length) / ROW_STRIDE,
      }
    }
  } catch {
    // worker torn down mid-call during unmount — nothing to do
  } finally {
    pulling = false
  }
}

function copyRows(flat: Float64Array, pool: PooledRow[]): void {
  const n = flat.length / ROW_STRIDE
  for (let i = 0; i < n; i++) {
    const o = i * ROW_STRIDE
    const row = pool[i]
    if (row) {
      row.p = flat[o]!
      row.q = flat[o + 1]!
      row.t = flat[o + 2]!
      row.d = flat[o + 3]!
    } else {
      pool[i] = { p: flat[o]!, q: flat[o + 1]!, t: flat[o + 2]!, d: flat[o + 3]! }
    }
  }
  pool.length = n
}

// ------------------------------------------------------------------------- virtualization

const scrollTopBids = ref(0)
const scrollTopAsks = ref(0)

function windowed(rows: PooledRow[], scrollTop: number): PooledRow[] {
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const visible = Math.ceil(LIST_HEIGHT / ROW_HEIGHT)
  const last = Math.min(rows.length, first + visible + OVERSCAN * 2)
  return rows.slice(first, last)
}

const bidWindow = computed(() => windowed(snapshot.value.bids, scrollTopBids.value))
/** asks render reversed (worst on top) so the best ask hugs the mid bar */
const askWindow = computed(() => windowed(snapshot.value.asks, scrollTopAsks.value).reverse())

const bidSpacer = computed(() => `${snapshot.value.bids.length * ROW_HEIGHT}px`)
const askSpacer = computed(() => `${snapshot.value.asks.length * ROW_HEIGHT}px`)

function translateYpx(scrollTop: number, count: number): string {
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  return `${Math.min(first, count) * ROW_HEIGHT}px`
}

const bidOffset = computed(() => translateYpx(scrollTopBids.value, snapshot.value.bids.length))
const askOffset = computed(() => translateYpx(scrollTopAsks.value, snapshot.value.asks.length))

const maxBidTotal = computed(() => snapshot.value.bids.at(-1)?.t ?? 0)
const maxAskTotal = computed(() => snapshot.value.asks.at(-1)?.t ?? 0)

const fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const midLabel = computed(() => (snapshot.value.mid > 0 ? fmt.format(snapshot.value.mid) : '—'))
const spreadLabel = computed(() => (snapshot.value.spread > 0 ? fmt.format(snapshot.value.spread) : '—'))

const STATUS_CLASSES: Record<FeedStatus, string> = {
  live: 'text-emerald-400 border-emerald-400',
  syncing: 'text-amber-400 border-amber-400',
  stalled: 'text-amber-400 border-amber-400',
  error: 'text-red-400 border-red-400',
  idle: 'text-zinc-500 border-zinc-700',
  closed: 'text-zinc-500 border-zinc-700',
}
const statusClass = computed(() => STATUS_CLASSES[status.value])

function depthWidth(row: PooledRow, max: number): string {
  return max > 0 ? `${Math.min(100, (row.t / max) * 100)}%` : '0%'
}

// ------------------------------------------------------------------------- lifecycle

onMounted(() => {
  worker = new Worker(new URL('../../worker/orderbook.worker.ts', import.meta.url), {
    type: 'module',
    name: 'orderbook',
  })
  api = Comlink.wrap<WorkerApi>(worker)
  fpsWindowStart = performance.now()
  rafId = requestAnimationFrame(frame)
  void connect()
})

watch([symbol, feedMode], () => void restartFeeds())
watch(ratePerSec, () => {
  if (feedMode.value === 'synthetic' && !abort.signal.aborted) startSyntheticFeed()
})
</script>

<template>
  <main class="min-h-screen bg-[#0b0e14] px-3 py-6 font-sans">
    <section class="mx-auto max-w-2xl rounded-lg bg-[#131722] p-3 text-zinc-300">
      <header class="mb-2 flex flex-wrap items-center gap-3">
        <h1 class="text-sm font-semibold tracking-wide text-zinc-300">Order Book Render Engine</h1>
        <label class="flex items-center gap-1.5 text-xs text-zinc-500">
          <span>Symbol</span>
          <select
            v-model="symbol"
            class="cursor-pointer rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
          >
            <option value="btcusdt">BTCUSDT</option>
            <option value="ethusdt">ETHUSDT</option>
            <option value="solusdt">SOLUSDT</option>
          </select>
        </label>
        <label class="flex items-center gap-1.5 text-xs text-zinc-500">
          <span>Feed</span>
          <select
            v-model="feedMode"
            data-testid="feed-select"
            class="cursor-pointer rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
          >
            <option value="synthetic">Synthetic</option>
            <option value="live">Binance live</option>
          </select>
        </label>
        <button
          data-testid="pause-btn"
          type="button"
          class="cursor-pointer rounded border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-600"
          @click="paused = !paused"
        >
          {{ paused ? 'Resume' : 'Pause' }}
        </button>
        <span
          data-testid="status"
          class="ml-auto rounded-full border px-2.5 py-0.5 text-[11px] font-semibold tracking-widest"
          :class="statusClass"
        >
          {{ status.toUpperCase() }}
        </span>
      </header>

      <div
        data-testid="stats"
        class="mb-2 flex flex-wrap gap-x-3.5 gap-y-1 font-mono text-[11px] tabular-nums text-zinc-500"
      >
        <span>msgs {{ uiStats.messages.toLocaleString() }}</span>
        <span>events {{ uiStats.events.toLocaleString() }}</span>
        <span>seq {{ uiStats.seq.toLocaleString() }}</span>
        <span>fps {{ uiStats.fps }}</span>
        <span data-testid="levels">levels {{ uiStats.levels.toLocaleString() }}</span>
        <span v-if="uiStats.dropped > 0" data-testid="dropped" class="text-amber-400">
          dropped {{ uiStats.dropped }}
        </span>
        <span v-if="uiStats.resyncs > 0" data-testid="resyncs" class="text-amber-400">
          resyncs {{ uiStats.resyncs }}
        </span>
      </div>

      <!-- asks: worst on top, best ask adjacent to the mid bar -->
      <div data-testid="asks-side">
        <div class="px-2 pb-0.5 text-[11px] font-semibold tracking-wide text-red-400">Asks</div>
        <div
          data-testid="asks-scroll"
          class="ob-scroll relative overflow-y-auto overflow-x-hidden"
          :style="{ height: `${LIST_HEIGHT}px` }"
          @scroll.passive="scrollTopAsks = ($event.target as HTMLElement).scrollTop"
        >
          <div :style="{ height: askSpacer }" class="relative">
            <div class="ob-window absolute inset-x-0 top-0" :style="{ transform: `translateY(${askOffset})` }">
              <div
                v-for="row in askWindow"
                :key="row.p"
                data-testid="row"
                class="relative grid h-[22px] cursor-pointer grid-cols-3 items-center px-2 font-mono text-xs tabular-nums hover:bg-white/5"
                :class="selectedPrice === row.p ? 'ring-1 ring-inset ring-amber-400' : ''"
                :style="{ '--flash-color': 'rgb(239 68 80 / 0.22)' }"
                @click="selectedPrice = row.p"
              >
                <div
                  class="absolute inset-y-0 left-0 bg-red-500/10"
                  :style="{ width: depthWidth(row, maxAskTotal) }"
                  aria-hidden="true"
                />
                <span
                  class="absolute inset-0"
                  :class="row.d !== 0 ? 'ob-flash' : ''"
                  aria-hidden="true"
                />
                <span data-testid="price" class="relative text-left text-red-400">{{ fmt.format(row.p) }}</span>
                <span class="relative text-right">{{ fmt.format(row.q) }}</span>
                <span class="relative text-right">{{ fmt.format(row.t) }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        data-testid="mid"
        class="my-1 flex items-baseline justify-between border-y border-zinc-800 px-2 py-1.5"
      >
        <span class="font-mono text-base font-bold tabular-nums text-zinc-200">{{ midLabel }}</span>
        <span class="font-mono text-[11px] tabular-nums text-zinc-500">spread {{ spreadLabel }}</span>
      </div>

      <!-- bids: best bid on top, descending -->
      <div data-testid="bids-side">
        <div
          data-testid="bids-scroll"
          class="ob-scroll relative overflow-y-auto overflow-x-hidden"
          :style="{ height: `${LIST_HEIGHT}px` }"
          @scroll.passive="scrollTopBids = ($event.target as HTMLElement).scrollTop"
        >
          <div :style="{ height: bidSpacer }" class="relative">
            <div class="ob-window absolute inset-x-0 top-0" :style="{ transform: `translateY(${bidOffset})` }">
              <div
                v-for="row in bidWindow"
                :key="row.p"
                data-testid="row"
                class="relative grid h-[22px] cursor-pointer grid-cols-3 items-center px-2 font-mono text-xs tabular-nums hover:bg-white/5"
                :class="selectedPrice === row.p ? 'ring-1 ring-inset ring-amber-400' : ''"
                :style="{ '--flash-color': 'rgb(16 185 129 / 0.22)' }"
                @click="selectedPrice = row.p"
              >
                <div
                  class="absolute inset-y-0 left-0 bg-emerald-500/10"
                  :style="{ width: depthWidth(row, maxBidTotal) }"
                  aria-hidden="true"
                />
                <span
                  class="absolute inset-0"
                  :class="row.d !== 0 ? 'ob-flash' : ''"
                  aria-hidden="true"
                />
                <span data-testid="price" class="relative text-left text-emerald-400">{{ fmt.format(row.p) }}</span>
                <span class="relative text-right">{{ fmt.format(row.q) }}</span>
                <span class="relative text-right">{{ fmt.format(row.t) }}</span>
              </div>
            </div>
          </div>
        </div>
        <div class="px-2 pt-0.5 text-[11px] font-semibold tracking-wide text-emerald-400">Bids</div>
      </div>
    </section>
  </main>
</template>
