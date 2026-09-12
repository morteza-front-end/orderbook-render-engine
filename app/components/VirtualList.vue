<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

/**
 * Window-based virtualized list (fixed row height, no external dependency).
 *
 * Renders only `visible + 2 * overscan` rows regardless of dataset size, so
 * 500+ (or 50,000) rows cost the same. Scroll position is kept in a plain ref
 * updated by a passive scroll handler; combined with the parent's shallowRef
 * row arrays this avoids deep reactivity over the whole book.
 *
 * `reversed` displays the same window bottom-up (used for asks so the best
 * ask sits next to the mid price) without inverting scroll semantics.
 */
const props = withDefaults(
  defineProps<{
    rows: { price: number }[]
    rowHeight: number
    height: number
    overscan?: number
    reversed?: boolean
  }>(),
  { overscan: 8, reversed: false },
)

const emit = defineEmits<{ rowClick: [price: number] }>()

const el = ref<HTMLElement | null>(null)
const scrollTop = ref(0)

function onScroll(): void {
  scrollTop.value = el.value?.scrollTop ?? 0
}

const total = computed(() => props.rows.length * props.rowHeight)

const window_ = computed(() => {
  const first = Math.max(0, Math.floor(scrollTop.value / props.rowHeight) - props.overscan)
  const visible = Math.ceil(props.height / props.rowHeight)
  const last = Math.min(props.rows.length, first + visible + props.overscan * 2)
  return { first, last }
})

const slice = computed(() => {
  const { first, last } = window_.value
  if (props.reversed) {
    const from = Math.max(0, props.rows.length - last)
    const to = props.rows.length - first
    return { from, to }
  }
  return { from: first, to: last }
})

const offsetPx = computed(() => window_.value.first * props.rowHeight)

onMounted(() => {
  // reversed lists start pinned to the newest data (adjacent to the mid)
  if (props.reversed && el.value) {
    el.value.scrollTop = el.value.scrollHeight
    scrollTop.value = el.value.scrollTop
  }
})
</script>

<template>
  <div
    ref="el"
    class="vl"
    data-testid="vl-scroll"
    :style="{ height: `${height}px` }"
    @scroll.passive="onScroll"
  >
    <div class="vl-spacer" :style="{ height: `${total}px` }">
      <div class="vl-window" :style="{ transform: `translateY(${offsetPx}px)` }">
        <div
          v-for="(row, i) in rows.slice(slice.from, slice.to)"
          :key="row.price"
          class="vl-row"
          :style="{ height: `${rowHeight}px` }"
          @click="emit('rowClick', row.price)"
        >
          <slot :row="row" :index="slice.from + i" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vl {
  position: relative;
  overflow-y: auto;
  overflow-x: hidden;
  contain: strict;
}
.vl-spacer {
  position: relative;
}
.vl-window {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  will-change: transform;
}
.vl-row {
  cursor: pointer;
}
</style>
