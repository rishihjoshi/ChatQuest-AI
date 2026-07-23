#!/usr/bin/env node
/**
 * Generate the PWA icons as real PNGs, with no image-library dependency.
 *
 * The mark is three rounded bars of different heights — one per model pane,
 * which is the whole idea of the app. Rendered supersampled and box-filtered
 * down so the curves stay clean at 192px.
 *
 * Outputs:
 *   public/icons/icon-192.png            rounded-square, purpose "any"
 *   public/icons/icon-512.png            rounded-square, purpose "any"
 *   public/icons/icon-maskable-512.png   full-bleed, content inside the 80% safe zone
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public/icons');

const BG = [0x0b, 0x0f, 0x17];
const BARS = [
  { color: [0x5b, 0x8c, 0xff], height: 0.46 }, // accent blue
  { color: [0x3d, 0xdc, 0x97], height: 0.66 }, // green
  { color: [0xff, 0xb4, 0x54], height: 0.36 }, // amber
];

// ── PNG encoding ─────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encode an RGBA byte array as a PNG buffer. */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12: compression, filter, interlace — all 0

  // Raw scanlines, each prefixed with filter type 0 (None).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Drawing ──────────────────────────────────────────────────────────────────

function createCanvas(size) {
  return { size, data: Buffer.alloc(size * size * 4) }; // transparent
}

function blend(canvas, x, y, [r, g, b], alpha) {
  if (alpha <= 0) return;
  const i = (y * canvas.size + x) * 4;
  const dstA = canvas.data[i + 3] / 255;
  const outA = alpha + dstA * (1 - alpha);
  if (outA === 0) return;
  for (let c = 0; c < 3; c++) {
    const src = [r, g, b][c];
    canvas.data[i + c] = Math.round((src * alpha + canvas.data[i + c] * dstA * (1 - alpha)) / outA);
  }
  canvas.data[i + 3] = Math.round(outA * 255);
}

/** Fill a rounded rectangle in normalised (0..1) coordinates. */
function roundRect(canvas, { x, y, w, h, r, color }) {
  const s = canvas.size;
  const px = x * s, py = y * s, pw = w * s, ph = h * s, pr = Math.min(r * s, pw / 2, ph / 2);

  const x0 = Math.max(0, Math.floor(px)), x1 = Math.min(s, Math.ceil(px + pw));
  const y0 = Math.max(0, Math.floor(py)), y1 = Math.min(s, Math.ceil(py + ph));

  for (let iy = y0; iy < y1; iy++) {
    for (let ix = x0; ix < x1; ix++) {
      // Distance from the inner (corner-radius-shrunk) rectangle.
      const cx = Math.min(Math.max(ix + 0.5, px + pr), px + pw - pr);
      const cy = Math.min(Math.max(iy + 0.5, py + pr), py + ph - pr);
      const dx = ix + 0.5 - cx, dy = iy + 0.5 - cy;
      if (Math.hypot(dx, dy) <= pr) blend(canvas, ix, iy, color, 1);
    }
  }
}

/** Box-filter a supersampled canvas down to the target size (premultiplied). */
function downsample(canvas, target) {
  const factor = canvas.size / target;
  const out = Buffer.alloc(target * target * 4);

  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const i = ((y * factor + sy) * canvas.size + (x * factor + sx)) * 4;
          const alpha = canvas.data[i + 3] / 255;
          // Premultiply before averaging, or edges pick up dark fringes.
          r += canvas.data[i] * alpha;
          g += canvas.data[i + 1] * alpha;
          b += canvas.data[i + 2] * alpha;
          a += alpha;
          n++;
        }
      }
      const o = (y * target + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

/**
 * Draw the ChatQuest mark.
 * @param {boolean} maskable full-bleed background, content inside the inner 80%
 */
function drawIcon(canvas, maskable) {
  // Background plate: full-bleed for maskable (any crop shape works), rounded
  // square otherwise so it looks right on a desktop taskbar.
  roundRect(canvas, { x: 0, y: 0, w: 1, h: 1, r: maskable ? 0 : 0.22, color: BG });

  // Content scale: shrink into the 80% safe zone for maskable icons.
  const scale = maskable ? 0.66 : 0.86;
  const offset = (1 - scale) / 2;

  const barW = 0.2;
  const gap = 0.1;
  const baseline = 0.84; // bars sit on a common bottom edge

  BARS.forEach((bar, index) => {
    // 3 bars + 2 gaps = 0.8 wide, so 0.1 of margin either side centres the group.
    const x = 0.1 + index * (barW + gap);
    const y = baseline - bar.height;
    roundRect(canvas, {
      x: offset + x * scale,
      y: offset + y * scale,
      w: barW * scale,
      h: bar.height * scale,
      r: (barW / 2) * scale,
      color: bar.color,
    });
  });
}

// ── Emit ─────────────────────────────────────────────────────────────────────

function writeIcon(name, size, maskable) {
  const supersample = 4;
  const canvas = createCanvas(size * supersample);
  drawIcon(canvas, maskable);
  const png = encodePng(downsample(canvas, size), size);
  writeFileSync(join(outDir, name), png);
  console.log(`[icons] ${name} (${size}x${size}, ${(png.length / 1024).toFixed(1)} kB)`);
}

mkdirSync(outDir, { recursive: true });
writeIcon('icon-192.png', 192, false);
writeIcon('icon-512.png', 512, false);
writeIcon('icon-maskable-512.png', 512, true);
