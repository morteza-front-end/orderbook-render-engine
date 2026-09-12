<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useSessionStore } from '../stores/session'
import { useOrderbookFeed } from '../composables/useOrderbookFeed'
import VirtualList from './VirtualList.vue'
import DepthRow from './DepthRow.vue'

/**
 * Renders the aggregated order book view produced by the rAF render loop.
 * Rows come from a shallowRef that is replaced (never mutated), and each side
 * is a virtualized list, so DOM size stays constant while the book holds 500+.
 */
const ROW_HEIGHT = 22
const LIST_HEIGHT = 420

const session = useSessionStore()
const feed = useOrderbookFeed()

const view = feed.view

const maxBidTotal = computed(() => view.value.bids.at(-1)?.total ?? 0)
const maxAskTotal = computed(() => view.value.asks.at(-1)?.total ?? 0)

const fmt2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const mid = computed(() => (view.value.mid > 0 ? fmt2.format(view.value.mid) : '—'))
const spread = computed(() => (view.value.spread > 0 ? fmt2.format(view.value.spread) : '—'))

// deep-linkable configuration: /?feed=synthetic&rate=100
// the feed only starts in the browser (Web Worker data plane, no SSR)
onMounted(() => {
  const q = new URLSearchParams(window.location.search)
  const feedParam = q.get('feed')
  if (feedParam === 'live' || feedParam === 'synthetic') session.setFeed(feedParam)
  const rate = Number(q.get('rate'))
  if (Number.isFinite(rate) && rate >= 1 && rate <= 1000) session.rate = rate
  void feed.start()
})

// user intent -> engine (both directions wired through stores/composable)
watch(
  () => [session.symbol, session.feed, session.rate] as const,
  ([symbol, f, rate]) => {
    void feed.restart({ symbol, feed: f, ratePerSec: rate })
  },
)

watch(
  () => session.paused,
  (p) => feed.setPaused(p),
)

function onRowClick(price: number): void {
  session.select(price)
}
</script>

<template>
  <section class="panel" aria-label="Order book">
    <header class="panel-head">
      <label class="ctl">
        <span>Symbol</span>
        <select :value="session.symbol" @change="session.setSymbol(($event.target as HTMLSelectElement).value)">
          <option value="btcusdt">BTCUSDT</option>
          <option value="ethusdt">ETHUSDT</option>
          <option value="solusdt">SOLUSDT</option>
        </select>
      </label>
      <label class="ctl">
        <span>Feed</span>
        <select
          :value="session.feed"
          data-testid="feed-select"
          @change="session.setFeed(($event.target as HTMLSelectElement).value as 'live' | 'synthetic')"
        >
          <option value="synthetic">Synthetic</option>
          <option value="live">Binance live</option>
        </select>
      </label>
      <button
        class="ctl btn"
        data-testid="pause-btn"
        type="button"
        @click="session.togglePause()"
      >
        {{ session.paused ? 'Resume' : 'Pause' }}
      </button>
      <span class="status" :class="session.status" data-testid="status">
        {{ session.statusLabel }}
      </span>
    </header>

    <div class="stats" data-testid="stats">
      <span>msgs {{ session.stats.messages.toLocaleString() }}</span>
      <span>events {{ session.stats.appliedEvents.toLocaleString() }}</span>
      <span>seq {{ session.stats.seq.toLocaleString() }}</span>
      <span>fps {{ session.stats.fps }}</span>
      <span
        data-testid="levels"
      >levels {{ view.bids.length + view.asks.length }}</span>
      <span
        v-if="session.stats.droppedBatches > 0"
        data-testid="dropped"
      >dropped {{ session.stats.droppedBatches }}</span>
      <span v-if="session.stats.resyncs > 0" data-testid="resyncs">resyncs {{ session.stats.resyncs }}</span>
    </div>

    <div class="lists">
      <div class="side" data-testid="asks-side">
        <div class="side-title ask">Asks</div>
        <!-- asks scroll reversed so the best ask sits next to the mid -->
        <VirtualList
          :rows="view.asks"
          :row-height="ROW_HEIGHT"
          :height="LIST_HEIGHT"
          :reversed="true"
          @row-click="onRowClick"
        >
          <template #default="{ row }">
            <DepthRow
              :row="row"
              side="ask"
              :max-total="maxAskTotal"
              :selected="session.selectedPrice === row.price"
            />
          </template>
        </VirtualList>
      </div>

      <div class="mid" data-testid="mid">
        <span class="mid-price">{{ mid }}</span>
        <span class="mid-spread">spread {{ spread }}</span>
      </div>

      <div class="side" data-testid="bids-side">
        <div class="side-title bid">Bids</div>
        <VirtualList
          :rows="view.bids"
          :row-height="ROW_HEIGHT"
          :height="LIST_HEIGHT"
          @row-click="onRowClick"
        >
          <template #default="{ row }">
            <DepthRow
              :row="row"
              side="bid"
              :max-total="maxBidTotal"
              :selected="session.selectedPrice === row.price"
            />
          </template>
        </VirtualList>
      </div>
    </div>
  </section>
</template>

<style scoped>
.panel {
  color: #d1d4dc;
  background: #131722;
  border-radius: 8px;
  padding: 12px;
  max-width: 560px;
  margin: 0 auto;
  font-family: ui-sans-serif, system-ui, sans-serif;
}
.panel-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.ctl {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #787b86;
}
.ctl select,
.ctl.btn {
  background: #1e222d;
  color: #d1d4dc;
  border: 1px solid #2a2e39;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
}
.status {
  margin-left: auto;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid #2a2e39;
  color: #787b86;
}
.status.live {
  color: #26a69a;
  border-color: #26a69a;
}
.status.error {
  color: #ef5350;
  border-color: #ef5350;
}
.status.syncing,
.status.connecting {
  color: #e6c845;
  border-color: #e6c845;
}
.stats {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 11px;
  color: #787b86;
  font-variant-numeric: tabular-nums;
  margin-bottom: 8px;
}
.lists {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0;
}
.side-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  padding: 2px 8px;
}
.side-title.ask {
  color: #ef5350;
}
.side-title.bid {
  color: #26a69a;
}
.mid {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 6px 8px;
  border-top: 1px solid #2a2e39;
  border-bottom: 1px solid #2a2e39;
  margin: 4px 0;
}
.mid-price {
  font-size: 16px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.mid-spread {
  font-size: 11px;
  color: #787b86;
  font-variant-numeric: tabular-nums;
}
</style>
