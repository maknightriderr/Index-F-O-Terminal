# F&O Terminal — Detailed Architecture

A complete map of every layer, service and data flow in the F&O Terminal monorepo.

> Source of truth for the architecture. It supersedes `FNO_Terminal_Architecture.pdf` (no editable source existed for the PDF); every change to a schema, API, state machine or trading-path rule updates this file in the same change. Change log at the end.

---

## 1. Monorepo layout

```
Index + F&O Terminal/            ← Turborepo monorepo root
├── apps/
│   ├── server/                  ← Express + Node.js backend
│   └── web/                     ← Next.js 14 frontend
├── packages/
│   ├── analytics/               ← Pure TS calculation library (no IO, no clock, no network)
│   └── shared/                  ← Shared types, constants, utilities (used by all)
├── database/init/               ← PostgreSQL + TimescaleDB schema scripts (NNN_name.sql, idempotent)
└── docs/                        ← This document + audits
```

Build: Turborepo (`turbo.json`) with pnpm workspaces. Deployment: Railway (server + Postgres + Redis) and Vercel (web); `docker-compose.yml` for local infra.

## 2. High-level system

```
EXTERNAL WORLD
  Angel One SmartAPI (broker REST + WebSocket) · NSE endpoints (FII/DII, corporate actions) · Anthropic Claude API (AI assistant)
        │
        ▼
apps/server (Node.js / Express)
  AngelOneProvider ──► SubscriptionManager ──► WS Bridge (/ws)
  (REST + WS auth)      (upstream WS, ref-counting)   (frontend-facing)
  REST API /api/*: auth · instruments · market · option-chain · futures · alerts · ai-assistant ·
    institutional-flow · backtesting · learning · loss-attribution · structure · market-scanner ·
    strategy-scanner · fii-dii · news · corporate-actions · diagnostics · health
  Background services (18, see §8)
  PostgreSQL + TimescaleDB (setups, events, OI, learning)   Redis (quote cache, OHLCV, OI baseline, live state)
        │  WebSocket /ws · REST /api/*
        ▼
apps/web (Next.js 14)
  TerminalApp → AppShell → 18 UI pages · MarketWebSocketClient (one per tab) ·
  Zustand stores (market, ui, system-health) · REST hooks (useMarketBias, useFnoScanner, …)
```

## 3. Server boot sequence

1. `AngelOneProvider` created (singleton).
2. `SubscriptionManager` created (holds the provider).
3. Express configured: helmet, CORS, compression, rate-limiter, request-priority; all `/api/*` routes mounted.
4. HTTP server `listen()`.
5. WebSocket bridge on the same server (`/ws`).
6. `authenticateOnBoot()`: reads `ANGEL_ONE_*`, `provider.authenticate()` (TOTP); on success `subscriptionManager.connect()` (upstream WS).
7. Background services launched (fire-and-forget today; see §8 and Phase 6).
8. Token refresh every 8 h: `provider.refreshAuth()` or a full TOTP re-login.

## 4. Live market data (ticks)

```
Angel One WebSocket (SNAP_QUOTE)
  ▼
SubscriptionManager.handleTicks()
  ├─► computeChangeOi()          enrich each tick with changeOi
  ├─► latestQuotes Map           in-memory latest tick per token
  ├─► redis.set()                quote:{exchange}:{token}  TTL 60 s
  └─► tickListeners[]            fan-out
        ├── WS Bridge (/ws)      ticks grouped per browser clientId → { type:'tick', data:[...] }
        └── TradeSetupPriceMonitor   fill / exit triggers on minted paper setups
```

Ref-counting: `refCounts` (exchangeSegment:token → Set<clientId>) — one upstream subscription shared by all clients; upstream unsubscribe only when the last interested party leaves.

## 5. Frontend WebSocket client

