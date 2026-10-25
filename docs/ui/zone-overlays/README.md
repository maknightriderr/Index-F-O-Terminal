# Dashboard proportions and candle zones correction

Base: `c0db8e3470d90a63f9b19c1e6d4032f9cdc3a298` (PR #63).

The previous dashboard kept a wide sidebar and only used three columns above 1500px. Its engine-snapshot adapter explicitly withheld order-block geometry; FVG support consisted of optional engine lifecycle boundary lines. Consequently it did not deliver the shaded OB/FVG chart or laptop proportions implied by the illustrative mockup.

## Changes

- Dashboard-only compact navigation rail; all existing pages and asset workspaces remain reachable via All pages. Other pages retain their existing navigation.
- Watchlist, chart and spotlight columns start at 1280px; narrower screens stack. Both light and dark palettes remain supported.
- Default chart interval is now 15m. OB and FVG controls default on, with a separate ended-zones toggle and an accessible list of exact zone bounds and lifecycle states.
- The frontend reuses canonical `detectOrderBlocks` (OB-2.0) and `detectFairValueGaps` on the selected chart's own loaded closed OHLC candles. A native chart primitive renders shaded rectangles using current time/price coordinates. No synthetic geometry or additional API requests are introduced.
- Zone origin is the confirmation candle, not the earlier opposing/impulse candle. Mitigated OBs and touched FVGs stop at the first qualifying closed candle and are hidden by default. FVG uses the shared detector's touch definition, not a full-fill definition. At most six zones per family are displayed.
- Invalid, non-positive, inverted, duplicate or unordered OHLC history yields no zones. Identity guards prevent reuse across instrument, timeframe or Spot/Futures changes; failed history clears the previous zones. Index spot engine levels are withheld on futures charts.

These are **chart analysis zones**, not a feed of stored OB1 entries or proof of an actionable setup. Loaded-history limits and different chart timeframes may produce different geometry from backend strategy windows. Forming candles are excluded; lifecycle updates follow historical candle refreshes, not every tick. Daily candles use a conservative 24-hour close boundary. No qualifying zones means zero displayed, not invented zones. This does not provide Order Flow footprint/delta geometry.

## Executed validation

Actual command outputs are in `evidence/`:

- Web tests: **130 passed, 19 files**. Eight new cases independently assert hand-calculated bullish/bearish bounds, confirmation timing, exact-boundary FVG touch, OB mitigation, invalid history and controls.
- Web TypeScript: passed. Production build: passed.
- ESLint on new modules, tests, sidebar and chart section: passed. Including the existing InstrumentChart file reports three pre-existing violations (one synchronous effect state update and two explicit `any` uses). Running ESLint on the base version reproduces the same three; both outputs are retained. A completely clean repository-wide lint run is not claimed.
- Chromium against the production build with isolated API fixtures: detected OB/FVG, dark/light contrast and accessible names, zone toggle, 1366px three-column layout, All pages menu, theme persistence and OS changes, MCX Spot disabled, mobile overflow, and failed-history clearing passed. No page errors or API writes. Screenshots were inspected locally; OB 24510–24525 and FVG 24525–24580 appeared as shaded rectangles in dark/light rendering. Images are excluded from the PR.

Browser fixture data is synthetic and labelled; it tests rendering and state handling, not strategy returns or live feed correctness. Repeat with `scripts/ui/trading-desk-browser.cjs` as described in the earlier trading-desk report. In restricted containers, use `next start --hostname 127.0.0.1` and set `DESK_QA_URL` accordingly. The optional external Chromium helper is not an application dependency.

## Scope and rollback

No backend strategy, trade entry/exit, size calculation, database schema, API contract or broker write is changed. No configuration migration is needed. Revert this change or redeploy the previous frontend to roll back; existing trade records remain untouched. Live authenticated rendering needs a post-deployment smoke check. No profitability improvement is asserted. The layout follows the reference proportions without claiming pixel-identical live content.
