/**
 * ChatQuest-AI — provider brand identity.
 *
 * Each pane is themed by whoever is answering in it: ChatGPT green, Claude
 * clay, Gemini blue-violet. With four models streaming at once, colour is what
 * lets you tell the panes apart at a glance without reading the headers.
 *
 * Palette is drawn from the hero artwork so the whole app reads as one piece.
 *
 * Hues are deliberately spread around the wheel rather than matched exactly to
 * each vendor's brand blue. Google, DeepSeek and Meta all brand blue, and three
 * near-identical blues side by side defeats the entire point of the layout, so
 * DeepSeek leans violet (its own mark is already indigo) and Meta leans teal.
 *
 * Icons are inline SVG using `currentColor`, for three reasons: the strict CSP
 * on the deployed page blocks any external request, the app has to render
 * offline from the service-worker cache, and inline paths stay crisp at every
 * size. They are simplified marks for identification only, drawn here rather
 * than copied from the vendors.
 *
 * Keyed by the `provider` field in models.js — see test/unit/brands.test.mjs,
 * which fails if a model ever names a provider with no brand entry.
 */

/**
 * @typedef {object} Brand
 * @property {string} accent  Primary hue: icons, dots, active tabs, focus rings.
 * @property {string} soft    Same hue, low alpha: pane header washes and tints.
 * @property {string} glow    Same hue, very low alpha: the pane's ambient light.
 * @property {string} icon    Inline SVG markup, sized by the caller.
 */

// xmlns is required whenever the markup is treated as a standalone SVG document
// rather than inlined into HTML — without it the icons silently fail to render
// anywhere they are used as an image source.
const ICON_ATTRS =
  'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true" focusable="false"';

/** ChatGPT — six-lobed rosette. */
const openaiIcon = `<svg ${ICON_ATTRS} fill="none" stroke="currentColor" stroke-width="1.75">
  <rect x="4.2" y="7.6" width="15.6" height="8.8" rx="4.4"/>
  <rect x="4.2" y="7.6" width="15.6" height="8.8" rx="4.4" transform="rotate(60 12 12)"/>
  <rect x="4.2" y="7.6" width="15.6" height="8.8" rx="4.4" transform="rotate(120 12 12)"/>
</svg>`;

/** Claude — radiating sunburst. */
const anthropicIcon = (() => {
  const blades = Array.from({ length: 12 }, (_, i) => {
    const angle = (i * 360) / 12;
    // Alternate blade length, which is what gives the mark its rhythm.
    const length = i % 2 === 0 ? 9.4 : 6.8;
    return `<rect x="11.1" y="${12 - length}" width="1.8" height="${length}" rx="0.9" transform="rotate(${angle} 12 12)"/>`;
  }).join('');
  return `<svg ${ICON_ATTRS} fill="currentColor">${blades}</svg>`;
})();

/** Gemini — four-point spark. */
const googleIcon = `<svg ${ICON_ATTRS} fill="currentColor">
  <path d="M12 2c.55 5.3 4.7 9.45 10 10-5.3.55-9.45 4.7-10 10-.55-5.3-4.7-9.45-10-10 5.3-.55 9.45-4.7 10-10z"/>
</svg>`;

/** Meta — lemniscate. */
const metaIcon = `<svg ${ICON_ATTRS} fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
  <path d="M12 12c-1.65-2.7-3.05-4.15-4.85-4.15C4.95 7.85 3.3 9.7 3.3 12s1.65 4.15 3.85 4.15c1.8 0 3.2-1.45 4.85-4.15 1.65-2.7 3.05-4.15 4.85-4.15 2.2 0 3.85 1.85 3.85 4.15s-1.65 4.15-3.85 4.15c-1.8 0-3.2-1.45-4.85-4.15z"/>
</svg>`;

/**
 * DeepSeek — whale.
 * The eye is a hole punched with fill-rule evenodd rather than a background
 * coloured dot, so the icon works on any surface it is dropped onto.
 */
const deepseekIcon = `<svg ${ICON_ATTRS} fill="currentColor" fill-rule="evenodd">
  <path d="M2.2 12c0-3.3 3.3-6 7.4-6 3.4 0 6.3 1.85 7.1 4.4l4.1-2.9c.5-.35 1.2.02 1.2.63v7.74c0 .61-.7.98-1.2.63l-4.1-2.9c-.8 2.55-3.7 4.4-7.1 4.4-4.1 0-7.4-2.7-7.4-6zM6.6 10.85a1.05 1.05 0 1 0 0 2.1 1.05 1.05 0 0 0 0-2.1z"/>
</svg>`;

/** @type {Record<string, Brand>} */
export const BRANDS = {
  OpenAI: {
    accent: '#19c37d',
    soft: 'rgba(25, 195, 125, 0.14)',
    glow: 'rgba(25, 195, 125, 0.07)',
    icon: openaiIcon,
  },
  Anthropic: {
    accent: '#e08159',
    soft: 'rgba(224, 129, 89, 0.15)',
    glow: 'rgba(224, 129, 89, 0.08)',
    icon: anthropicIcon,
  },
  Google: {
    accent: '#5b9dff',
    soft: 'rgba(91, 157, 255, 0.16)',
    glow: 'rgba(91, 157, 255, 0.09)',
    icon: googleIcon,
  },
  DeepSeek: {
    accent: '#a78bfa',
    soft: 'rgba(167, 139, 250, 0.16)',
    glow: 'rgba(167, 139, 250, 0.09)',
    icon: deepseekIcon,
  },
  Meta: {
    accent: '#22bcd4',
    soft: 'rgba(34, 188, 212, 0.16)',
    glow: 'rgba(34, 188, 212, 0.09)',
    icon: metaIcon,
  },
};

/** Neutral fallback so an unknown provider degrades instead of rendering blank. */
export const FALLBACK_BRAND = {
  accent: '#8fa0bd',
  soft: 'rgba(143, 160, 189, 0.14)',
  glow: 'rgba(143, 160, 189, 0.07)',
  icon: `<svg ${ICON_ATTRS} fill="currentColor"><circle cx="12" cy="12" r="7"/></svg>`,
};

export function getBrand(provider) {
  return BRANDS[provider] || FALLBACK_BRAND;
}

/** Set the CSS custom properties every brand-themed rule reads. */
export function applyBrand(element, provider) {
  const brand = getBrand(provider);
  element.style.setProperty('--brand', brand.accent);
  element.style.setProperty('--brand-soft', brand.soft);
  element.style.setProperty('--brand-glow', brand.glow);
  return brand;
}
