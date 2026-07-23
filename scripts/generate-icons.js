#!/usr/bin/env node
/**
 * Generate the PWA icons from the source artwork, with no image-library
 * dependency (this project ships zero dependencies, build tooling included).
 *
 *   source: assets/app-icon.png
 *   output: public/icons/icon-192.png            purpose "any"
 *           public/icons/icon-512.png            purpose "any"
 *           public/icons/icon-maskable-512.png   purpose "maskable"
 *           public/icons/apple-touch-icon.png    iOS home screen (opaque)
 *
 * Two things the source needs doing to it:
 *
 * 1. It is opaque RGB with a white surround outside the rounded plate. Left
 *    alone that ships as a white square on the home screen. We flood-fill the
 *    background inwards from the four corners and make it transparent — a flat
 *    "is it white?" threshold would punch holes in the white app-name text.
 *
 * 2. Maskable icons get cropped to whatever shape the launcher wants (circle,
 *    squircle, teardrop). Only the middle 80% is guaranteed visible, so the
 *    maskable variant sits the artwork on a full-bleed plate-coloured canvas,
 *    scaled to keep everything inside that safe zone.
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'assets/app-icon.png');
const OUT_DIR = join(root, 'public/icons');

/** Anything brighter than this on all channels counts as surround. */
const WHITE_THRESHOLD = 236;
/** Maskable safe zone: the middle 80% of the canvas, i.e. radius 40%. */
const SAFE_RADIUS = 0.4;
/** Leave a little room rather than landing exactly on the safe-zone boundary. */
const SAFE_MARGIN = 0.97;
/** Never blow the artwork up past this, however small its content sits. */
const MAX_MASKABLE_SCALE = 0.82;

// ── PNG chunk plumbing ───────────────────────────────────────────────────────

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

