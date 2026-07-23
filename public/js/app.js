/**
 * ChatQuest-AI — UI logic.
 *
 * One prompt in, N panes out. Each pane owns its own conversation history and
 * its own in-flight request, so a slow or failing model can never block, cancel
 * or corrupt any other pane.
 */

import { MODELS, MAX_MODELS, DEFAULT_MODEL_IDS, getModel } from './models.js';
import { streamChat, ChatError } from './api-client.js';
import { escapeHtml, renderMarkdown } from './markdown.js';

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

/** @type {string[]} selected model IDs, in display order */
let selected = [...DEFAULT_MODEL_IDS];

/**
 * Per-model runtime state. Survives selection changes so unchecking and
 * re-checking a model does not lose its thread.
 *
 * `stream` is non-null only while a response is in flight and holds the text
 * received so far. It lives on the pane rather than in askModel's closure so
 * that a mid-stream rebuildPanes() can re-attach the partial answer to the new
 * DOM — see restoreStreamBubble().
 *
 * @type {Map<string, {history: Array<{role:string,content:string}>, refs: object|null, stream: {text:string}|null}>}
 */
const panes = new Map();

const TYPING_HTML = '<span class="typing"><i></i><i></i><i></i></span>';

/** @type {Map<string, AbortController>} in-flight requests, keyed by model ID */
const inFlight = new Map();

let activeTab = 0;

const $ = (sel) => document.querySelector(sel);

const els = {
  panes: $('#panes'),
  tabs: $('#tabs'),
  form: $('#composer'),
  input: $('#prompt'),
  send: $('#send'),
  sendLabel: $('#send-label'),
  stop: $('#stop'),
  picker: $('#picker'),
  pickerList: $('#picker-list'),
  pickerToggle: $('#picker-toggle'),
  pickerSummary: $('#picker-summary'),
  pickerHint: $('#picker-hint'),
  newChat: $('#new-chat'),
  updateBanner: $('#update-banner'),
  updateButton: $('#update-refresh'),
  offline: $('#offline-banner'),
};

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

function init() {
  buildPicker();
  rebuildPanes();
  wireComposer();
  wireConnectivity();
  registerServiceWorker();
  startVersionWatch();
}

// ─────────────────────────────────────────────────────────────────────────────
// Model picker
// ─────────────────────────────────────────────────────────────────────────────

function buildPicker() {
  els.pickerList.innerHTML = '';

  for (const model of MODELS) {
    const row = document.createElement('label');
    row.className = 'picker-row';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = model.id;
    box.checked = selected.includes(model.id);
    box.addEventListener('change', () => toggleModel(model.id, box.checked));

    const text = document.createElement('span');
    text.className = 'picker-text';
    text.innerHTML =
      `<span class="picker-label">${escapeHtml(model.label)}</span>` +
      `<span class="picker-provider">${escapeHtml(model.provider)}</span>` +
      `<span class="picker-desc">${escapeHtml(model.description)}</span>`;

    row.append(box, text);
    els.pickerList.append(row);
  }

  els.pickerToggle.addEventListener('click', () => {
    const open = els.picker.hasAttribute('hidden');
    els.picker.toggleAttribute('hidden', !open);
    els.pickerToggle.setAttribute('aria-expanded', String(open));
  });

  syncPicker();
}

function toggleModel(id, checked) {
  if (checked) {
    if (selected.length >= MAX_MODELS) return;
    // Preserve catalogue order so panes don't jump around as you tick boxes.
    selected = MODELS.filter((m) => m.id === id || selected.includes(m.id)).map((m) => m.id);
  } else {
    if (selected.length <= 1) return; // At least one model must stay selected.
    abortModel(id);
    selected = selected.filter((m) => m !== id);
  }
  syncPicker();
  rebuildPanes();
}

/** Reflect state into the checkboxes and enforce the 1–4 cap in the UI. */
function syncPicker() {
  const atCap = selected.length >= MAX_MODELS;
  const atFloor = selected.length <= 1;

  for (const box of els.pickerList.querySelectorAll('input[type=checkbox]')) {
    const isSelected = selected.includes(box.value);
    box.checked = isSelected;
    // Past the cap, unchecked boxes go dead; at the floor, the last one locks.
    box.disabled = isSelected ? atFloor : atCap;
    box.closest('.picker-row').classList.toggle('is-disabled', box.disabled && !isSelected);
  }

  els.pickerHint.textContent = atCap
    ? `Maximum of ${MAX_MODELS} models — uncheck one to swap.`
    : `Select 1–${MAX_MODELS} models. Each one is billed separately per prompt.`;

  els.pickerSummary.textContent = `${selected.length} model${selected.length === 1 ? '' : 's'}`;
  updateSendLabel();
}

