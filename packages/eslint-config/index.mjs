// @ts-check
import tseslint from 'typescript-eslint'

/**
 * Shared flat-config base for every workspace package.
 * Apps extend it (e.g. the Nuxt app merges it behind `withNuxt`).
 *
 * Entries that set a parser/plugins without a `files` filter are
 * restricted to script files so they never clobber framework parsers
 * (e.g. `vue-eslint-parser`) when an app appends this base.
 */
const SCRIPT_FILES = ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}']

const base = tseslint.config(
  {
    ignores: [
      'dist/**',
      '.output/**',
      '.nuxt/**',
      '.nitro/**',
      '.turbo/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'blob-report/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
)

export default base.map((entry) =>
  entry.files || !('languageOptions' in entry) ? entry : { ...entry, files: SCRIPT_FILES },
)
