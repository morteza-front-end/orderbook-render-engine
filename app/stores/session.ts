import { defineStore } from 'pinia'

export type FeedStatus = 'idle' | 'connecting' | 'syncing' | 'live' | 'error' | 'closed'

/**
 * UI / session state ONLY.
 *
 * High-frequency order book data deliberately never enters Pinia: it lives in
 * the framework-free `OrderBookStore` + ring buffer and is read imperatively
 * by the requestAnimationFrame render loop (see `useOrderbookFeed`). This
 * store changes at human speed (connection status, user preferences, a 1Hz
 * stats mirror) so Vue's reactivity cost stays irrelevant.
 */
export const useSessionStore = defineStore('session', {
  state: () => ({
    symbol: 'btcusdt',
    feed: 'synthetic' as 'live' | 'synthetic',
    /** synthetic feed events per second (10 = Binance depth@100ms cadence) */
    rate: 10,
    status: 'idle' as FeedStatus,
    statusDetail: '',
    paused: false,
    /** visible rows per side */
    depth: 500,
    selectedPrice: 0,
    stats: {
      messages: 0,
      appliedEvents: 0,
      batches: 0,
      resyncs: 0,
      droppedBatches: 0,
      pendingBatches: 0,
      seq: 0,
      fps: 0,
    },
  }),
  getters: {
    isLive: (s) => s.status === 'live',
    statusLabel: (s) => s.status.toUpperCase(),
  },
  actions: {
    setSymbol(symbol: string) {
      this.symbol = symbol.toLowerCase().replace(/[^a-z0-9]/g, '')
    },
    setFeed(feed: 'live' | 'synthetic') {
      this.feed = feed
    },
    setStatus(status: FeedStatus, detail = '') {
      this.status = status
      this.statusDetail = detail
    },
    togglePause() {
      this.paused = !this.paused
    },
    select(price: number) {
      this.selectedPrice = price
    },
  },
})
