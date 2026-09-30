/**
 * Renders the Open Graph image (og.png, 1200:630) for the landing page from
 * scripts/og/dashboard.html — a self-contained telemetry-dashboard artwork
 * (obsidian field, emerald/crimson depth vectors, sub-ms execution log,
 * FPS counter, worker thread indicators).
 *
 * Uses the chromium binary installed by Playwright (or CHROME_PATH / any
 * system Chrome) directly in headless screenshot mode — no npm dependency,
 * mirroring the zero-dep philosophy of scripts/generate-favicon.mjs.
 *
 * Usage:  node scripts/generate-og.mjs
 * Env:    CHROME_PATH  explicit path to chrome/chromium/msedge executable
 *         OG_SCALE     device scale factor for the shot (default 2 → 2400×1260)
 *         OG_OUT       output path (default apps/landing/public/og.png)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const W = 1200
const H = 630
const SCALE = Number(process.env.OG_SCALE ?? 2)
const OUT = process.env.OG_OUT
  ? join(process.cwd(), process.env.OG_OUT)
  : new URL('../apps/landing/public/og.png', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const PAGE = new URL('./og/dashboard.html', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/* ------------------------------------------------------------ find chromium */
function findChromium() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH

  const candidates = []
  const push = (p, v) => { if (existsSync(p)) candidates.push({ p, v }) }
  const roots = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright'),
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application',
  ].filter(Boolean)
  for (const root of roots) {
    if (!existsSync(root)) continue
    try {
      const entries = readdirSync(root)
      /* chrome-headless-shell is the purpose-built binary for --screenshot
         mode; full chromium builds are unreliable for CLI captures */
      for (const entry of entries) {
        const v = Number(entry.split('-').pop()) || 0
        if (/^chromium_headless_shell-\d+$/.test(entry)) {
          push(join(root, entry, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'), v + 1000)
          push(join(root, entry, 'chrome-headless-shell-win', 'chrome-headless-shell.exe'), v + 1000)
          push(join(root, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell'), v + 1000)
          push(join(root, entry, 'chrome-headless-shell-linux', 'chrome-headless-shell'), v + 1000)
        }
        if (/^chromium-\d+$/.test(entry)) {
          push(join(root, entry, 'chrome-win64', 'chrome.exe'), v)
          push(join(root, entry, 'chrome-win', 'chrome.exe'), v)
          push(join(root, entry, 'chrome-linux64', 'chrome'), v)
          push(join(root, entry, 'chrome-linux', 'chrome'), v)
        }
      }
      push(join(root, 'chrome.exe'), 0)
      push(join(root, 'msedge.exe'), 0)
      push(join(root, 'chrome'), 0)
    } catch { /* unreadable root — skip */ }
  }
  candidates.sort((a, b) => b.v - a.v)
  return candidates[0]?.p ?? null
}

/* --------------------------------------------------------- png sanity check */
function pngDimensions(file) {
  const buf = readFileSync(file)
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('output is not a PNG')
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

/* ------------------------------------------------------------------- render */
const exe = findChromium()
if (!exe) {
  console.error(
    'generate-og: no chromium found. Install one of:\n' +
      '  · pnpm exec playwright install chromium   (from apps/react-client)\n' +
      '  · set CHROME_PATH=<path to chrome.exe|chromium|msedge>',
  )
  process.exit(1)
}
if (!existsSync(PAGE)) {
  console.error(`generate-og: dashboard source not found: ${PAGE}`)
  process.exit(1)
}

mkdirSync(dirname(OUT), { recursive: true })
const userDataDir = join(tmpdir(), `og-render-${process.pid}`)
const shot = join(userDataDir, 'shot.png')
const args = [
  '--headless',
  '--no-sandbox',
  `--screenshot=${shot}`,
  `--window-size=${W},${H}`,
  `--force-device-scale-factor=${SCALE}`,
  '--hide-scrollbars',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
  `--user-data-dir=${userDataDir}`,
  pathToFileURL(PAGE).href + '#freeze',
]

console.log(`generate-og: ${W}×${H} @${SCALE}x via ${exe}`)
const run = spawnSync(exe, args, { timeout: 90_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
if (run.status !== 0 || !existsSync(shot)) {
  console.error(`generate-og: chromium failed (exit ${run.status})\n${run.stderr || run.stdout || ''}`)
  process.exit(1)
}

/* validate + move into place */
const { w, h } = pngDimensions(shot)
const expectW = W * SCALE
const expectH = H * SCALE
if (w !== expectW || h !== expectH) {
  if (w === W && h === H) {
    console.warn(`generate-og: note — chromium ignored device scale, got ${w}×${h} (still 1200:630)`)
  } else if (w * H !== h * W) {
    console.error(`generate-og: wrong aspect — got ${w}×${h}, expected ${expectW}×${expectH}`)
    process.exit(1)
  }
}
const bytes = statSync(shot).size
if (bytes < 20_000) {
  console.error(`generate-og: screenshot looks blank (${bytes} bytes) — refusing to ship`)
  process.exit(1)
}
writeFileSync(OUT, readFileSync(shot))
console.log(`generate-og: wrote ${OUT} (${w}×${h}, ${(bytes / 1024).toFixed(1)} KiB)`)