function updateSendLabel() {
  const n = Math.min(selected.length, MAX_MODELS);
  // The cost multiplier lives on the button itself — visible before you send.
  els.sendLabel.textContent = `Send to ${n} model${n === 1 ? '' : 's'}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Panes
// ─────────────────────────────────────────────────────────────────────────────

function rebuildPanes() {
  els.panes.innerHTML = '';
  els.tabs.innerHTML = '';

  selected.forEach((id, index) => {
    const model = getModel(id);
    const pane = panes.get(id) || { history: [], refs: null, stream: null };
    panes.set(id, pane);

    const el = document.createElement('section');
    el.className = 'pane';
    el.dataset.model = id;
    el.setAttribute('aria-label', model.label);
    el.innerHTML = `
      <header class="pane-head">
        <span class="pane-dot" data-state="idle"></span>
        <span class="pane-title">
          <span class="pane-name">${escapeHtml(model.label)}</span>
          <span class="pane-provider">${escapeHtml(model.provider)}</span>
        </span>
      </header>
      <div class="pane-body" tabindex="0"></div>`;

    els.panes.append(el);
    pane.refs = { el, body: el.querySelector('.pane-body'), dot: el.querySelector('.pane-dot') };

    // Re-render any history this model already accumulated, then re-attach a
    // response that is still streaming. Without this, rebuilding the panes
    // mid-stream would leave the in-flight answer writing into a detached node
    // and it would never appear at all.
    for (const message of pane.history) appendMessage(pane, message.role, message.content, true);
    restoreStreamBubble(pane);

    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tab';
    tab.textContent = model.label;
    tab.addEventListener('click', () => showTab(index));
    els.tabs.append(tab);
  });

  // Drop state for models that are no longer selectable at all (catalogue edits).
  for (const id of [...panes.keys()]) if (!getModel(id)) panes.delete(id);

  els.panes.style.setProperty('--pane-count', String(selected.length));
  activeTab = Math.min(activeTab, selected.length - 1);
  showTab(activeTab, false);
  syncTabs();
}

/** Mobile: scroll the track to a pane. Streams in other panes are untouched. */
function showTab(index, smooth = true) {
  activeTab = Math.max(0, Math.min(index, selected.length - 1));
  if (!els.panes.children[activeTab]) return;
  // Every pane is exactly one track-width wide, so index * clientWidth is the
  // scroll offset — and it's the exact inverse of what the scroll listener below
  // computes, so the tab strip and the track can never disagree. (No-op on
  // desktop, where the track is a grid with overflow-x: hidden.)
  // scrollTo's behavior option overrides the CSS scroll-behavior rule, so the
  // reduced-motion preference has to be honoured here too.
  const animate = smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  els.panes.scrollTo({ left: activeTab * els.panes.clientWidth, behavior: animate ? 'smooth' : 'auto' });
  syncTabs();
}

function syncTabs() {
  [...els.tabs.children].forEach((tab, i) => {
    const isActive = i === activeTab;
    tab.classList.toggle('is-active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  });
  els.tabs.classList.toggle('is-single', selected.length <= 1);
}

// Swipe is native scroll-snap; this only keeps the tab strip in sync with it.
let scrollSync;
els.panes.addEventListener('scroll', () => {
  clearTimeout(scrollSync);
  scrollSync = setTimeout(() => {
    const width = els.panes.clientWidth;
    if (!width) return;
    const index = Math.round(els.panes.scrollLeft / width);
    if (index !== activeTab && index >= 0 && index < selected.length) {
      activeTab = index;
      syncTabs();
    }
  }, 80);
});

// ─────────────────────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────────────────────

function appendMessage(pane, role, content, restoring = false) {
  const wrap = document.createElement('div');
  wrap.className = `msg msg-${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = role === 'user' ? escapeHtml(content).replace(/\n/g, '<br>') : renderMarkdown(content);

  wrap.append(bubble);
  pane.refs.body.append(wrap);
  if (!restoring) scrollPaneToEnd(pane);
  return bubble;
}

function scrollPaneToEnd(pane, force = false) {
  const body = pane.refs.body;
  // Don't yank the view if the reader has scrolled up to re-read something.
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 120;
  if (force || nearBottom) body.scrollTop = body.scrollHeight;
}

function setPaneState(pane, value) {
  pane.refs.dot.dataset.state = value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sending
// ─────────────────────────────────────────────────────────────────────────────

function wireComposer() {
  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    send();
  });

  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  els.input.addEventListener('input', autoGrow);
  els.stop.addEventListener('click', abortAll);
  els.newChat.addEventListener('click', newChat);
  updateSendLabel();
}

