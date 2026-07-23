# ChatQuest-AI

Ask one question. Watch ChatGPT, Claude and Gemini answer it side by side, streaming in parallel.

An installable PWA — vanilla HTML/CSS/JS, no framework, no build step for the app code — deployed on Vercel with a single serverless function proxying OpenRouter.

---

## How it works

```
browser                          Vercel edge                    OpenRouter
───────                          ───────────                    ──────────
one prompt
  ├── POST /api/chat {model A} ──► api/chat.js ── Bearer key ──► model A ──┐
  ├── POST /api/chat {model B} ──► api/chat.js ── Bearer key ──► model B ──┤ SSE
  └── POST /api/chat {model C} ──► api/chat.js ── Bearer key ──► model C ──┘
       three independent streams, three independent panes
```

**One model per request.** The proxy is deliberately single-model — the client fans out. That keeps streaming simple and, more importantly, keeps failures isolated: a rate-limited Gemini shows an error in the Gemini pane while Claude and ChatGPT keep streaming untouched. A server-side fan-out endpoint would couple all of them to one function invocation.

**The API key never leaves the server.** `OPENROUTER_API_KEY` is read from `process.env` inside the edge function. It is not in any bundle, any response body, or any log line. The browser only ever talks to `/api/chat`.

---

## Layout

| | |
|---|---|
| **Desktop** (≥768px) | N panes as CSS grid columns, all streaming at once |
| **Mobile** | One full-width pane, swipe or tap the tab strip to move between models |

Same DOM either way — the mobile track is a `scroll-snap` flex row that becomes a grid at the breakpoint. Off-screen panes are never paused; every stream is an independent `fetch` that keeps writing into its own detached DOM whether or not you're looking at it.

## Cost

Firing at N models bills N times per prompt. The send button says **"Send to 3 models"** so the multiplier is on screen before you commit, not a surprise on the OpenRouter invoice. The picker is capped at 4 models, enforced both in the UI (checkboxes go dead at the cap) and in `send()` (`selected.slice(0, MAX_MODELS)`), so bypassing the UI doesn't buy you extra parallel calls.

Run `npm run verify` to print current per-token pricing for every model on the allow-list.

---

## Setup

### 1. Install and deploy

```bash
npm i -g vercel
vercel link
```

### 2. Set the API key