`useMarketWebSocket()` is mounted once at AppShell: `MarketWebSocketClient.connect()` → `ws://server:4000/ws`; visibility / focus / online listeners call `reconnectIfStale()`; `onHealth()` feeds `useSystemHealthStore`. Per component `useMarketTicks(targets[])` subscribes / unsubscribes. Reconnect: exponential backoff capped at 30 s; all active subscriptions re-sent on open; no message for 20 s → forced reconnect.

## 6. Signal engine pipeline (core trading logic)

```
POLL (per symbol; closed 15m bars; ~every 2–5 min)
  ▼
Step 1 — Market Bias / indicator engine (market-bias.ts)
  Inputs: OHLCV 15m/1h/1d, futures quote, option chain, corporate actions
  Computes (@fno/analytics): RSI, VWAP, Supertrend, ADX, ATR, MACD, Bollinger, pivots, divergence,
    FVG, VCP, liquidity sweeps, order blocks, EMA structure, OI build-up, PCR, IV vs HV, expected move
  Output: MarketBias { direction, regime, score, intelligenceScore } + the indicator candidate
  ▼
Step 2 — Structure engine S1 (structure-engine/, structure-live.ts)
  Liquidity sweep → displacement → zone (FVG / 50%) → CONFIRMED → fill (TOUCH or REJECTION_CLOSE)
  Live rules: liveStructureRulesFor() — the pre-registered STRUCTURE_RULES with NO R:R floor
    (minT1R = 0): confirmation needs only valid geometry (a T1 strictly beyond the entry, positive
    risk). Research / backtests keep STRUCTURE_RULES (1.5R) unchanged.
  State: Redis structure_setup:{ex}:{u}:{mode}   Events: setup_lifecycle_events
  ▼
Step 3 — Trigger router (trigger-router.ts), families A2–F3 (event engine)
  Per closed 15m bar: prepareMomentumSeries → runSessionEvents → evaluateTriggersAt →
  groupIntoParents → arbitrateParents (OBSERVATION only)
  Risk validation (validateCandidateRisk): geometry (TRADE or LOW_RR bucket — LOW_RR is a label,
    not a rejection), session window, option cost ceiling. NO_TARGET / INVALID_STOP are rejected.
  Stages: SHADOW → recorded only · PAPER_RESEARCH / PAPER / ACTIVE → slot arbitration ·
          RESEARCH / RETIRED → not evaluated live
  ▼
Step 4 — Slot arbitration (slot-arbitration.ts) — ONE paper trade per symbol
  Every engine (S1 + indicator + every paper-stage family) hands in every eligible candidate.
  Each is built through its own chain: safety gates → option leg (every in-band strike built and
    ranked; a failing strike falls through to the next) → cost model.
  NO R:R GATE anywhere in these chains (RISK-2.0): every live buildTradeSetup call passes
    rrGate: false; genuine checks still refuse (no edge after cost, stop inside the noise floor
    beyond the cap, bad quote, illiquid contract, safety gates).
  Ranking (pre-registered, identical for every engine; first difference wins):
    1. entry timing / remaining move   2. move potential   3. net R:R after costs
    4. entry quality                   5. decision-bar close → source id → candidate id
  ONE winner minted → trade_setup:* (Redis) + signals (Postgres); others recorded with rank and
  the criterion they lost on (setup_events ARBITRATION rows).
  ▼
Step 5 — Setup Watch (setup-watch-core.ts / setup-watch.ts) — DISPLAY ONLY
  Every CONFIRMED setup (any R:R) is shown under its SAME id and re-measured on every closed bar:
    entry reference, SL, T1/T2, best strike, premium Entry / SL / TSL / T1 / T2, net R:R.
  Status: "Confirmed — R:R 1.20R" + display-only rrBand (<1.0 · 1.0–1.5 · ≥1.5).
  Net R:R never changes the status. A row ENDS only on:
    • INVALIDATION — stop traded, sweep reclaimed, close beyond the rule's invalidation, T1 traded first
    • EXPIRY       — fill window (8 × 15m), closing guard, session end (indicator: bias flip)
    • FILLED       — it became the paper trade
  Records: setup_events LIFECYCLE rows (WATCH_STARTED, REEVALUATED, STRIKE_CHANGED,
    OPTION_BUILD_FAILED, WATCH_ENDED) — kept out of the census and the grading.
```