function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 160)}px`;
}

function send() {
  const prompt = els.input.value.trim();
  if (!prompt || inFlight.size > 0) return;

  // Hard cap independent of the UI — even if the checkboxes were tampered with,
  // we never fire more than MAX_MODELS parallel requests.
  const targets = selected.slice(0, MAX_MODELS);
  if (targets.length === 0) return;

  els.input.value = '';
  autoGrow();
  setBusy(true);

  // Kick every request off in the same tick. Nothing waits on anything else —
  // each pane renders its own stream the moment its first token lands.
  for (const id of targets) askModel(id, prompt);
}

/**
 * Attach a bubble for an in-flight response to the pane's (possibly brand-new)
 * DOM, showing whatever has streamed so far. Called both when the request
 * starts and again after any rebuildPanes() that happens mid-stream.
 */
function restoreStreamBubble(pane) {
  if (!pane.stream || !pane.refs) return;
  const bubble = appendMessage(pane, 'assistant', '', true);
  bubble.classList.add('is-streaming');
  bubble.innerHTML = pane.stream.text ? renderMarkdown(pane.stream.text) : TYPING_HTML;
  pane.refs.streamBubble = bubble;
}

async function askModel(id, prompt) {
  const pane = panes.get(id);
  if (!pane) return;

  pane.history.push({ role: 'user', content: prompt });
  appendMessage(pane, 'user', prompt);

  // Note the deliberate indirection: never capture the bubble element in this
  // closure. Toggling a model in the picker rebuilds every pane's DOM, and a
  // captured node would go detached — the answer would stream into nothing.
  // Always write through pane.refs, which rebuildPanes() keeps current.
  pane.stream = { text: '' };
  restoreStreamBubble(pane);
  setPaneState(pane, 'busy');

  const controller = new AbortController();
  inFlight.set(id, controller);

  let frame = null;
  // Abort rejections land a turn later than the abort() call, so by the time we
  // handle one, "New chat" may already have cleared this pane. Identity of the
  // stream object tells us whether this turn is still the pane's current one;
  // if it isn't, we must not touch history or the DOM.
  const stream = pane.stream;
  const isCurrent = () => pane.stream === stream;
  const live = () => (isCurrent() ? pane.refs?.streamBubble ?? null : null);
  const paint = () => {
    frame = null;
    const bubble = live();
    if (!bubble) return;
    bubble.innerHTML = renderMarkdown(stream.text);
    scrollPaneToEnd(pane);
  };

  try {
    await streamChat({
      model: id,
      messages: pane.history,
      signal: controller.signal,
      onDelta: (chunk) => {
        stream.text += chunk;
        // Coalesce repaints to one per frame — token-by-token innerHTML on four
        // panes at once is otherwise the thing that makes the UI stutter.
        if (frame === null) frame = requestAnimationFrame(paint);
      },
    });

    if (frame !== null) cancelAnimationFrame(frame);
    if (!isCurrent()) return;
    paint();

    const text = stream.text;
    if (text.trim()) {
      pane.history.push({ role: 'assistant', content: text });
    } else if (live()) {
      live().innerHTML = '<em class="muted">The model returned an empty response.</em>';
    }
    setPaneState(pane, 'done');
  } catch (err) {
    if (frame !== null) cancelAnimationFrame(frame);
    if (!isCurrent()) return;
    const text = stream.text;

    if (err?.name === 'AbortError') {
      // Keep whatever streamed before the user hit Stop, so the turn stays a
      // complete user/assistant pair. With nothing streamed, drop the user
      // message too — a dangling user turn breaks role alternation for the
      // providers that require it.
      if (live()) live().innerHTML = text ? renderMarkdown(text) : '<em class="muted">Stopped.</em>';
      if (text.trim()) pane.history.push({ role: 'assistant', content: text });
      else pane.history.pop();
      setPaneState(pane, 'idle');
    } else {
      // Failure is scoped to this pane. Every other pane keeps streaming.
      const message = err instanceof ChatError ? err.message : 'Something went wrong with this model.';
      const bubble = live();
      if (bubble) {
        bubble.classList.add('is-error');
        bubble.innerHTML =
          (text ? renderMarkdown(text) : '') +
          `<div class="pane-error"><strong>Error</strong>${escapeHtml(message)}</div>`;
      }
      // Roll the failed exchange out of history entirely (the user message we
      // just pushed). The transcript on screen still shows what happened, but
      // this model's context stays clean and strictly role-alternating for the
      // next prompt — some providers reject two user turns in a row.
      pane.history.pop();
      setPaneState(pane, 'error');
    }
  } finally {
    if (isCurrent()) {
      live()?.classList.remove('is-streaming');
      // Hand the bubble over to plain history rendering from here on.
      // isCurrent() compares pane.stream === stream and there is no await
      // between that check and this assignment, so nothing can interleave.
      // eslint-disable-next-line require-atomic-updates -- guarded by isCurrent()
      pane.stream = null;
      if (pane.refs) pane.refs.streamBubble = null;
      scrollPaneToEnd(pane);
    }
    inFlight.delete(id);
    if (inFlight.size === 0) setBusy(false);
  }
}

function setBusy(busy) {
  els.send.disabled = busy;
  els.stop.hidden = !busy;
  els.form.classList.toggle('is-busy', busy);
}

function abortModel(id) {
  inFlight.get(id)?.abort();
  inFlight.delete(id);
}

function abortAll() {
  for (const controller of inFlight.values()) controller.abort();
  inFlight.clear();
  setBusy(false);
}

function newChat() {
  abortAll();
  for (const pane of panes.values()) {
    pane.history = [];
    // Dropping the stream object is what tells a late-arriving abort handler
    // that its turn is stale and must not write back into the cleared pane.
    pane.stream = null;
    if (pane.refs) {
      pane.refs.body.innerHTML = '';
      pane.refs.streamBubble = null;
      setPaneState(pane, 'idle');
    }
  }
  els.input.focus();
}

// ─────────────────────────────────────────────────────────────────────────────
// Connectivity
// ─────────────────────────────────────────────────────────────────────────────

function wireConnectivity() {
  const sync = () => els.offline.toggleAttribute('hidden', navigator.onLine);
  window.addEventListener('online', sync);
  window.addEventListener('offline', sync);
  sync();
}

// ─────────────────────────────────────────────────────────────────────────────
// Service worker
// ─────────────────────────────────────────────────────────────────────────────

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch((err) => console.warn('SW registration failed:', err));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Version check / update banner
//
// This is additive to the service worker's own update lifecycle, not a
// replacement for it. iOS Safari is unreliable about surfacing an SW update to
// an installed PWA, so we also compare the build we were served against against
// the build the server is currently on.
// ─────────────────────────────────────────────────────────────────────────────

function startVersionWatch() {
  checkVersion();

  // Foreground only — a background poll costs battery and data for nothing.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkVersion();
  });

  els.updateButton.addEventListener('click', applyUpdate);
}

async function checkVersion() {
  const loaded = window.__APP_VERSION__;
  if (!loaded || loaded === 'dev' || !navigator.onLine) return;

  try {
    // cache:no-store on the client, Cache-Control:no-store from vercel.json.
    // Both are needed: either one alone can be defeated by the other layer.
    const response = await fetch('/version.json', { cache: 'no-store' });
    if (!response.ok) return;
    const { version } = await response.json();
    if (version && version !== loaded) els.updateBanner.removeAttribute('hidden');
  } catch {
    /* offline or blocked — try again next time the app is foregrounded */
  }
}

async function applyUpdate() {
  els.updateButton.disabled = true;
  els.updateButton.textContent = 'Updating…';

  let reloaded = false;
  const reload = () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', reload);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        await registration.update();
        // The new SW calls skipWaiting() itself, but nudge it if it's parked.
        registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
      }
    } catch {
      /* fall through to the timed reload */
    }
  }

  // Don't wait forever on controllerchange — reload regardless.
  setTimeout(reload, 1500);
}

init();
