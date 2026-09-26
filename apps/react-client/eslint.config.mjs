// @ts-check
import js from '@eslint/js'
import base from '@orderbook/eslint-config'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  js.configs.recommended,
  ...base,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    ignores: ['dist/**'],
  },
]