// ── Decode ───────────────────────────────────────────────────────────────────

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode an 8-bit non-interlaced RGB/RGBA/grey PNG to {width, height, data(RGBA)}. */
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');

  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];

  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const bitDepth = body[8];
      colorType = body[9];
      const interlace = body[12];
      if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth} (need 8)`);
      if (interlace !== 0) throw new Error('interlaced PNGs are not supported');
      if (![0, 2, 6].includes(colorType)) throw new Error(`unsupported colour type ${colorType}`);
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const channels = { 0: 1, 2: 3, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);

  let previous = Buffer.alloc(stride);
  let pos = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;

    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? line[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      let value = line[i];

      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`unknown filter type ${filter}`);

      line[i] = value & 0xff;
    }

    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      if (channels === 1) {
        out[d] = out[d + 1] = out[d + 2] = line[s];
        out[d + 3] = 255;
      } else {
        out[d] = line[s];
        out[d + 1] = line[s + 1];
        out[d + 2] = line[s + 2];
        out[d + 3] = channels === 4 ? line[s + 3] : 255;
      }
    }

    previous = line;
  }

  return { width, height, data: out };
}

// ── Encode ───────────────────────────────────────────────────────────────────

/**
 * Encode RGBA as PNG, choosing a filter per scanline.
 *
 * Filtering matters a lot here: these icons are gradient-heavy, and storing
 * every row unfiltered roughly triples the file. The service worker precaches
 * all three icons, so this comes straight off the offline install size. The
 * selection heuristic (minimum sum of absolute differences) is the one the PNG
 * spec itself recommends.
 */
function encodePng({ width, height, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA

  const bpp = 4;
  const stride = width * bpp;
  const raw = Buffer.alloc(height * (stride + 1));
  const candidate = Buffer.alloc(stride);
  const best = Buffer.alloc(stride);
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    let bestFilter = 0;
    let bestScore = Infinity;

    for (let filter = 0; filter <= 4; filter++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? row[i - bpp] : 0;
        const up = previous[i];
        const upLeft = i >= bpp ? previous[i - bpp] : 0;
        let value;
        if (filter === 0) value = row[i];
        else if (filter === 1) value = row[i] - left;
        else if (filter === 2) value = row[i] - up;
        else if (filter === 3) value = row[i] - ((left + up) >> 1);
        else value = row[i] - paeth(left, up, upLeft);
        value &= 0xff;
        candidate[i] = value;
        // Treat bytes as signed when scoring — that is what makes the
        // heuristic track how compressible the row actually is.
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = filter;
        candidate.copy(best);
      }
    }

    const rowStart = y * (stride + 1);
    raw[rowStart] = bestFilter;
    best.copy(raw, rowStart + 1);
    previous = Buffer.from(row);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Background removal ───────────────────────────────────────────────────────

/**
 * Make the surround transparent by flooding inwards from the four corners.
 *
 * Connectivity is what makes this safe: the white letters of "ChatQuest-AI" are
 * enclosed by the dark plate, so the flood never reaches them.
 */
function keyOutSurround(image) {
  const { width, height, data } = image;
  const isWhite = (i) => data[i] >= WHITE_THRESHOLD && data[i + 1] >= WHITE_THRESHOLD && data[i + 2] >= WHITE_THRESHOLD;

  const seen = new Uint8Array(width * height);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (seen[p]) return;
    seen[p] = 1;
    if (isWhite(p * 4)) stack.push(p);
  };

  push(0, 0);
  push(width - 1, 0);
  push(0, height - 1);
  push(width - 1, height - 1);

  let cleared = 0;
  while (stack.length) {
    const p = stack.pop();
    data[p * 4 + 3] = 0;
    cleared++;
    const x = p % width;
    const y = (p - x) / width;
    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
  }

  return cleared;
}

/**
 * The artwork's plate colour, used to fill the maskable canvas so the join is
 * invisible.
 *
 * Sampled a little way INSIDE the left edge of each row: the first opaque pixel
 * is on the antialiased boundary against the white surround and reads as a
 * mid-grey, which would put a pale halo around the maskable icon.
 */
function plateColour(image) {
  const { width, height, data } = image;
  const inset = Math.max(4, Math.round(width * 0.02));
  const samples = [];

  for (let y = Math.round(height * 0.05); y < height * 0.95; y += 3) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      const i = (y * width + x + inset) * 4;
      if (x + inset < width && data[i + 3] > 0) samples.push([data[i], data[i + 1], data[i + 2]]);
      break;
    }
  }

  if (!samples.length) return [11, 15, 23];

  // Median per channel — robust against a row that happens to clip artwork.
  const channel = (c) => {
    const sorted = samples.map((s) => s[c]).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  return [channel(0), channel(1), channel(2)];
}

// ── Resampling ───────────────────────────────────────────────────────────────

/**
 * Area-averaged (box filter) resample. Weights are computed on the real
 * fractional source rectangle rather than integer blocks, because 1254 -> 512
 * is not a whole-number ratio and integer blocks would alias badly.
 *
 * Alpha is premultiplied during accumulation, otherwise transparent surround
 * pixels drag a white fringe into the artwork's edge.
 */
function resample(image, targetW, targetH) {
  const { width: sw, height: sh, data: src } = image;
  const out = Buffer.alloc(targetW * targetH * 4);
  const scaleX = sw / targetW;
  const scaleY = sh / targetH;

  for (let dy = 0; dy < targetH; dy++) {
    const y0 = dy * scaleY;
    const y1 = (dy + 1) * scaleY;
    const iy0 = Math.floor(y0);
    const iy1 = Math.min(Math.ceil(y1), sh);

    for (let dx = 0; dx < targetW; dx++) {
      const x0 = dx * scaleX;
      const x1 = (dx + 1) * scaleX;
      const ix0 = Math.floor(x0);
      const ix1 = Math.min(Math.ceil(x1), sw);

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weight = 0;

      for (let sy = iy0; sy < iy1; sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = ix0; sx < ix1; sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (sy * sw + sx) * 4;
          const alpha = src[i + 3] / 255;
          r += src[i] * alpha * w;
          g += src[i + 1] * alpha * w;
          b += src[i + 2] * alpha * w;
          a += alpha * w;
          weight += w;
        }
      }

      const d = (dy * targetW + dx) * 4;
      if (a > 0) {
        out[d] = Math.round(r / a);
        out[d + 1] = Math.round(g / a);
        out[d + 2] = Math.round(b / a);
      }
      out[d + 3] = weight > 0 ? Math.round((a / weight) * 255) : 0;
    }
  }

  return { width: targetW, height: targetH, data: out };
}

/**
 * The largest scale at which every piece of real content still falls inside the
 * maskable safe circle.
 *
 * "Real content" means visibly brighter or more saturated than the dark plate —
 * the bubbles, the wordmark, the provider glyphs. The plate itself and its
 * rounded corners are excluded on purpose: they are background, and a launcher
 * cropping them away costs nothing.
 *
 * Deriving this rather than hard-coding it means swapping assets/app-icon.png
 * for different artwork cannot silently start clipping the design.
 */
function safeMaskableScale(image) {
  const { width, height, data } = image;
  const cx = width / 2;
  const cy = height / 2;
  let maxRadius = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const saturation = Math.max(r, g, b) - Math.min(r, g, b);
      if (luminance <= 70 && saturation <= 60) continue;
      const radius = Math.hypot(x - cx, y - cy);
      if (radius > maxRadius) maxRadius = radius;
    }
  }

  if (maxRadius === 0) return MAX_MASKABLE_SCALE;
  // Content at `maxRadius/width` of the artwork must land within SAFE_RADIUS.
  const scale = (SAFE_RADIUS / (maxRadius / width)) * SAFE_MARGIN;
  return Math.min(scale, MAX_MASKABLE_SCALE);
}

/** Draw `art` centred on a solid `colour` canvas of `size`, scaled by `scale`. */
function onPlate(art, size, colour, scale) {
  const inner = Math.round(size * scale);
  const scaled = resample(art, inner, inner);
  const data = Buffer.alloc(size * size * 4);

  for (let i = 0; i < size * size; i++) {
    data[i * 4] = colour[0];
    data[i * 4 + 1] = colour[1];
    data[i * 4 + 2] = colour[2];
    data[i * 4 + 3] = 255;
  }

  const offset = Math.floor((size - inner) / 2);
  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++) {
      const s = (y * inner + x) * 4;
      const alpha = scaled.data[s + 3] / 255;
      if (alpha === 0) continue;
      const d = ((y + offset) * size + (x + offset)) * 4;
      for (let c = 0; c < 3; c++) {
        data[d + c] = Math.round(scaled.data[s + c] * alpha + data[d + c] * (1 - alpha));
      }
      data[d + 3] = 255;
    }
  }

  return { width: size, height: size, data };
}

// ── Run ──────────────────────────────────────────────────────────────────────

let source;
try {
  source = decodePng(readFileSync(SOURCE));
} catch (err) {
  console.error(`[icons] could not read ${SOURCE}: ${err.message}`);
  process.exitCode = 1;
  throw err;
}

const cleared = keyOutSurround(source);
const colour = plateColour(source);

console.log(`[icons] source ${source.width}x${source.height}, surround removed (${cleared} px), plate #${colour.map((c) => c.toString(16).padStart(2, '0')).join('')}`);

mkdirSync(OUT_DIR, { recursive: true });

const write = (name, image) => {
  const png = encodePng(image);
  writeFileSync(join(OUT_DIR, name), png);
  console.log(`[icons] ${name} (${image.width}x${image.height}, ${(png.length / 1024).toFixed(1)} kB)`);
};

const maskableScale = safeMaskableScale(source);
console.log(`[icons] maskable scale ${(maskableScale * 100).toFixed(1)}% — derived so all content clears the 80% safe zone`);

write('icon-192.png', resample(source, 192, 192));
write('icon-512.png', resample(source, 512, 512));
write('icon-maskable-512.png', onPlate(source, 512, colour, maskableScale));

// iOS ignores alpha on apple-touch-icon and flattens it against black, so this
// one is composited opaque. It also applies its own squircle, hence full bleed
// rather than the maskable icon's inset.
write('apple-touch-icon.png', onPlate(source, 180, colour, 1));