Get a key at [openrouter.ai/keys](https://openrouter.ai/keys), then add it in the Vercel dashboard:

**Project → Settings → Environment Variables**

| Name | Value | Environments |
|---|---|---|
| `OPENROUTER_API_KEY` | `sk-or-v1-…` | Production, Preview, Development |

Do not put the key in code, in `vercel.json`, or in a committed `.env`. `.env*` is gitignored (`.env.example` excepted).

If you serve the app from a custom domain, also set `ALLOWED_ORIGINS` to a comma-separated list of those origins — see [.env.example](.env.example).

### 3. Deploy

```bash
vercel --prod
```

### Local development

```bash
cp .env.example .env.local   # fill in OPENROUTER_API_KEY
vercel dev
```

`vercel dev` runs the edge function alongside the static files, so `/api/chat` works locally. A plain static server will serve the UI but every send will fail — there's no proxy to hit. `http://localhost:*` is allow-listed by the origin check.

---

## Editing the model list

Everything lives in [public/js/models.js](public/js/models.js) — a single source of truth imported by **both** the browser (to build the picker) and the proxy (to validate the incoming `model` field). There is no second copy to keep in sync, and no way for the client to smuggle an unlisted model past the server.

```js
{
  id: 'openai/gpt-5.6-sol',      // must be a valid OpenRouter slug
  label: 'ChatGPT — GPT-5.6 Sol',
  provider: 'OpenAI',
  description: 'OpenAI flagship. Strongest general reasoning…',
  default: true,                  // pre-checked on first load
}
```

After editing:

```bash
npm run verify
```

That checks every slug against OpenRouter's live catalogue and prints pricing. A typo'd slug otherwise surfaces as a runtime 404 in one pane.

The default selection is one OpenAI + one Anthropic + one Google. Keep `default: true` on exactly one model per provider and no more than four total.

---

## Version check and the update banner

PWAs go stale. iOS Safari in particular is unreliable about surfacing a service worker update to an installed app, so this project doesn't rely on the SW lifecycle alone.

**Every build**, `scripts/generate-version.js` stamps one identifier — `VERCEL_GIT_COMMIT_SHA` on Vercel, the local commit or a timestamp otherwise — into three places:

| Where | What it does |
|---|---|
| `public/version.json` | what the server currently reports |
| `public/index.html` | `window.__APP_VERSION__` — the version *this page* was built with |
| `public/service-worker.js` | `BUILD_VERSION`, which keys the cache name |

The client compares the constant baked into the loaded page against the freshly-fetched `version.json`. Both come from the same script run, so they can't drift the way two independently-fetched values can. Nothing is hand-bumped — the identifier changes on every deploy by construction.

Because `BUILD_VERSION` keys the cache name, a new build gets a brand-new cache and `activate` deletes the old one. A new build can never read the previous build's shell.

**`version.json` must be served `Cache-Control: no-store`** — set in [vercel.json](vercel.json), scoped to that one path. If either the browser or Vercel's edge CDN caches it, the client compares against a stale value forever and the whole mechanism silently dies. The client also passes `cache: 'no-store'` on the fetch; both layers are needed, either one alone can be defeated by the other.

The check runs on load and on `visibilitychange` when the app is foregrounded — not on a background poll, which costs battery and data for nothing. On a mismatch you get a non-blocking banner; tapping **Refresh** calls `registration.update()`, nudges a parked worker with `SKIP_WAITING`, and reloads once the new worker takes control (with a 1.5s timeout fallback).

This is *additive* to the normal SW lifecycle, not a replacement — `skipWaiting()` and `clients.claim()` are still in [public/service-worker.js](public/service-worker.js).

---

## Abuse protection

`/api/chat` is public and unauthenticated, so the realistic threat is someone embedding it in their own page and burning your OpenRouter quota. The function rejects any request whose `Origin` (or `Referer` origin) isn't the deployment's own host, a `VERCEL_*_URL`, an entry in `ALLOWED_ORIGINS`, or `localhost`. A request with neither header — a bare `curl` — is rejected outright.

This is not authentication; `Origin` is trivially spoofed by a non-browser client. It stops the drive-by case, which is what it's for. If this ever gets real traffic, add rate limiting keyed on IP.

Beyond that, the proxy:

- validates `model` against the allow-list before forwarding anything upstream
- caps message count and total payload size
- maps upstream failures to clean messages (`rate_limited`, `insufficient_credits`, `model_unavailable`, …) and never forwards a raw OpenRouter error body
- never logs the key

---

## Changing the app icon

Replace [assets/app-icon.png](assets/app-icon.png) and rebuild:

```bash
npm run build
```

Every icon is derived from that one file — nothing is hand-exported, so the sizes can't drift apart. The generator (no image dependencies, just `zlib`) does three things worth knowing about:

- **Keys out the surround.** The source is opaque RGB with white around the plate; shipped as-is that's a white square on the home screen. The background is flood-filled inwards from the four corners, so the white letters of the wordmark — enclosed by the dark plate — are never touched.
- **Sizes the maskable icon automatically.** Android crops maskable icons to whatever shape the launcher likes, guaranteeing only the middle 80%. The script measures how far the real content (bright or saturated pixels, ignoring the plate and its rounded corners) sits from centre and scales to fit inside that circle. With the current artwork that lands at 64%, with 21px of headroom at 512. Swap in different artwork and the scale re-derives itself rather than silently clipping.
- **Emits a separate opaque `apple-touch-icon.png`.** iOS ignores alpha and flattens it against black, and applies its own squircle, so it needs full bleed rather than the maskable inset.

Ideal source artwork: square, at least 512×512 (1024 is better), with important detail away from the very edge.

## Verifying a deploy

```bash
# version.json must be no-store — check the header, don't assume it
curl -sI https://<your-domain>/version.json | grep -i cache-control

# the endpoint must reject a request with no matching Origin
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<your-domain>/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"model":"anthropic/claude-sonnet-5","messages":[{"role":"user","content":"hi"}]}'
# expect: 403

# an unlisted model must be rejected before it reaches OpenRouter
curl -s -X POST https://<your-domain>/api/chat \
  -H 'Content-Type: application/json' -H 'Origin: https://<your-domain>' \
  -d '{"model":"evil/not-real","messages":[{"role":"user","content":"hi"}]}'
# expect: 400 {"error":"That model is not on the allow-list.","code":"model_not_allowed"}
```

Then in the browser: DevTools → Network → send a prompt → confirm no request or response anywhere contains `sk-or-`, and that `/api/chat` shows three separate in-flight requests rather than one.

---

## Not in v1 (deliberately)

- **Cross-model synthesis** — no "which answer is best" meta-layer. v1 shows raw parallel outputs and lets you judge.
- **Accounts, auth, persisted history** — conversations live in memory for the session only. Reload and they're gone.
- **Dynamic model catalogue** — the allow-list is curated and hardcoded. OpenRouter lists hundreds of models; almost none are relevant here.
- **Server-side fan-out** — the proxy stays single-model. See the top of this README for why.

---

## Project structure

```
api/chat.js                  OpenRouter proxy (Vercel Edge Function)
public/index.html            app shell + build-version constant
public/manifest.json         PWA manifest
public/service-worker.js     offline shell cache, version-keyed
public/version.json          generated every build (gitignored)
public/css/styles.css
public/js/models.js          allow-list — shared by browser AND proxy
public/js/api-client.js      the only module that knows /api/chat's wire format
public/js/app.js             UI, panes, streaming, update banner
public/icons/                generated PNGs (192, 512, maskable, apple-touch)
scripts/generate-version.js  stamps the build id into all three places
assets/app-icon.png          source artwork for the icons
scripts/generate-icons.js    derives every icon size from it — no image dependencies
scripts/verify-models.js     checks the allow-list against OpenRouter's catalogue
vercel.json                  cache headers (version.json no-store) + security headers
```

## Licence

MIT