## 7. Analytics package (`packages/analytics/src`)

Pure TypeScript — no IO, no network, no database, no clock. Modules: indicators, candlestick-patterns, event-engine (events, triggers, parents, arbitration, `rebuildCandidateAt`), structure-engine (`STRUCTURE_RULES`, `evaluateStructureSession(series, i, variant, rules)`), market-structure, fvg, vcp, liquidity-map, ema-trend, momentum-break, greeks, gamma-exposure, historical-volatility, expected-move, max-pain, pcr, oi, execution-quality, option-quality, setup-classifier, strike-selection, target-estimate, trade-setup (`buildTradeSetup` — option `rrGate`, default true for research / golden snapshots; live passes false), patterns.

## 8. Background services (18)

| Service | Frequency | Role |
|---|---|---|
| alertScanner | periodic | user price / condition alerts |
| patternScanner | periodic | chart patterns across the F&O universe |
| institutionalFlowScanner | periodic | FII/DII + PCR + OI sentiment |
| tradeSetupPriceMonitor | real-time ticks | fills / exits on minted paper setups |
| marketScanner | periodic | NIFTY trend → movers → 0–100 score (also polls NIFTY/BANKNIFTY/FINNIFTY bias) |
| fiiDiiTracker | periodic | NSE FII/DII cash data |
| abandonedSetupSweep | periodic | stale paper setups → ABANDONED |
| oiCloseSnapshot | EOD | OI at close (change baseline) |
| cacheWarmer | in-session | FNO scan cache |
| strategyTracker | periodic | live strategy metrics |
| positionalStockScan | periodic | positional stock opportunities |
| backgroundBiasEvaluator | 2 min | SENSEX, CRUDEOIL, GOLD bias / slot |
| marketStateCapture | periodic | market-state capture tables |
| missedWinnerAudit | periodic | refusals graded against the price path |
| setupEventsGrading | periodic | setup_events grading |
| opportunityCensus | post-session | opportunities vs setups |
| holidayCalendarCheck | daily | holiday calendar populated |
| systemLearningAudit | daily (EOD) | learning detectors (observation only) |

## 9. REST API

`POST /api/auth/login|logout`, `GET /api/auth/status`, `GET /api/instruments/search|:token`, `GET /api/market/bias/:symbol` (full MarketBias incl. `setupWatch`), `GET /api/market/history|quote`, `GET /api/option-chain/:symbol`, `GET /api/futures/:symbol`, `POST/GET/DELETE /api/alerts`, `POST /api/ai-assistant/ask`, `GET /api/institutional-flow`, `POST/GET /api/backtesting/*`, `GET /api/learning/*`, `GET /api/loss-attribution`, `GET /api/structure/:symbol`, `GET /api/market-scanner/scan`, `GET /api/strategy-scanner/scan`, `GET /api/fii-dii`, `GET /api/news/:symbol`, `GET /api/corporate-actions`, `GET /api/diagnostics/*` (summary, rejections, census, grades, leakage, performance, opportunity, major-moves, triggers, shadow, versions, setup-outcomes), `GET /api/health`.

Removed 2026-10-05: `GET /api/diagnostics/rr-recovery` (it measured recovery to 1.50R; with no R:R gate nothing recovers).

## 10. Frontend pages

Dashboard, Indices, Asset Workspace (Trade Setup card + "Confirmed setups" list), FNO Stocks, OI Intelligence, IV & Greeks, Market Scanner, Strategy Scanner, Institutional Flow, Backtesting, Loss Attribution, Signal Diagnostics, Alerts, AI Assistant, System Learning, Corporate Actions, Positions (not built), System Health.

## 11. Frontend state

Zustand: `useMarketStore` (tab, watchlist, cached bias), `useUISettingsStore`, `useSystemHealthStore` (WS status, freshness, per-service health). Data hooks in `apps/web/src/lib/use-*.ts` poll with `setInterval`.

