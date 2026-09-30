/* Pixel-level verification of og.png without image input:
   decodes the truecolor PNG (node zlib) and probes known coordinates
   for the design palette. Run: node scripts/og/verify-og.mjs */
import { inflateSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

const file = process.argv[2] ?? new URL('../../apps/landing/public/og.png', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const buf = readFileSync(file)

/* ------------------------------------------------------------ png decode */
let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, idat = []
while (off < buf.length) {
  const len = buf.readUInt32BE(off)
  const type = buf.toString('ascii', off + 4, off + 8)
  const data = buf.subarray(off + 8, off + 8 + len)
  if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9] }
  if (type === 'IDAT') idat.push(data)
  if (type === 'IEND') break
  off += 12 + len
}
if (bitDepth !== 8 || colorType !== 2) { console.error(`unsupported PNG: depth=${bitDepth} color=${colorType}`); process.exit(1) }

const raw = inflateSync(Buffer.concat(idat))
const BPP = 3
const STRIDE = w * BPP + 1

/* undo filters (none/sub/up/average/paeth) */
const px = Buffer.alloc(w * h * BPP)
for (let y = 0; y < h; y++) {
  const filter = raw[y * STRIDE]
  const rowStart = y * STRIDE + 1
  const prevStart = (y - 1) * STRIDE + 1
  const outStart = y * w * BPP
  for (let x = 0; x < w * BPP; x++) {
    const cur = raw[rowStart + x]
    const left = x >= BPP ? px[outStart + x - BPP] : 0
    const up = y > 0 ? px[outStart - w * BPP + x] : 0
    const ul = y > 0 && x >= BPP ? px[outStart - w * BPP + x - BPP] : 0
    let v
    switch (filter) {
      case 0: v = cur; break
      case 1: v = cur + left; break
      case 2: v = cur + up; break
      case 3: v = cur + ((left + up) >> 1); break
      default: {
        const p = left + up - ul
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul)
        v = cur + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul)
      }
    }
    px[outStart + x] = v & 0xff
  }
}
const S = w / 1200 /* render scale (2) — probe coords given in 1200×630 space */
const at = (x, y) => { const o = ((y * S | 0) * w + (x * S | 0)) * BPP; return [px[o], px[o + 1], px[o + 2]] }
const near = (c, hex, tol = 26) => {
  const [r, g, b] = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
  return Math.abs(c[0] - r) <= tol && Math.abs(c[1] - g) <= tol && Math.abs(c[2] - b) <= tol
}
const hex = (c) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('')

/* ------------------------------------------------------------ probes */
/* scan regions (grid scan since text/vector positions vary slightly) */
function scan(x0, y0, x1, y1, pred) {
  for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) {
    const c = at(x, y)
    if (pred(c)) return { x, y, c }
  }
  return null
}

let pass = 0, fail = 0
const check = (name, got, ok) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${got ? ' — ' + got : ''}`) }

/* 1. obsidian field (#090a0f) — outer margin below panels */
check('obsidian bg', null, near(at(600, 622), '#090a0f', 14) || near(at(600, 6), '#090a0f', 14))

/* 2. dark slate panel surface (#0d1017) — depth panel interior top-left */
check('slate panel', hex(at(40, 40)), near(at(40, 40), '#0d1017', 16))

/* 3. emerald depth vector (#10b981) — bids area, left-center of depth chart */
const g = scan(90, 120, 380, 420, c => near(c, '#10b981', 40) && c[1] > c[2])
check('emerald vector', g ? `${g.x},${g.y} ${hex(g.c)}` : 'none', !!g)

/* 4. crimson depth vector (#ef4444) — asks area, right-center */
const r = scan(420, 120, 560, 420, c => near(c, '#ef4444', 40) && c[0] > c[1])
check('crimson vector', r ? `${r.x},${r.y} ${hex(r.c)}` : 'none', !!r)

/* 5. emerald present in ladder region (bid prices #34d399) */
const lg = scan(620, 250, 890, 480, c => c[1] > 120 && c[1] > c[0] + 30 && c[1] > c[2] + 20)
check('ladder green text', lg ? `${lg.x},${lg.y} ${hex(lg.c)}` : 'none', !!lg)

/* 6. crimson present in ladder region (ask prices #f87171) */
const lr = scan(620, 60, 890, 240, c => c[0] > 150 && c[0] > c[1] + 40 && c[0] > c[2] + 40)
check('ladder red text', lr ? `${lr.x},${lr.y} ${hex(lr.c)}` : 'none', !!lr)

/* 7. white-ish text (log/labels #dfe5f0) in exec panel */
const wt = scan(930, 60, 1160, 340, c => c[0] > 170 && c[1] > 175 && c[2] > 185 && c[1] >= c[0] - 12)
check('log bright text', wt ? `${wt.x},${wt.y} ${hex(wt.c)}` : 'none', !!wt)

/* 8. muted text in threads panel */
const mt = scan(930, 380, 1160, 520, c => c[0] > 70 && c[0] < 160 && Math.abs(c[0] - c[2]) < 40 && c[2] >= c[0])
check('threads muted text', mt ? `${mt.x},${mt.y} ${hex(mt.c)}` : 'none', !!mt)

/* 9. green worker chip bars in topbar (right zone) */
const wb = scan(1000, 14, 1190, 42, c => c[1] > 110 && c[1] > c[0] + 25 && c[1] > c[2] + 25)
check('worker chip green', wb ? `${wb.x},${wb.y} ${hex(wb.c)}` : 'none', !!wb)

/* 10. grid line contrast — subtle lines over bg in margins (sample panel gap) */
const gap = at(600, 57)
check('panel gap line/bg', hex(gap), near(gap, '#090a0f', 20) || near(gap, '#1b2130', 40))

console.log(`\n${pass} passed, ${fail} failed (${w}×${h})`)
process.exit(fail ? 1 : 0)
