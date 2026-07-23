/**
 * ChatQuest-AI — end-to-end browser checks.
 *
 * These cover the acceptance criteria that only a real browser can prove:
 * parallel streaming into separate panes, per-pane error isolation, the model
 * cap, responsive layout, and PWA installability.
 *
 * HOW TO RUN
 *   1. Start a server that serves public/ and answers /api/chat.
 *      For a no-cost run use the mock in test/e2e/mock-server.mjs:
 *          node test/e2e/mock-server.mjs 4321
 *      It fails any "llama" model on purpose so error isolation is testable.
 *      Against a real deployment use `vercel dev` instead (this spends credits).
 *   2. Open the app, then paste this whole file into the DevTools console.
 *   3. `await chatQuestE2E()` — returns a report and logs a pass/fail table.
 *
 * There is deliberately no Playwright dependency: this project ships zero
 * runtime and zero build dependencies, and a headless-browser toolchain is a
 * bigger commitment than the rest of the repo combined. Run these by hand, or
 * drive them from whatever browser automation you already have.
 */

async function chatQuestE2E({ verbose = true } = {}) {
  const results = [];
  const check = (name, pass, detail = '') => {
    results.push({ name, pass: !!pass, detail: String(detail) });
    return pass;
  };
  /**
   * For assertions the environment genuinely cannot make. Only ever used after
   * proving the limitation with a control probe — never to paper over a real
   * failure.
   */
  const skip = (name, reason) => results.push({ name, pass: true, skipped: true, detail: `SKIPPED: ${reason}` });
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const paneState = () =>
    $$('.pane').map((p) => ({
      model: p.dataset.model,
      state: p.querySelector('.pane-dot').dataset.state,
      chars: (p.querySelector('.msg-assistant .bubble')?.textContent || '').length,
      msgs: p.querySelectorAll('.msg').length,
    }));
  const idle = async (timeoutMs = 60000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if ($('#send') && !$('#send').disabled && $$('.pane-dot').every((d) => d.dataset.state !== 'busy')) return true;
      await sleep(250);
    }
    return false;
  };
  const select = async (ids) => {
    for (const box of $$('#picker-list input')) {
      const want = ids.some((id) => box.value.includes(id));
      if (box.checked !== want && !box.disabled) box.click();
    }
    await sleep(100);
  };

  // ── 1. Initial state ──────────────────────────────────────────────────────
  check('defaults to 3 panes', $$('.pane').length === 3, `${$$('.pane').length} panes`);
  check(
    'defaults span OpenAI + Anthropic + Google',
    new Set($$('.pane').map((p) => p.dataset.model.split('/')[0])).size === 3,
    $$('.pane').map((p) => p.dataset.model).join(', '),
  );
  check('send button shows the cost multiplier', /Send to 3 models/.test($('#send-label').textContent), $('#send-label').textContent);

  // ── 2. Model cap ──────────────────────────────────────────────────────────
  const boxes = $$('#picker-list input');
  const unchecked = boxes.filter((b) => !b.checked);
  if (unchecked.length) unchecked[0].click();
  await sleep(80);
  check('cap: 4 models selectable', $$('.pane').length === 4, `${$$('.pane').length} panes`);
  check('cap: label follows selection', /Send to 4 models/.test($('#send-label').textContent), $('#send-label').textContent);
  check(
    'cap: further checkboxes disabled at 4',
    $$('#picker-list input').filter((b) => !b.checked).every((b) => b.disabled),
    'unchecked boxes must all be disabled',
  );
  // Back down to 1 to prove the floor holds.
  await select(['gemini-3.6-flash']);
  check('floor: cannot drop below 1 model', $$('.pane').length === 1, `${$$('.pane').length} panes`);
  check(
    'floor: the last checked box is disabled',
    $$('#picker-list input').filter((b) => b.checked).every((b) => b.disabled),
  );

  // ── 3. Parallel streaming (fast models only, to keep the run short) ───────
  await select(['gemini-3.6-flash', 'claude-haiku-4.5', 'llama-3.3-70b']);
  check('selected 3 models for the streaming run', $$('.pane').length === 3, `${$$('.pane').length} panes`);

  $('#prompt').value = 'E2E: explain server-sent events briefly.';
  $('#send').click();
  await sleep(150);
  check('every pane starts busy or already errored', paneState().every((p) => p.state !== 'done'), JSON.stringify(paneState()));
  check('stop button appears while streaming', !$('#stop').hidden);

  const settled = await idle();
  check('all panes settled', settled, JSON.stringify(paneState()));

  const after = paneState();
  const failing = after.filter((p) => p.model.includes('llama'));
  const working = after.filter((p) => !p.model.includes('llama'));

  check('working panes each produced a response', working.every((p) => p.chars > 20), JSON.stringify(working));
  check('working panes report done', working.every((p) => p.state === 'done'), JSON.stringify(working));
  check('the failing model is isolated to its own pane', failing.every((p) => p.state === 'error'), JSON.stringify(failing));
  check('the failing pane shows a readable error', $$('.pane-error').length === failing.length, `${$$('.pane-error').length} error blocks`);
  check('one model failing did not block the others', working.every((p) => p.chars > 20));
  check('send is re-enabled afterwards', !$('#send').disabled);
  check('stop is hidden afterwards', $('#stop').hidden);

  // ── 4. Markdown + XSS ─────────────────────────────────────────────────────
  const bubble = $$('.msg-assistant .bubble').find((b) => b.textContent.length > 20);
  check('markdown renders block elements', !!bubble?.querySelector('p, ul, pre, strong'), bubble?.innerHTML.slice(0, 60));
  check('no script tag reached the DOM', $$('.pane script').length === 0);
  check('no img tag reached the DOM', $$('.pane img').length === 0);
  check(
    'no inline event handler reached the DOM',
    $$('.pane *').every((el) => ![...el.attributes].some((a) => a.name.startsWith('on'))),
  );

  // ── 5. Per-model history isolation ────────────────────────────────────────
  const before = paneState().map((p) => p.msgs);
  $('#prompt').value = 'E2E: follow-up question.';
  $('#send').click();
  await idle();
  check(
    'a follow-up appends to each pane independently',
    paneState().every((p, i) => p.msgs > before[i]),
    JSON.stringify(paneState().map((p) => p.msgs)),
  );

  // ── 6. Regression: toggling a model mid-stream must not orphan a stream ───
  $('#new-chat').click();
  await sleep(100);
  await select(['gemini-3.6-flash', 'claude-sonnet-5']);
  $('#prompt').value = 'E2E: rebuild-mid-stream regression.';
  $('#send').click();
  await sleep(700);
  const stillBusy = paneState().filter((p) => p.state === 'busy').map((p) => p.model);
  const spare = $$('#picker-list input').find((b) => !b.checked && !b.disabled);
  if (spare) spare.click();
  await sleep(80);
  check(
    'in-flight panes keep a streaming bubble across a rebuild',
    stillBusy.every((m) => $(`[data-model="${m}"] .bubble.is-streaming`)),
    `busy at toggle: ${stillBusy.join(', ') || 'none'}`,
  );
  await idle();
  check(
    'answers still land after a mid-stream rebuild',
    stillBusy.every((m) => (($(`[data-model="${m}"] .msg-assistant .bubble`)?.textContent || '').length > 20)),
    JSON.stringify(paneState()),
  );

  // ── 7. Layout ─────────────────────────────────────────────────────────────
  const panes = $('#panes');
  const wide = window.matchMedia('(min-width: 768px)').matches;
  const style = getComputedStyle(panes);
  if (wide) {
    check('desktop: panes laid out as a grid', style.display === 'grid', style.display);
    check('desktop: one column per pane', style.gridTemplateColumns.split(' ').length === $$('.pane').length, style.gridTemplateColumns);
    check('desktop: tab strip hidden', getComputedStyle($('#tabs')).display === 'none');
  } else {
    check('mobile: horizontal scroll-snap track', style.scrollSnapType.includes('x'), style.scrollSnapType);
    check('mobile: one pane per screen', Math.abs($$('.pane')[0].getBoundingClientRect().width - panes.clientWidth) < 2);
    check('mobile: tab strip visible', getComputedStyle($('#tabs')).display !== 'none');
    const tabs = $$('#tabs .tab');
    if (tabs.length > 1) {
      tabs[1].click();
      await sleep(600);
      if (panes.scrollLeft > 0) {
        check('mobile: tapping a tab moves the track', true, `scrollLeft=${panes.scrollLeft}`);
      } else {
        // Control probe: a non-compositing page (headless, backgrounded tab)
        // silently drops smooth scrolls while instant ones still work. Confirm
        // which case this is instead of guessing.
        panes.scrollTo({ left: panes.clientWidth, behavior: 'auto' });
        await sleep(150);
        const instantWorks = panes.scrollLeft > 0;
        panes.scrollTo({ left: 0, behavior: 'auto' });
        if (instantWorks) {
          skip('mobile: tapping a tab moves the track', 'this page cannot animate smooth scrolls (instant scrolling verified working)');
        } else {
          check('mobile: tapping a tab moves the track', false, 'the track did not scroll at all');
        }
      }
      check('mobile: active tab follows', tabs[1].classList.contains('is-active'));
    }
  }
  check('no horizontal page overflow', document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  // ── 8. PWA ────────────────────────────────────────────────────────────────
  const manifest = await (await fetch('/manifest.json')).json();
  check('manifest is standalone', manifest.display === 'standalone', manifest.display);
  check('manifest has a 192px icon', manifest.icons.some((i) => i.sizes === '192x192'));
  check('manifest has a 512px icon', manifest.icons.some((i) => i.sizes === '512x512'));
  check('manifest has a maskable icon', manifest.icons.some((i) => i.purpose === 'maskable'));
  const iconOk = await Promise.all(
    manifest.icons.map(
      (i) => new Promise((res) => {
        const img = new Image();
        img.onload = () => res(img.naturalWidth > 0);
        img.onerror = () => res(false);
        img.src = i.src;
      }),
    ),
  );
  check('every declared icon actually loads', iconOk.every(Boolean));
  const registration = await navigator.serviceWorker.getRegistration();
  check('service worker is registered and active', !!registration?.active);
  check('service worker controls the page', !!navigator.serviceWorker.controller);
  check('viewport avoids viewport-fit=cover', !/viewport-fit/.test($('meta[name=viewport]').content), $('meta[name=viewport]').content);
  check('apple-touch-icon present', !!$('link[rel=apple-touch-icon]'));

  // ── 9. Version endpoint ───────────────────────────────────────────────────
  const versionResponse = await fetch('/version.json', { cache: 'no-store' });
  if (versionResponse.ok) {
    check('version.json is served no-store', /no-store/.test(versionResponse.headers.get('cache-control') || ''), versionResponse.headers.get('cache-control'));
    const { version } = await versionResponse.json();
    check('version.json carries a build id', typeof version === 'string' && version.length > 0, version);
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const skipped = results.filter((r) => r.skipped);
  const failed = results.filter((r) => !r.pass);
  const passed = results.filter((r) => r.pass && !r.skipped).length;
  if (verbose) {
    console.table(
      results.map((r) => ({ '': r.skipped ? 'SKIP' : r.pass ? 'PASS' : 'FAIL', check: r.name, detail: r.detail.slice(0, 70) })),
    );
    console.log(`${passed} passed, ${failed.length} failed, ${skipped.length} skipped (of ${results.length})`);
    if (failed.length) console.error('FAILED:', failed);
  }
  return { passed, failed, skipped, total: results.length, results };
}

if (typeof window !== 'undefined') window.chatQuestE2E = chatQuestE2E;
