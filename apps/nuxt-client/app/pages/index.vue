<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { OrderbookClient, type BookSnapshot, type ClientStats, type FeedMode, type FeedStatus } from '@orderbook/core'

/**
 * ORDER BOOK MAIN COMPONENT — render plane only.
 *
 * Every high-frequency mechanism now lives in `@orderbook/core`:
 * WebSocket/synthetic transport, the ring buffer back-pressure boundary,
 * the Comlink worker data plane and the rAF drain loop. This component
 * only translates snapshots into DOM:
 *
 *   core OrderbookClient  ─►  snapshot.value = {...} (shallowRef replace,
 *                              once per animation frame — still the single
 *                              reactive boundary, never mutated in place)
 *                          ─►  windowed v-for over raw HTML (Tailwind)
 *
 * - NO reactive state touches book data: the only signal is a shallowRef
 *   whose value is replaced exclusively from the client's rAF-aligned
 *   listener callback.
 * - Teardown: `client.stop()` deterministically releases the socket,
 *   worker heap, rAF loop, ring buffer and row pools.
 */

const ROW_HEIGHT = 22
const LIST_HEIGHT = 420
const OVERSCAN = 8

// ------------------------------------------------------------------ UI state (never book data)

const symbol = ref('btcusdt')
const feedMode = ref<FeedMode>('synthetic')
const ratePerSec = ref(10)
const paused = ref(false)
const selectedPrice = ref(0)
const status = ref<FeedStatus>('idle')
const uiStats = ref<ClientStats>({
  messages: 0,
  events: 0,
  seq: 0,
  resyncs: 0,
  dropped: 0,
  fps: 0,
  levels: 0,
  imbalance: 0.5,
})

// --------------------------------------------------------------- book state (shallowRef only)

const EMPTY_SNAPSHOT: BookSnapshot = { version: 0, bids: [], asks: [], mid: 0, spread: 0, imbalance: 0 }

/** the single reactive boundary for book data — value replaced in rAF only */
const snapshot = shallowRef<BookSnapshot>(EMPTY_SNAPSHOT)

let client: OrderbookClient | null = null

// deep-linkable configuration, resolved synchronously in setup so the
// change watchers below never race the initial start()
if (import.meta.client) {
  const q = new URLSearchParams(window.location.search)
  const feed = q.get('feed')
  if (feed === 'live' || feed === 'synthetic') feedMode.value = feed
  const rate = Number(q.get('rate'))
  if (Number.isFinite(rate) && rate >= 1 && rate <= 1000) ratePerSec.value = rate
}

// ------------------------------------------------------------------------ lifecycle

onMounted(() => {
  client = new OrderbookClient({
    symbol: symbol.value,
    mode: feedMode.value,
    ratePerSec: ratePerSec.value,
    workerFactory: () =>
      new Worker(new URL('../../worker/orderbook.worker.ts', import.meta.url), {
        type: 'module',
        name: 'orderbook',
      }),
    onStatus: (s) => {
      status.value = s
    },
    onStats: (s) => {
      uiStats.value = s
    },
  })
  client.subscribe(() => {
    // replace (never mutate) — the one write that can trigger a re-render
    snapshot.value = client!.getSnapshot()
  })
  client.start()
})

onBeforeUnmount(() => {
  client?.stop()
  client = null
  snapshot.value = EMPTY_SNAPSHOT
})

// soft restart when symbol/feed changes (worker reused, transport rebuilt)
watch([symbol, feedMode], () => client?.restart({ symbol: symbol.value, mode: feedMode.value }))
watch(ratePerSec, () => {
  if (feedMode.value === 'synthetic') client?.restart({ ratePerSec: ratePerSec.value })
})
watch(paused, (p) => client?.setPaused(p))

// ------------------------------------------------------------------------- virtualization

const scrollTopBids = ref(0)
const scrollTopAsks = ref(0)

function windowed(rows: BookSnapshot['bids'], scrollTop: number) {
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

/** bid-volume share of the rendered window, as a percentage string */
const imbalancePct = computed(() =>
  snapshot.value.imbalance > 0 ? `${(snapshot.value.imbalance * 100).toFixed(1)}%` : '—',
)

const STATUS_CLASSES: Record<FeedStatus, string> = {
  live: 'text-emerald-400 border-emerald-400',
  syncing: 'text-amber-400 border-amber-400',
  stalled: 'text-amber-400 border-amber-400',
  error: 'text-red-400 border-red-400',
  idle: 'text-zinc-500 border-zinc-700',
  closed: 'text-zinc-500 border-zinc-700',
}
const statusClass = computed(() => STATUS_CLASSES[status.value])

function depthWidth(row: BookSnapshot['bids'][number], max: number): string {
  return max > 0 ? `${Math.min(100, (row.t / max) * 100)}%` : '0%'
}
</script>

<template>
  <main class="min-h-screen bg-[#0b0e14] px-3 py-6 font-sans">
    <section class="mx-auto max-w-2xl rounded-lg bg-[#131722] p-3 text-zinc-300">
      <header class="mb-2 flex flex-wrap items-center gap-3">
        <h1 class="text-sm font-semibold tracking-wide text-zinc-300">Order Book Render Engine — Nuxt</h1>
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
                class="ob-row relative grid h-[22px] cursor-pointer grid-cols-3 items-center px-2 font-mono text-xs tabular-nums hover:bg-white/5"
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
        class="my-1 border-y border-zinc-800 px-2 py-1.5"
      >
        <div class="flex items-baseline justify-between">
          <span class="font-mono text-base font-bold tabular-nums text-zinc-200">{{ midLabel }}</span>
          <span class="font-mono text-[11px] tabular-nums text-zinc-500">spread {{ spreadLabel }}</span>
        </div>
        <!-- order-book imbalance gauge: bid-volume share of the window -->
        <div class="mt-1.5 flex items-center gap-2" data-testid="imbalance">
          <span class="font-mono text-[10px] uppercase tracking-widest text-emerald-400">bid</span>
          <div class="relative h-1.5 flex-1 overflow-hidden rounded-full bg-red-500/25">
            <div
              class="absolute inset-y-0 left-0 rounded-full bg-emerald-500/60"
              :style="{ width: imbalancePct === '—' ? '0%' : imbalancePct }"
            />
          </div>
          <span class="font-mono text-[10px] uppercase tracking-widest text-red-400">ask</span>
          <span class="w-12 text-right font-mono text-[11px] tabular-nums text-zinc-400">{{ imbalancePct }}</span>
        </div>
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
                class="ob-row relative grid h-[22px] cursor-pointer grid-cols-3 items-center px-2 font-mono text-xs tabular-nums hover:bg-white/5"
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
