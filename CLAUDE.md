# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository overview

Wealthr is a **client-side-only** personal finance PWA served from `getwealthr.com`. The whole thing is static HTML/CSS/JS — no build step, no bundler, no framework, no package.json. There are only three real pages:

- `index.html` — marketing landing page.
- `app.html` — the entire app (~5.6k lines, single file containing HTML, CSS, and JS). This is where almost all engineering work happens.
- `privacy.html` — privacy policy.

Supporting files: `sw.js` (service worker), `manifest.json` (PWA manifest), `offline.html`, `404.html`, `icons/`, `apple-touch-icon.png`, `sitemap.xml`, `robots.txt`, `googlee5dfa675bb6254c5.html` (Google site-verification).

Note: `_redirects` in the repo root is actually a PNG (likely committed by mistake), not a Netlify redirects file. Don't treat it as config.

## Development workflow

There is no build, lint, test, or dev-server tooling in this repo. To develop:

- Edit the HTML file(s) directly. `app.html` holds the app's inline `<style>` and inline `<script>` — both are in one file on purpose.
- Serve the directory statically to exercise service-worker / PWA behavior (SW only registers over HTTPS or `localhost`). Any static server works, e.g. `python3 -m http.server 8000` then open `http://localhost:8000/app.html`.
- When the service worker's cached assets change, bump the `CACHE` version in `sw.js` (`wealthr-v12` → `wealthr-v13`…). The activate handler deletes stale caches only when the version string changes.
- When shipping a change that alters localStorage shape, consider the `SK = 'pf_v5'` key in `app.html` — the whole app state lives under that single key inside a wrapping `__pf_all` object.

## Architecture

### Data layer

All user data is persisted **locally** in the browser. No backend, no sync, no account system. Two layers:

- `localStorage` under a single key `__pf_all` (a JSON object of all settings). Inside it, the main app state blob lives at key `pf_v5` (see `SK` in `app.html`). Helpers: `lsGet` / `lsSet` / `lsDel`, and `load()` / `save()` for the structured state (shape defined by `def()` at around `app.html:2319`).
- `IndexedDB` database `wealthr-sw`, store `kv`. Used as a bridge between the page and the service worker (which can't read `localStorage`). `swSyncData()` mirrors `bills` and `isPro` into IDB so `sw.js` can fire bill-reminder notifications from `periodicsync` / `push` events without a live client.

`save()` is the single source of truth for writing state. It also recomputes net-worth badges, triggers `nwAutoSnapshot`, and fires `backupReminder`. Prefer calling `save(s)` after mutating the loaded state rather than writing to localStorage directly.

### Pro / free gating

- `isPro()` returns true if `pf_pro === '1'` or a demo flag is set.
- Free-tier caps live in `FREE_LIMITS = { bank: 3, portfolio: 3, crypto: 3, budgetCats: 3 }`. Use `atLimit(type)` before add flows, and call `showProModal(reason)` when blocked.
- Several whole tabs (`pension`, `property`, `news`, plus features like bill reminders, subscriptions, CSV import/export, multi-currency, history snapshots, custom app name) are Pro-only. Gate them with `if (!isPro()) return showProModal(...)`.

### UI structure

- `TABS` defines all 12 tabs (Overview, Budget & Bills, Bank, Portfolio, Crypto, Cards, Loans, Pension, Property, News, Settings, FAQ). Each tab is a `.panel` element; `switchTab(id)` toggles `.active`.
- `NAV_ITEMS` is the 5-slot bottom nav plus a "More" drawer (`MORE_TABS`) for everything else. The sidebar uses `SIDEBAR_CATEGORIES`.
- Per-tab render/add/remove functions follow a `<prefix>Render / <prefix>Add / <prefix>Remove` convention, e.g. `pfRender` (portfolio), `bkRender` (bank), `billsRender`, etc. When editing a tab, find the prefix and keep the pattern.

### Security-sensitive areas

Past review work hardened these — preserve the conventions when extending them:

- **XSS**: user-controllable strings rendered into `innerHTML` must be escaped. Use `esc()` (at `app.html:1795`) or assign via `textContent`. Don't reintroduce raw template-literal interpolation of user input into `innerHTML`.
- **PIN lock**: PINs are salted + PBKDF2-SHA-256 (100k iterations) via `_pinDeriveHash` / `_pinVerify` / `_pinSet`. Stored as `pf_lock_pin_hash` + `pf_lock_pin_salt`. A legacy plain `pf_lock_pin` path still exists for migration — don't write new plaintext PINs. Failed attempts are rate-limited (5 tries → 60s lockout via `pf_lock_attempts` / `pf_lock_locked_until`).
- **Modals**: `_ESC_CLOSEABLE_MODALS` and `_FOCUS_TRAP_MODALS` drive a11y behavior — new modals should be registered in these arrays.
- **Rate limiting**: `_isRateLimited` / `_setRateLimit` / `_rateLimitRemaining` wrap outbound fetches; services that return HTTP 429 should parse `Retry-After` and call `_setRateLimit(service, retryAfter)`. Surface the remaining time to the user via `toast()`.

### External APIs

All contacted directly from the browser; no backend proxy of our own. Several require a CORS proxy (`corsproxy.io` then `allorigins.win` as fallback). Keep requests behind explicit user actions (refresh buttons) so privacy-sensitive tickers/postcodes/wallets aren't sent unless asked:

- Twelve Data — stock prices (user-provided API key stored locally in Settings).
- CoinGecko — crypto prices + BTC/Gold market-data widget.
- open.er-api.com — FX rates.
- Yahoo Finance (chart endpoint via CORS proxy) — FTSE/S&P.
- Land Registry SPARQL — UK sold-price lookup by postcode.
- Blockstream — Bitcoin wallet balance lookup.
- Multiple RSS feeds (BBC, Sky, CNBC, Bloomberg, Guardian, Reuters, FT, Yahoo Finance) via CORS proxy — news.
- Bank of England / treasury fiscaldata — base rate.

If you add a new external API: update the allow-list in `privacy.html` §4, add a CORS-proxy fallback, wrap with `AbortSignal.timeout(...)`, handle 429 via the rate-limit helpers, and decide whether `sw.js`'s fetch handler should network-first it (see the `coingecko|blockstream|fonts.google|twelvedata|allorigins|corsproxy|er-api` allow-list in `sw.js:21-24`).

### Service worker

- `sw.js` caches `offline.html` on install and is network-first for third-party API hosts, cache-first for everything else.
- Periodic background sync (`bill-reminders`) and `push` fallback both call `checkBillsAndNotify()`, which reads bills from IndexedDB (populated by `swSyncData()` on the page side) and fires local notifications. The SW cannot read `localStorage`.
- Don't cache third-party API responses — they're explicitly excluded so the app shows fresh prices.

## Conventions

- Keep everything inline in `app.html`. There is intentionally no module system, no split files, no external bundles. A PR that extracts JS into separate files is a bigger change than it looks — the deployment pipeline expects three HTML files plus `sw.js` and `manifest.json`.
- Currency is GBP-first; Pro users may switch via `pfSetCurrency`. Format money with `fmt$` / `fmtCurrency`, never hand-format.
- After any state mutation, call `save(state)` — it recomputes summary badges and handles auto-snapshotting. Don't duplicate that logic.
- When adding a new tab: add an entry to `TABS`, add a `.panel` div in the markup, add the tab to `MORE_TABS` or `NAV_ITEMS` as appropriate, and gate it in `switchTab` if Pro-only.
- Copyright header at the top of `app.html` states the code is proprietary — don't remove it.
