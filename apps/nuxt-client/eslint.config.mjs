// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'
import base from '@orderbook/eslint-config'

export default withNuxt(
  // shared workspace base rules (typescript-eslint recommended + house style)
  ...base,
  {
    rules: {
      'vue/no-v-html': 'off',
    },
  },
)
