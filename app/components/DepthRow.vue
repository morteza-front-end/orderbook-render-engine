<script setup lang="ts">
import { computed } from 'vue'
import type { DepthRow } from '../lib/orderbook/store'

const props = defineProps<{
  row: DepthRow
  side: 'bid' | 'ask'
  maxTotal: number
  selected: boolean
}>()

const fmt = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const price = computed(() => fmt.format(props.row.price))
const qty = computed(() => fmt.format(props.row.qty))
const total = computed(() => fmt.format(props.row.total))
const depthPct = computed(() =>
  props.maxTotal > 0 ? Math.min(100, (props.row.total / props.maxTotal) * 100) : 0,
)
const flash = computed(() => (props.row.dir === 0 ? '' : props.row.dir > 0 ? 'up' : 'down'))
</script>

<template>
  <div class="obrow" :class="[side, { selected }]">
    <span
      class="obrow-depth"
      :class="side"
      :style="{ width: `${depthPct}%` }"
      aria-hidden="true"
    />
    <span class="obrow-cell price">{{ price }}</span>
    <span class="obrow-cell qty">{{ qty }}</span>
    <span class="obrow-cell total">{{ total }}</span>
    <span class="obrow-flash" :class="[side, flash]" aria-hidden="true" />
  </div>
</template>

<style scoped>
.obrow {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  align-items: center;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  padding: 0 8px;
  box-sizing: border-box;
  height: 100%;
}
.obrow.selected {
  outline: 1px solid #e6c845;
  outline-offset: -1px;
}
.obrow-depth {
  position: absolute;
  inset: 0 auto 0 0;
  opacity: 0.12;
  transition: none;
}
.obrow-depth.bid {
  background: #26a69a;
}
.obrow-depth.ask {
  background: #ef5350;
}
.obrow-cell {
  position: relative;
  z-index: 1;
  text-align: right;
  white-space: nowrap;
}
.obrow-cell.price {
  text-align: left;
}
.obrow.bid .price {
  color: #26a69a;
}
.obrow.ask .price {
  color: #ef5350;
}
.obrow-flash {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
}
/* flash color follows side semantics: added bid liquidity = green,
   added ask liquidity = red */
.obrow-flash.up {
  animation: flash-up 240ms ease-out;
}
.obrow-flash.down {
  animation: flash-down 240ms ease-out;
}
.obrow.bid .obrow-flash.up,
.obrow.ask .obrow-flash.down {
  --flash: rgba(38, 166, 154, 0.22);
}
.obrow.ask .obrow-flash.up,
.obrow.bid .obrow-flash.down {
  --flash: rgba(239, 83, 80, 0.22);
}
@keyframes flash-up {
  from {
    background: var(--flash);
  }
  to {
    background: transparent;
  }
}
@keyframes flash-down {
  from {
    background: var(--flash);
  }
  to {
    background: transparent;
  }
}
</style>
