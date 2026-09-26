/**
 * Bundler shim: pulls the Comlink worker implementation from the
 * framework-agnostic `@orderbook/core` package into this app's worker
 * bundle. All data-plane logic (parse, diff, sort, transfer) lives in
 * the package; only the worker URL resolution is app-specific.
 */
import '@orderbook/core/worker'
