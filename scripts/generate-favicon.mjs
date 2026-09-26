/**
 * Generates favicon.ico (32x32, PNG-encoded) from the same depth-ladder
 * design as the apps' public/favicon.svg — no image dependencies, just a
 * hand-rolled PNG encoder (zlib is built into Node).
 *
 * Usage: node scripts/generate-favicon.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

const SIZE = 32

// design constants (mirror favicon.svg)
const BG = [0x0b, 0x0e, 0x14]
const RED = [0xef, 0x44, 0x44]
const GREEN = [0x10, 0xb9, 0x81]
const MID = [0x8b, 0x93, 0xa7]
const ROWS = [
  { y: 1, w: 22, c: RED, a: 0.92 },
  { y: 6, w: 16, c: RED, a: 0.92 },
  { y: 11, w: 11, c: RED, a: 0.92 },
  { y: 16, w: 22, h: 1, c: MID, a: 0.55 },
  { y: 18, w: 11, c: GREEN, a: 0.92 },
  { y: 23, w: 16, c: GREEN, a: 0.92 },
  { y: 28, w: 22, c: GREEN, a: 0.92 },
]
const X0 = 5
const ROW_H = 3
const RADIUS = 7 // background corner radius
const BAR_RX = 1.5

// ---------------------------------------------------------------- png encoder

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

// ------------------------------------------------------------- rasterization

function inRoundedRect(px, py, x, y, w, h, r) {
  if (px < x || py < y || px > x + w || py > y + h) return false
  const dx = Math.max(x + r - px, px - (x + w - r), 0)
  const dy = Math.max(y + r - py, py - (y + h - r), 0)
  return dx * dx + dy * dy <= r * r
}

const pixels = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const o = (y * SIZE + x) * 4
    let [r, g, b, a] = [0, 0, 0, 0]
    if (inRoundedRect(x + 0.5, y + 0.5, 0, 0, SIZE, SIZE, RADIUS)) {
      ;[r, g, b, a] = [...BG, 255]
      for (const row of ROWS) {
        const h = row.h ?? ROW_H
        if (inRoundedRect(x + 0.5, y + 0.5, X0, row.y, row.w, h, Math.min(BAR_RX, h / 2, row.w / 2))) {
          const src = row.a
          r = Math.round(row.c[0] * src + r * (1 - src))
          g = Math.round(row.c[1] * src + g * (1 - src))
          b = Math.round(row.c[2] * src + b * (1 - src))
          a = 255
        }
      }
    }
    pixels[o] = r
    pixels[o + 1] = g
    pixels[o + 2] = b
    pixels[o + 3] = a
  }
}

// pack scanlines with filter byte 0
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

// -------------------------------------------------------------- ico container

const ico = Buffer.alloc(22 + png.length)
ico.writeUInt16LE(0, 0) // reserved
ico.writeUInt16LE(1, 2) // type: icon
ico.writeUInt16LE(1, 4) // count
ico[6] = SIZE // width
ico[7] = SIZE // height
ico.writeUInt16LE(1, 10) // planes
ico.writeUInt16LE(32, 12) // bpp
ico.writeUInt32LE(png.length, 14)
ico.writeUInt32LE(22, 18) // data offset
png.copy(ico, 22)

for (const app of ['landing', 'react-client', 'nuxt-client']) {
  const dir = new URL(`../apps/${app}/public/`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}favicon.ico`, ico)
  console.log(`wrote apps/${app}/public/favicon.ico (${ico.length} bytes)`)
}
