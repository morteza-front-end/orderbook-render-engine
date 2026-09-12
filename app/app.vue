<script setup lang="ts">
import OrderBookPanel from './components/OrderBookPanel.vue'
</script>

<template>
  <main class="page">
    <h1 class="title">Order Book Render Engine</h1>
    <OrderBookPanel />
  </main>
</template>

<style scoped>
.page {
  min-height: 100vh;
  background: #0b0e14;
  padding: 24px 12px;
}
.title {
  color: #d1d4dc;
  font-size: 15px;
  font-weight: 600;
  text-align: center;
  margin: 0 0 12px;
  letter-spacing: 0.04em;
}
</style>
