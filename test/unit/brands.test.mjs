/**
 * Unit tests for the provider brand system.
 *
 * The pane colours are not decoration — with up to four models streaming at
 * once, hue is the fastest way to tell whose answer you are reading. These
 * tests hold the properties that makes rely on.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { BRANDS, FALLBACK_BRAND, getBrand, applyBrand } from '../../public/js/brands.js';
import { MODELS } from '../../public/js/models.js';

const allBrands = [...Object.entries(BRANDS), ['<fallback>', FALLBACK_BRAND]];

/** #rrggbb -> [r,g,b] */
function rgb(hex) {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  assert.ok(m, `${hex} is not a 6-digit hex colour`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relativeLuminance([r, g, b]) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Hue in degrees, for measuring how far apart two accents look. */
function hue([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}

describe('coverage', () => {
  test('every provider used by a model has a brand', () => {
    for (const model of MODELS) {
      assert.ok(BRANDS[model.provider], `no brand entry for provider "${model.provider}" (${model.id})`);
    }
  });

  test('every brand is actually used by a model', () => {
    const used = new Set(MODELS.map((m) => m.provider));
    for (const provider of Object.keys(BRANDS)) {
      assert.ok(used.has(provider), `brand "${provider}" is dead weight — no model uses it`);
    }
  });

  test('getBrand falls back instead of returning undefined', () => {
    assert.equal(getBrand('Nonexistent'), FALLBACK_BRAND);
    assert.equal(getBrand(undefined), FALLBACK_BRAND);
    assert.equal(getBrand('OpenAI'), BRANDS.OpenAI);
  });

  test('every model carries a short label for the tab strip', () => {
    for (const model of MODELS) {
      assert.equal(typeof model.short, 'string', `${model.id} has no short label`);
      assert.ok(model.short.length > 0 && model.short.length <= 16, `${model.id}: "${model.short}" is not tab-sized`);
    }
  });
});

describe('palette', () => {
  for (const [name, brand] of allBrands) {
    test(`${name} defines accent, soft and glow`, () => {
      assert.match(brand.accent, /^#[0-9a-f]{6}$/i);
      assert.match(brand.soft, /^rgba\(/);
      assert.match(brand.glow, /^rgba\(/);
    });

    test(`${name} accent is readable on the dark surface`, () => {
      // Accents are used for the provider label in the pane header, which is
      // small text — it has to clear 4.5:1 against the pane background.
      const ratio = contrast(rgb(brand.accent), [18, 24, 38]);
      assert.ok(ratio >= 4.5, `${name} accent ${brand.accent} scores ${ratio.toFixed(2)}:1, needs 4.5`);
    });
  }

  test('accents are far enough apart to tell panes apart at a glance', () => {
    const entries = Object.entries(BRANDS);
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [aName, a] = entries[i];
        const [bName, b] = entries[j];
        const separation = Math.abs(hue(rgb(a.accent)) - hue(rgb(b.accent)));
        const circular = Math.min(separation, 360 - separation);
        assert.ok(
          circular >= 25,
          `${aName} (${a.accent}) and ${bName} (${b.accent}) are only ${circular.toFixed(0)}° apart — too close to distinguish side by side`,
        );
      }
    }
  });
});

describe('icons', () => {
  for (const [name, brand] of allBrands) {
    test(`${name} icon is a well-formed standalone SVG`, () => {
      // Regression: without an explicit xmlns the markup renders fine inline but
      // fails silently anywhere it is used as an image source.
      assert.ok(brand.icon.includes('xmlns="http://www.w3.org/2000/svg"'), `${name} icon is missing xmlns`);
      assert.ok(brand.icon.trimStart().startsWith('<svg'), `${name} icon does not start with <svg`);
      assert.ok(brand.icon.trimEnd().endsWith('</svg>'), `${name} icon is not closed`);
      assert.ok(brand.icon.includes('viewBox="0 0 24 24"'), `${name} icon has no 24x24 viewBox`);
    });

    test(`${name} icon inherits colour from CSS`, () => {
      // Hard-coded fills would break the per-pane theming entirely.
      assert.ok(brand.icon.includes('currentColor'), `${name} icon does not use currentColor`);
      assert.ok(!/#[0-9a-f]{3,6}/i.test(brand.icon), `${name} icon hard-codes a colour`);
    });

    test(`${name} icon is decorative to assistive tech`, () => {
      // The provider name sits next to it in text; announcing the glyph too
      // would just be noise.
      assert.ok(brand.icon.includes('aria-hidden="true"'), `${name} icon is not aria-hidden`);
    });

    test(`${name} icon has balanced tags`, () => {
      const open = (brand.icon.match(/<[a-z]/g) || []).length;
      const close = (brand.icon.match(/<\/[a-z]+>|\/>/g) || []).length;
      assert.equal(open, close, `${name} icon has ${open} elements but ${close} closures`);
    });
  }
});

describe('applyBrand', () => {
  test('writes the three custom properties the stylesheet reads', () => {
    const written = {};
    const fake = { style: { setProperty: (k, v) => { written[k] = v; } } };
    const brand = applyBrand(fake, 'Anthropic');
    assert.equal(written['--brand'], BRANDS.Anthropic.accent);
    assert.equal(written['--brand-soft'], BRANDS.Anthropic.soft);
    assert.equal(written['--brand-glow'], BRANDS.Anthropic.glow);
    assert.equal(brand, BRANDS.Anthropic);
  });

  test('an unknown provider still gets a full set of properties', () => {
    const written = {};
    const fake = { style: { setProperty: (k, v) => { written[k] = v; } } };
    applyBrand(fake, 'Who');
    assert.equal(written['--brand'], FALLBACK_BRAND.accent);
    assert.ok(written['--brand-soft']);
    assert.ok(written['--brand-glow']);
  });
});