## 12. Persistence

```
PostgreSQL + TimescaleDB
├── OHLCV / OI hypertables
├── signals                    ← minted paper trades (signal_type TRADE_SETUP; inputs.logic carries the version stamp)
├── setup_events               ← every setup decision + grades; ARBITRATION / LIFECYCLE rows
├── setup_lifecycle_events     ← S1 lifecycle transitions
├── decision_snapshots         ← existing per-decision TAKE / REFUSE record (006; missed-winner audit)
├── alerts, learning_events, learning_findings, capture_* tables
Redis
├── quote:{exchange}:{token}            TTL 60 s
├── hist:{exchange}:{token}:{tf}        OHLCV cache
├── fno-scanner:{exchange}              scan cache
├── structure_setup:{ex}:{u}:{mode}     S1 lifecycle state
├── trade_setup:{ex}:{u}:{mode}         the one paper-trade slot
├── setup_watch:{ex}:{u}:{mode}:{day}   confirmed-setup watch rows
└── mp_*                                trigger-router evaluation / parent linkage / family watch
```

## 13. Request priority

`apps/server/src/lib/request-priority.ts`: interactive `/api/*` requests run before background jobs on Angel One's rate-limited endpoints (`runInteractive` / `runBackground`).

## 14. AI assistant

`POST /api/ai-assistant/ask` → `ai-assistant.ts` builds market context (MarketBias, option chain, OI, alerts) → `askClaude()` → response.

## 15. Angel One authentication

Boot: `ANGEL_ONE_API_KEY + CLIENT_ID + PASSWORD + TOTP_SECRET` → `provider.authenticate()` → `subscriptionManager.connect()`. Every 8 h: `refreshAuth()` or full TOTP re-login. Shutdown (SIGTERM/SIGINT): `server.close()` → `subscriptionManager.disconnect()` → `provider.logout()` → `sql.end()` → `redis.disconnect()`.

## 16. Learning system (EOD self-audit)

Observation only: `startSystemLearningAudit` → `learningDetectors.ts` → `learningEngine.ts` → `learning_findings`, `learning_events` (read via `/api/learning/*`). Isolation rule: the learning engine imports nothing from the trading path and never changes a trading decision, version or configuration; every trading-path change needs explicit human approval and a version bump.

## 17. Key design decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Single upstream Angel One WS via SubscriptionManager | ref-counting, one reconnect path |
| 2 | Redis for OHLCV + quote cache | fast scanner reads, fewer broker calls |
| 3 | `packages/analytics` is pure TS | testable without network / DB mocks |
| 4 | Request priority queue | background polling never starves user lookups |
| 5 | Learning engine isolated from the trading path | it notices; it never changes what the engine does |
| 6 | **Net R:R is a ranking / display input only (RISK-2.0, 2026-10-05)** | A setup that passes every genuine safety, data-quality, execution, liquidity, spread and stop-validity check is confirmed, shown and tradeable at any R:R. 1.50R is a displayed reference (rrBand). Replaces "Setup watch keeps alive below 1.50R". |
| 7 | Slot arbitration across ALL engines | no engine pre-selects; identical metrics and ranking |
| 8 | `HEALTH_PROBE_TIMEOUT_MS = 3000` | a hung DB never silences the health page |

---

## Change log

- **2026-10-05 — Phase 1: 1.50R display-only (RISK-2.0, `+rr-display-only.1`).** Removed every live R:R gate (structure confirmation via `liveStructureRulesFor`, the fill's sequence gate, family LOW_RR rejection, the option builder via `rrGate: false` incl. the RICH-IV bar, the sticky-slot plausibility floor, Setup Watch keep-alive / RR_RECOVERED, the `rr-recovery` endpoint). Setup Watch tracks only INVALIDATION / EXPIRY / FILLED; status "Confirmed — R:R x" with a display-only rrBand. Audit: `docs/phase1-rr-classification.md`.
