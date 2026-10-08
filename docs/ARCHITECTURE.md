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
Angel One WebSocket (SNAP_QUOTE)   parser: exchange timestamp (byte 35) + sequence (27); partial batches flagged
  ▼
SubscriptionManager.handleTicks()
  ├─► filterTicks()              drop DUPLICATE / OUT_OF_ORDER per token (exchange ts, then sequence)
  ├─► FeedTracker                per-token DATA_FRESH / DATA_STALE (2 min) / DATA_GAP (5 min or socket down)
  │                              / RECOVERING — in session only (exchange calendar); no gaps after hours
  ├─► computeChangeOi()          enrich each tick with changeOi
  ├─► latestQuotes Map           in-memory latest tick per token
  ├─► redis.set()                quote:{exchange}:{token}  TTL 60 s
  └─► tickListeners[]            fan-out
        ├── WS Bridge (/ws)      ticks grouped per browser clientId → { type:'tick', data:[...] }
        └── TradeSetupPriceMonitor   fill / exit triggers on minted paper setups — only on DATA_FRESH tokens
```

Reconnect / auth refresh (Phase 5): socket drop → in-session tokens DATA_GAP from their last tick;
reconnect → every refCounts token re-subscribed, RECOVERING, gaps handed to the gap checker. The 8 h
re-authentication retries with exponential backoff (4 attempts from 30 s), alerts (Telegram) when every
attempt fails, and on success opens a new feed connection (new feed token) — every token RECOVERING.
Gap check (feed-gap-check.ts) for each open paper trade: the gap (clamped to the session) is backfilled
with the contract's 1-minute bars; LEVEL_TOUCHED (first level known) → closed normally at that level;
NO_TOUCH → nothing; FILL_UNCERTAIN (SL and target in one minute) / MISSED_TOUCH_POSSIBLE (minutes missing,
or no backfill) → recorded (`feed_gap:*`, `/api/diagnostics/feed-gaps`, `/api/health` per token) — never a
fill, never a cancel. The 90 s REST sweep keeps checking open trades on fresh REST quotes.
Health: `/api/health` → `feed` {byState, upstreamDown, dropped duplicates / out-of-order, partial batches,
perToken [{state, lastTickTime, lastSuccessfulQuoteTime, gapDurationMs, asOf, source, status, lastGapOutcome}]};
overall DEGRADED while the upstream feed is down in session; System Health page → "Data feed" table
(`useSystemHealthStore.health.feed`).

Ref-counting: `refCounts` (exchangeSegment:token → Set<clientId>) — one upstream subscription shared by all clients; upstream unsubscribe only when the last interested party leaves.

`/ws` hardening (Phase 7, ws/ws-guard.ts): an upgrade must come from an allowed origin (`CORS_ORIGINS`, as the REST API) — or, when `WS_AUTH_TOKEN` is set, carry `?token=` equal to it (constant-time compare; the web client sends `NEXT_PUBLIC_WS_AUTH_TOKEN`); messages ≤ 64 KB; only well-formed targets; at most `WS_MAX_SUBSCRIPTIONS_PER_CLIENT` (200) tokens per client — the rest refused with a `SUBSCRIPTION_LIMIT` message.

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
Step 1b — Decision snapshot (decision-record.ts; INTRADAY, structure on)
  Freezes the inputs S1 / the router / the slot read — closed 15m (and 5m) bars ≤ T, 1h closes,
  futures quote, option chain, PCR / IV / HV, regime, liquidity map, corporate-actions context,
  the engines' stored Redis state (structure lifecycle + outcomes, router state, traded parents)
  — with per-input dataQuality {asOf, decisionBarTime, ageMs = T − asOf, source, status} and every
  version. T = close of the newest 15m bar closed at the poll (exchange session calendar).
  The DecisionRecord is derived from it by the pure core; S1 and the router below run on the
  snapshot's own inputs, so the record is what they decided.
  ▼
Step 2 — Structure engine S1 (structure-engine/, structure-live.ts)
  Liquidity sweep → displacement → zone (FVG / 50%) → CONFIRMED → fill (TOUCH or REJECTION_CLOSE)
  Live rules: liveStructureRulesFor() — the pre-registered STRUCTURE_RULES with NO R:R floor
    (minT1R = 0): confirmation needs only valid geometry (a T1 strictly beyond the entry, positive
    risk). Research / backtests keep STRUCTURE_RULES (1.5R) unchanged.
  State: Redis structure_setup:{ex}:{u}:{mode}   Events: setup_lifecycle_events
  Decision: advanceStructureCore (pure; structure-live.ts) — the live poll and replay run it.
  ▼
Step 3 — Trigger router (trigger-router.ts), families A2–F3 (event engine)
  Per closed 15m bar: prepareMomentumSeries → runSessionEvents → evaluateTriggersAt →
  groupIntoParents → arbitrateParents (OBSERVATION only)
  Parent identity (PARENT-2.0): "the same underlying move" = same session + direction and the
    same ORIGIN event (root of the anchor's ancestry: RECLAIM → its SWEEP, RETEST → its break …),
    or the same ORIGIN LEVEL (pool kind + price) within PARENT_SPAN_BARS (12) of the move's first
    origin — the window never slides. Time proximity alone never merges two moves.
    parentId = P:<stable hash of symbol, session, direction, first origin, its level, its
    ancestry, the window> — independent of input order and of later candidates.
  Decision: evaluateFamiliesCore (pure) on the bars + the router's stored state; the shell
    routeTriggerFamilies reads / writes that state and records the candidates.
  Risk validation (validateCandidateRisk): geometry (TRADE or LOW_RR bucket — LOW_RR is a label,
    not a rejection), session window, option cost ceiling. NO_TARGET / INVALID_STOP are rejected.
  Stages: SHADOW → recorded only · PAPER_RESEARCH / PAPER / ACTIVE → slot arbitration ·
          RESEARCH / RETIRED → not evaluated live
  ▼
Step 4 — Slot arbitration (slot-arbitration.ts) — ONE OPEN paper trade per symbol
  Slot rule (slotRuleFor): while a trade is open every candidate is SLOT_OCCUPIED (recorded);
    once it closes the slot is free again the same day — an independent parent competes,
    subject to the chains' cooldown / risk gates; a parent that already traded never trades
    again (PARENT_ALREADY_TRADED). Nothing blocks the whole day.
  Every candidate's ARBITRATION row carries its parentId and slotDecision
    {slot FREE|OCCUPIED, decision MINTED|MINT_LOST|NOT_SELECTED|INELIGIBLE|PARENT_ALREADY_TRADED|SLOT_OCCUPIED}.
  Every engine (S1 + indicator + every paper-stage family + the momentum break when its flag is
    on) hands in every eligible candidate. The momentum break is evaluated and validated by its
    own chain (safety gates + TRIGGER_QUALITY → option leg) WITHOUT minting and competes in the
    same ranking (momentumSlotCandidate: entry = spot, stop / objective = the trigger's, anchor =
    the broken level, parent = MB:<level, direction, day>, displacement confirmed by construction).
    It never mints on its own and has no priority; a fresh opposite trigger may still close a
    held trade (TRIGGER_REVERSAL) — an exit, not a mint.
  Each is built through its own chain: safety gates → option leg (every in-band strike built and
    ranked; a failing strike falls through to the next) → cost model.
  NO R:R GATE anywhere in these chains (RISK-2.0): every live buildTradeSetup call passes
    rrGate: false; genuine checks still refuse (no edge after cost, stop inside the noise floor
    beyond the cap, bad quote, illiquid contract, safety gates).
  Ranking (pre-registered, identical for every engine; first difference wins):
    1. entry timing / remaining move   2. move potential   3. net R:R after costs
    4. entry quality                   5. confirmations (ARB-2.0): liquidity sweep + displacement +
       FVG/zone/SMC shift + option-chain positioning agreement — a count, never a gate
    6. decision-bar close → source id → candidate id
  Isolation: a trigger rule that throws / reads past its bar loses only its own candidates; a
    candidate whose chain throws is refused alone (ENGINE_ERROR); an indicator failure is one more
    refused candidate.
  Next-best: the slot walks down the ranking — a candidate failing the pre-mint check (stale chain,
    no two-sided quote, no reward after costs; no R:R threshold) or whose mint throws is recorded and
    the next one is tried. NO TRADE only when every candidate fails, and it carries
    noTradeDiagnostics: every candidate evaluated (stage, code, reason), the best rejected one, the
    limiting factor, the missing confirmation, and what each engine produced (Trade Setup card →
    "Why no trade").
  Option leg (OPTION-2.0 / OPTSEL-2.0): target premium = entry + |Δ|·move + ½|Γ|·move² − |θ| over the
    hold on trading time; costs on top; decay that eats the move → UNREALISTIC_TARGET. Strikes are
    compared on net R:R against the common underlying invalidation, so premium-% stop rules cannot
    make a cheap OTM contract outrank the ATM one.
  ONE winner minted → trade_setup:* (Redis) + signals (Postgres) + option_plans; others recorded
  with rank and the criterion they lost on (setup_events ARBITRATION rows).
  OptionCandidate pipeline (Phase 3, fno-validation.ts): every strike of the side passes
    availability → liquidity → spread → delta → premium risk → target potential → net R:R after
    cost → deterministic rank (rankStrikeBuilds; ties: strike, then token). The first four (and a
    stop inside the noise / no reward after cost) are the only rejections; net R:R only ranks.
    Rank #1 failing its build → #2, #3 … until one passes. Every strike is recorded
    (strikeSelection.optionCandidates): SELECTED / RANKED / REJECTED + stage + reason.
  Slot decision (slot-decisions.ts; measurement only): one slot_decisions row per decision bar
    whose slot was free — MINTED / NO_TRADE / NO_CANDIDATE, fall-through depth, final-check
    failures, every rejection's code + stage + category (THETA_COST: COST_EXCEEDS_EDGE,
    COST_TOO_HIGH, UNREALISTIC_TARGET · LIQUIDITY: NO_QUOTE, WIDE_SPREAD, LOW_OPTION_LIQUIDITY,
    POOR_OPTION_QUALITY), each candidate's geometry and confirmation count.
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

## 6a. Decision snapshot, DecisionRecord and replay (Phase 2)

```
captureDecisionSnapshot (market-bias.ts, before S1 / router)
  read: structure_setup + structure_outcome:* · mp_eval / mp_sel:observe / mp_watch / mp_link ·
        slot_traded:{day}
  buildSignalDecisionSnapshot (pure, deep-frozen, JSON round-tripped exactly as stored)
  deriveDecisionRecord(snapshot, generatedAt)   ← pure: no IO, no clock
  persist when NEW_BAR (first poll after T) or SPOT_FILL (a later poll where an S1 limit fills)
    → signal_decision_snapshots (chain gzip+base64) → decision_records (+ record_hash)
    → decision_trigger_events (candidate → event ids, written after event evaluation)
  setScopeSnapshotId → every setup_events / signals row this poll writes carries snapshot_id
replay(snapshotId)   (decision-record-store.ts)
  load the snapshot (the only read) → refuse on CONFIG_MISMATCH → deriveDecisionRecord →
  compare canonical forms with the stored record (NONDETERMINISTIC_RECORD_FIELDS = ['generatedAt'])
```

- **Snapshot** (`SignalDecisionSnapshot`, `@fno/shared`): inputs only — nothing the decision derives. Version fields: gitCommit, analyticsVersion, signalEngineVersion (+ logic flag hash), optionModelVersion, parentingVersion (`PARENT-1.0`), arbitrationVersion (`ARB-1.0`), ruleVersion, strategyVersion, trigger versions, riskVersion, costModelVersion, snapshotSchemaVersion (`SNAP-1.0`). Config: trigger stages, structure on / timeframe / entry mode, STRUCTURE_PARAMS + FNO_VALIDATION_PARAMS, configHash.
- **Data quality** (`decision-quality.ts`): status OK · STALE_INPUT (older than its tolerance) · FUTURE_INPUT (as of after T) · MISSING. Tolerances: closed bars 0 (the bar that closed at T must be there), 1h bars 1 h, chain / futures 2 min. A FUTURE_INPUT / STALE_INPUT / MISSING input is never used silently: the record is `degraded` with one reason per input, and every candidate / option candidate that read it carries `degraded: true`. Polls run after T, so the chain is normally FUTURE_INPUT — its candidates are marked degraded; the build is not skipped (skipping would stop every paper trade).
- **DecisionRecord** (`DR-1.0`): S1 lifecycle advance + transitions + fill; family status, events, linkage, watch; every candidate decided (parentId, anchor keys, eligibility, reason, observation role, degraded); candidate → event ids; common decision metrics of every slot candidate; option candidates (each newest-bar family leg's cost on the snapshot chain); the pre-build slot ranking (order, criteria used / skipped, criterion each loser lost on, parents already traded); final status (NO_CANDIDATE / NO_ELIGIBLE_CANDIDATE / CANDIDATES_TO_SLOT) and the top-ranked candidate.
- **Not re-derived** by `replay` (`NOT_REPLAYED`; their rows carry the snapshot id): the indicator engine, the safety gates, the option-leg build, the slot settlement (its ARBITRATION rows), the setup-watch refresh. **Full replay** (below) re-derives all of them.

### 6b. Full replay — the whole decision path from an I/O tape

```
live poll: buildMarketBias → pollWithTape (when DECISION_TAPE=1)
  decision clock frozen at the poll instant (withDecisionTime)
  runRecording: every read at the boundaries is taped with its result —
    redis (tapedRedis) · sql (tapedSql, recorded on execution) · broker (tapedProvider) ·
    in-process state (tapedValue: dataQualityBlock, lastSnapshotBar, the mint-lock token) ·
    whole inputs (tapedInput: option chain, futures, IV rank, corporate actions)
  writes: matched on target + a SHA-1 of the payload (the payload itself is not stored)
  persisted beside the snapshot ONLY when DECISION_TAPE=1 (off by default - tapes are MBs each and filled the database volume on 2026-10-08): decision_tapes (gzip; ≤ 512 KB; kept DECISION_TAPE_RETENTION_DAYS, default 2)
replayFull(snapshotId)   (full-replay.ts; GET /api/diagnostics/decision/:id/replay-full)
  runReplay at the snapshot's polledAt: the UNCHANGED buildMarketBias — indicators, safety gates,
    option build, arbitration, pre-mint, settlement / lifecycle — with every read served from the
    tape (FIFO per key); Date.now is the poll instant inside the replay scope only; every network
    call (fetch / axios) is refused; writes become effects, never reach Redis / Postgres
  a read the tape does not hold = a divergence (never answered with current data)
  status: MATCH · DIFFERENT (result paths) · DIVERGED · NO_TAPE · NOT_FOUND;
    the result is compared outside FULL_REPLAY_VOLATILE_KEYS (wall-clock stamps and random ids),
    the writes as a multiset of targets (live vs replay)
```
- **Immutability**: Postgres rules make an UPDATE of a snapshot or of a record's decision columns a no-op (only `outcome` / `outcome_at` may be written later); trigger-event links are insert-only.
- **Snapshot id**: a UUID-shaped sha256 of exchange / symbol / mode / T / polledAt (deterministic).

### 6c. Forward validation (forward-validation.ts) — measurement only

Runs on the opportunity census's post-session tick (no new service); grades only sessions that have ended, from stored data (decision snapshots, option plans, closed paper signals, slot decisions) — never the broker, and nothing it writes is read by a decision. `forward_outcomes` (one row per kind + subject):

- **OPTION_PAYOFF** (OPTION-2.0): the theta-adjusted target premium and the delta + gamma − theta projection (stored on the signal as `projectedPayoff`) vs the contract's marks on the recorded chains until the exit — best / worst mark, target reached, share of the projection captured, realised %.
- **STRIKE_SELECTION** (OPTSEL-2.0): every strike of the plan marked at the exit — was the selected strike best, selected vs best R, how the rejected strikes did, rank agreement (−Spearman of rank vs realised R).
- **EVIDENCE_RANK** (ARB-2.0): every arbitrated candidate on its own stop / objective over the rest of its session (closed 15m bars opening at or after its decision; a bar touching both counts the stop) — R by confirmation count, top-ranked was best, rank and confirmation agreement.

`GET /api/diagnostics/signal-engine?from=&to=&instrument=` (signal-engine-metrics.ts) aggregates: NO TRADE rate, fallback success (bars whose #1 failed its final check that still minted), candidates and strikes rejected for theta / cost and for liquidity, missed opportunities (opportunity census), and the three forward measurements. Signal Diagnostics → "Signal Engine"; Decision Record → "Full replay".

### 6d. Profitability review (2026-10-08) — demotion, source split, shadow experiments

- **A4 demoted to SHADOW** (`TRIGGER_DEMOTIONS`, trading-flags.ts): the mirror of a promotion — a code-level entry that names its forward evidence (INDEX 81 trades, net −0.42R, PF 0.71; MCX 20 trades, net −0.79R). A demotion only lowers a stage; A4 keeps producing SHADOW candidates and can earn its way back through `TRIGGER_PROMOTIONS`. Live stamps carry `+demote-a4.1`. F3 (25 forward trades) and the B / D / F1 families stay on watch until they reach 30.
- **Source on every trade:** `signals.inputs.source` (INDICATOR, S1, MOMENTUM_BREAK, the trigger id) and `candidateId`; `slot_decisions.snapshot_id` is filled from the poll's snapshot scope.
- **Reporting:** every win-rate bucket adds `netExpectancyPercent` (per closed trade, EXPIRED included at its exit, after its own estimated cost) and `winsBelowCost`; the win rate itself stays WIN ÷ (WIN + LOSS). `bySource` splits results by the source above (Backtesting → "By Source").
- **Shadow experiments** (`shadow-rules.ts`, `SHADOW-1.0`, measurement only — nothing here changes what is traded). Pre-registered, untuned:
  entry filters on decision-time fields — `COST_EDGE_2X` (target gain < 2× round-trip cost), `MCX_EVENING` (MCX from 18:00 IST), `RICH_IV`;
  exit rules on the option's recorded marks strictly before the actual exit — `TIME_STOP_60` (first mark ≥ 60 min below entry → exit there), `BREAKEVEN_AT_HALF` (after entry + ½(target − entry), a mark at or below entry exits at entry).
  Exit rules are graded per closed trade into `forward_outcomes` (kind `SHADOW_EXITS`) by the forward-validation pass; `GET /api/diagnostics/shadow-rules` reports skipped vs kept and with-rule expectancy (Signal Diagnostics → Signal Engine → "Shadow experiments"). A rule is considered for live use only after 30+ forward trades show a material gain — a human decision.

### 6e. Order Block repair (OB-2.0 / OB1) and Order Flow / OF1 — paper trading (2026-10-09)

- **Order blocks.** The legacy detector (OB-1.0, `detectOrderBlocksLegacy`) never fired (the current candle self-mitigated every block, a fixed 2%-in-45-min rule, direction from the previous close). It is kept frozen ONLY as the indicator's live structure vote, so no paper trade changes. **OB-2.0** (`detectOrderBlocks`, `orderBlockSignalAt`, market-structure/index.ts): closed candles only; a block is the last opposing candle (real open vs close) before a displacement bar within 3 bars whose body ≥ 1 ATR(14), closing in its outer 30% and beyond the block; the block exists from the bar after the displacement (its own candles can never touch it); lifecycle FRESH → FIRST_TOUCH (first later bar reaching it) → MITIGATED (a close beyond its far edge); reaction = MFE / MAE in ATR over 8 bars after the first touch (measurement only). `ORDER_BLOCK_MODE=SHADOW` (default; `OFF` allowed; `LIVE` refused — a code change on evidence): per closed bar it records the blocks (`order_blocks`) and the legacy vote beside the OB-2.0 signal and whether OB-2.0 would have changed the indicator's direction (`order_block_shadow`).
- **Order flow.** `Dhan WebSocket (FULL packets) → dhan-feed.ts (adapter) → order-flow-store.ts → order-flow/index.ts (pure footprint) → OF1`. Data only — no Dhan order API; Angel One remains the data provider for everything else. Index order flow is read from the nearest index future (resolved daily from Dhan's public instrument master). Dhan's feed carries cumulative volume, LTP and best bid/ask, not the aggressor side, so **delta mode is INFERRED** (quote rule, then tick rule) — never presented as EXACT. A bar without usable trades is `UNAVAILABLE` (reason FEED_DOWN / NO_TRADES) with every measure NULL, never zero. Footprint: buy / sell / unclassified volume, delta, delta % (NULL below 80% classified), volume by price, POC / VAH / VAL (70%), imbalances (≥ 3:1 at a level), absorption, acceptance. Symbols: NIFTY, BANKNIFTY (`ORDER_FLOW_SYMBOLS`; MCX refused until verified). Feed supervised as the non-critical `orderFlowFeed` component, active only with `DHAN_CLIENT_ID` / `DHAN_ACCESS_TOKEN` during the NSE session.
- **OF1 — Order Flow Confirmation (`OF1-1.0`, order-flow/of1.ts)**, independent of every family: at a closed bar, LOCATION (PDH/PDL, opening range, session VWAP, unfilled FVG, FRESH OB-2.0, previous-session VAH/VAL/POC, swing high/low; bar reaches within 0.25 ATR) + PRICE (close back beyond the level, in the favourable half of the bar) + FLOW (≥ 2 measurable of: delta % ≥ 10, ≥ 2 imbalances, absorption, POC migration, ≥ 60% volume beyond the level). Stop = beyond the bar / level ± 0.1 ATR; T1 = nearest opposite level ≥ 0.5 ATR away. `OF1_ENABLED=true`, `OF1_TRADING=false` (hard — no path to the slot). Recorded in `of1_candidates` with the read-only option plan, cost, `would_trade_if_live`; after the session the forward-validation pass fills the hypothetical outcome, MFE / MAE (R) and `existing_candidate_that_won` (slot_decisions).
- **Paper trading (user decision 2026-10-09):** `ORDER_BLOCK_MODE=PAPER` (default) and `OF1_TRADING=true` (default) make **OB1** (the OB-2.0 signal) and **OF1** paper candidate sources (order-flow-candidates.ts). Each is built by the event engine's own `buildCandidate` (entry = decision-bar close, stop = rule reference ± 0.1 ATR — OB1: the block's far edge, OF1: the bar extreme beyond the level — T1/T2 = nearest untaken opposite pools, R:R bucket, timing, move potential) and qualified by the router's own `validateCandidateRisk` / `costOnChain`, then appended to the trigger families' paper candidates on a newly evaluated bar. From there the unchanged chain (safety gates, option selection, stops, targets, costs, exits) and the unchanged slot arbitration decide. Stage PAPER_RESEARCH; parent = the block (OB1) or the level + session + direction (OF1). Trades carry `source` OB1 / OF1, `sourceVersion` OB-2.0 / OF1-1.0 and `+paper-research.OB1` / `.OF1`; every live stamp gains `+ob1-paper.1+of1-paper.1` while they may trade. The indicator engine's own vote keeps the frozen legacy detector. Rollback without a deploy: `ORDER_BLOCK_MODE=SHADOW`, `OF1_TRADING=false`. OF1 needs Dhan data (`DHAN_CLIENT_ID` / `DHAN_ACCESS_TOKEN`); OB1 does not. Paper only — no broker order path.
- **Regression guard:** `strategy-regression-fingerprint.test.ts` (A1–F4 triggers, S1 every variant, router + stages, slot ranking, option builder, gates on frozen real bars) and the end-to-end live decision in `full-replay.test.ts`, both frozen on main before this change. `GET /api/diagnostics/order-flow`; Signal Diagnostics → Signal Engine → "Order blocks and order flow (shadow)".

### 6f. Trade-tracking integrity and data quality (diagnostic fixes, 2026-10-09)

- **Slot compare-and-set** (lib/slot-cas.ts): every update or clear of an EXISTING trade in `trade_setup:*` (trailing stop, reversal streak, backfilled id, the indicator's clears, the price monitor's excursion / close / stale-day clear) is an atomic Redis script that writes only if the slot still holds the same trade (signalId, else generatedAt). A stale copy can no longer overwrite a trade another caller just minted (NIFTY 8 Oct). Minting stays under the mint lock.
- **Idempotent, never-lost closes:** `recordTradeSetupOutcome` updates only an OPEN row (`… AND outcome IS NULL RETURNING id`); a duplicate close is a no-op without side effects. A close the database refuses is queued in Redis (`pending_trade_outcomes`, pending-outcomes.ts) and applied by every price-monitor sweep and first thing at boot. A trade whose row never got written gets it at close, with its real generation time.
- **Recovery never revives a lost trade:** queued closes first; an open row superseded by a later trade on the same slot is closed `TRACKING_LOST` and voided instead of written back (CRUDEOIL 8 Oct); INTRADAY open rows of earlier sessions that no slot holds are closed the same way (`sweepLostTrades`, boot + every 30 min).
- **Session-close bar anomaly** (bar-anomaly.ts, migration 039 `bar_anomalies`): on NSE/BSE, a session's final 15m bar whose range exceeds 3× the session median and trades beyond the session's earlier high/low is recorded; grading (EVIDENCE_RANK, OF1) reads it flattened to its close. The live engines are unchanged by it until the recorded anomalies confirm the rule. MCX excluded (genuine late moves).
- **Square-off shadow:** the price monitor records the option mid in each intraday trade's last 10 session minutes (`squareOffShadow`); the shadow-rules report compares it with the actual exit. No exit changed.
- **OF1 on MCX:** the Dhan feed also subscribes MCX_COMM nearest futures (CRUDEOIL, GOLD, SILVER, NATURALGAS by default), connects during NSE or MCX hours, and closes each symbol's flow bars on its own exchange session. OB1 already ran on MCX (it runs wherever the trigger families run).

## 8. Background services (18) — supervised (Phase 6)

`ServiceSupervisor` (lib/service-supervisor.ts) starts, watches and stops every service. Each registers
{name, critical, startupTimeoutMs, heartbeatIntervalMs}. States STARTING → RUNNING ⇄ DEGRADED → FAILED →
RESTARTING → RUNNING; STOPPED at shutdown. TIMER services keep their own code: the supervisor captures the
timers each creates (incl. an interval set by a delayed first tick) — every completed run is a heartbeat, a
throw / rejection a failure; 3 consecutive failures or > 4 missed intervals → FAILED → restart with
exponential backoff (5 s × 2ⁿ, max 5 restarts). COMPONENTS report `serviceHeartbeat` / `serviceFailure`.
Critical: tradeSetupPriceMonitor, signalEngine, setupLifecycle — any not RUNNING → `/api/health` DEGRADED
(`supervisor` block lists every service with state, lastSuccessAt, failureCount, restarts).

| Registration | Critical | Kind | Notes |
|---|---|---|---|
| alertScanner, patternScanner, institutionalFlowScanner, marketScanner, fiiDiiTracker, abandonedSetupSweep, oiCloseSnapshot, cacheWarmer, strategyTracker, positionalStockScan, backgroundBiasEvaluator, holidayCalendarCheck, systemLearningAudit | no | TIMER | heartbeat = own interval |
| marketStateCapture, missedWinnerAudit, setupEventsGrading, opportunityCensus | no | TIMER | start after the capture schema check |
| tradeSetupPriceMonitor | **yes** | TIMER | starts after Redis is rebuilt from PostgreSQL; its sweep reports its own outcome |
| signalEngine (extra) | **yes** | COMPONENT | the bias / signal computation has no single service among the 18 (browser polls, marketScanner, backgroundBiasEvaluator all run it); heartbeat = a completed computation, expected only in session (10 min) |
| setupLifecycle (extra) | **yes** | COMPONENT | the structure lifecycle advance runs inside the signal computation; heartbeat = a completed advance (20 min, in session) |

Recovery (services/state-recovery.ts): PostgreSQL is the source of truth; on boot Redis is rebuilt from it
before the monitor starts — trade_setup:* (open signals rows + the trailing stop from option_plan_events;
closed-in-PG removed), structure_outcome / structure_claimed / structure_event dedupe keys
(setup_lifecycle_events), slot_traded (minted ARBITRATION rows, union), setup_watch rows (the latest
LIFECYCLE row carries the whole row). Where they disagree, PostgreSQL wins (the trailing stop only when PG
recorded one; a cached trade with no PG row yet is kept for the existing backfill).

Shutdown: supervisor + every service timer → server.close → WS disconnect → logout → sql.end → redis.disconnect.

The 18 services:

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

Decision research view (Phase 8): `GET /api/diagnostics/decisions?symbol=&limit=` (recent snapshotted decisions) and `GET /api/diagnostics/decision/:snapshotId[?replay=1]` — input snapshot summary, per-input dataQuality (asOf, decisionBarTime, ageMs, source, status), market state, events, trigger candidates + parentId, common metrics, option candidates (+ every strike of each persisted plan, rejected ones with stage and reason), arbitration (pre-build ranking + the live slot rows with role, rank, slot decision and the criterion each loser lost on), final status, outcome (setup_events grading of the rows the decision produced), every version field; replay re-derives offline and compares. Shown in Signal Diagnostics → "Decision Record". Also `GET /api/diagnostics/feed-gaps` (Phase 5).

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
├── signal_decision_snapshots  ← Phase 2 immutable INPUT snapshots (034; chain compressed)
├── decision_records           ← Phase 2 DecisionRecord per snapshot (+ record_hash, later outcome)
├── decision_trigger_events    ← candidate → event ids (insert-only)
├── option_plans               ← Phase 3: each minted trade's option plan WITH its underlying plan —
│                                 underlying Entry/SL/T1/T2, option leg + premium Entry/SL/TSL/T1/T2,
│                                 selected strike, every strike evaluated (+ rejected reasons), snapshot_id
├── option_plan_events         ← plan evolution: CREATED · TSL_MOVED (trailing stop) · CLOSED (insert-only)
│   setup_events.snapshot_id / signals.snapshot_id — the snapshot a row was decided from (logical reference)
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

`apps/server/src/lib/request-priority.ts`: interactive `/api/*` requests run before background jobs on Angel One's rate-limited endpoints (`runInteractive`). Max-wait cap (Phase 6, `nextLane`): a background request waiting ≥ `REQUEST_MAX_WAIT_MS` (default 30 s) is promoted ahead of the interactive queue.

## 14. AI assistant

`POST /api/ai-assistant/ask` → `ai-assistant.ts` builds market context (indices, the F&O scanner aggregates, recent alerts) → `askClaude()` → response.

Read-only (Phase 7): the routes and service may not import trade, strategy, risk, strike, flag or learning modules — enforced by `eslint no-restricted-imports` (`apps/server/eslint.config.mjs`, `npm run lint -w apps/server`) and by a test that lints the files and walks their import graph. Untrusted text (alert messages, any news / third-party text) is wrapped in `<untrusted_data>…</untrusted_data>`, sanitised so it cannot close or open a delimiter, capped at 500 characters per entry, and the system prompt tells the model to treat it as data and ignore any instructions inside it.

## 15. Angel One authentication

Boot: `ANGEL_ONE_API_KEY + CLIENT_ID + PASSWORD + TOTP_SECRET` → `provider.authenticate()` → `subscriptionManager.connect()`. Every 8 h: `refreshAuth()` or full TOTP re-login. Shutdown (SIGTERM/SIGINT): `serviceSupervisor.stopAll()` (+ the re-auth timer) → `server.close()` → `subscriptionManager.disconnect()` → `provider.logout()` → `sql.end()` → `redis.disconnect()`.

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
| 9 | Decisions are derived by pure cores from an immutable, versioned input snapshot (Phase 2) | the record is reproducible offline; replay never substitutes current data or config |

---

## Change log

- **2026-10-05 — Phase 1: 1.50R display-only (RISK-2.0, `+rr-display-only.1`).** Removed every live R:R gate (structure confirmation via `liveStructureRulesFor`, the fill's sequence gate, family LOW_RR rejection, the option builder via `rrGate: false` incl. the RICH-IV bar, the sticky-slot plausibility floor, Setup Watch keep-alive / RR_RECOVERED, the `rr-recovery` endpoint). Setup Watch tracks only INVALIDATION / EXPIRY / FILLED; status "Confirmed — R:R x" with a display-only rrBand. Audit: `docs/phase1-rr-classification.md`.
- **2026-10-05 — Phase 2: immutable input snapshot + DecisionRecord.** Migration `034_decision_records.sql` (signal_decision_snapshots, decision_records, decision_trigger_events; snapshot_id on setup_events / signals; validated on PGlite against the full boot schema, applied twice). Pure cores `advanceStructureCore` (structure-live.ts) and `evaluateFamiliesCore` (trigger-router.ts) — the live shells now read state, call the core, write state (behaviour unchanged). `decision-record.ts` (snapshot, data quality, record, canonical form, replay), `decision-record-store.ts` (persistence, `replay(snapshotId)`), `snapshot-context.ts` (snapshot id on every row of the poll, only once 034 applied). Versions `PARENT-1.0`, `ARB-1.0`.
- **2026-10-05 — Phase 3: option selection contract + option plans (`OPTSEL-1.0`).** The OptionCandidate record (`optionCandidatesOf`, every strike with stage / reason; pipeline order availability → liquidity → spread → delta → premium risk → target potential → net R:R → rank), a final token tie-break in `rankStrikeBuilds` (the chosen strike is unchanged — a side never has two equal strikes), migration `035_option_plans.sql` (option_plans immutable, option_plan_events insert-only; PGlite-validated), `option-plans.ts` (plan row at the mint incl. option T2 = T1 + |Δ| × the underlying move T1→T2; TSL_MOVED on each trailing-stop ratchet; CLOSED at the exit).
- **2026-10-05 — Phase 4: parent identity + slot semantics (PARENT-2.0, `+parent-identity.1`).** `groupIntoParents` groups by origin event / origin level within a fixed window (no time-proximity merge), with a stable hashed `parentId` (`parentIdFor`); the linkage maps every sweep to its move (S1 joins by the same rule); `slotRuleFor` + `slotDecision` on every arbitration row (incl. SLOT_OCCUPIED rows for family candidates and S1 fills that met an open trade). Live stamps carry `+parent-identity.1`.
- **2026-10-05 — Phase 5: data freshness and gap protection.** `feed-freshness.ts` (FeedTracker states, `resolveGapTouch`), SubscriptionManager filtering / partial batches / gap + RECOVERING transitions / `refreshConnection`, exchange timestamp + sequence parsed from the binary feed, `feed-gap-check.ts` (no assumed fills: FILL_UNCERTAIN / MISSED_TOUCH_POSSIBLE), `auth-refresh.ts` (retry + alert + feed reconnect), `/api/health` feed states, `/api/diagnostics/feed-gaps`, System Health "Data feed" table.
- **2026-10-05 — Phase 6: ServiceSupervisor, clean shutdown, state recovery.** All 18 services + 2 components supervised (critical: tradeSetupPriceMonitor, signalEngine, setupLifecycle); health DEGRADED on a critical failure; shutdown order supervisor-first; Redis rebuilt from PostgreSQL at boot (PG wins); setup-watch LIFECYCLE rows carry the whole row; request-priority max-wait cap.
- **2026-10-05 — Phase 7: AI assistant read-only + /ws hardening.** ESLint import boundary for the assistant (+ graph test), untrusted-text delimiting in its prompt, `/ws` origin / token check, payload cap, target validation and per-client subscription limit.
- **2026-10-05 — Phase 8: DecisionRecord research view.** `/api/diagnostics/decisions`, `/api/diagnostics/decision/:snapshotId` (`decision-diagnostics.ts`), Signal Diagnostics "Decision Record" tab.
- **2026-10-05 — Signal engine fallback + realistic options + NO TRADE diagnostics.** Per-trigger and per-candidate isolation, next-best slot walk with a pre-mint check, confirmations criterion (ARB-2.0), realistic payoff (OPTION-2.0), strike comparison on the common underlying risk (OPTSEL-2.0), `noTradeDiagnostics` on every NO TRADE.
- **2026-10-05 — Full replay, momentum in arbitration, forward validation.** Migration `037_replay_tapes_forward_validation.sql` (decision_tapes, slot_decisions, forward_outcomes). `io-tape.ts` + `full-replay.ts`: the whole decision path replayed from the poll's I/O tape (no network, no writes, no current data). The momentum break builds a DEFERRED slot entry and competes in the arbitration (never mints on its own). `slot-decisions.ts`, `forward-validation.ts`, `signal-engine-metrics.ts`; API `/api/diagnostics/signal-engine`, `/api/diagnostics/decision/:id/replay-full`; Signal Diagnostics "Signal Engine" tab. No threshold, weight, gate or protected constant changed.
- **2026-10-08 — Profitability review.** A4 demoted to SHADOW (`TRIGGER_DEMOTIONS`, `+demote-a4.1`); trade source recorded on signals and slot decisions linked to their snapshot; net expectancy (EXPIRED included, after cost), wins below cost and a by-source split in the win-rate report; pre-registered shadow experiments (`SHADOW-1.0`: three entry filters, two exit rules) measured, never traded.
- **2026-10-09 — Order Block repair (OB-2.0, shadow) + Dhan Order Flow + OF1 (shadow).** Migration `038_order_blocks_order_flow_of1.sql`. The live vote keeps the frozen legacy detector; no strategy, gate, arbitration or option logic changed (fingerprint-tested).
- **2026-10-09 — Diagnostic fixes.** Slot compare-and-set; idempotent closes with a retry queue; recovery no longer revives superseded / lost trades; session-close bar anomaly recorded and excluded from grading (migration 039); square-off shadow; OF1 order flow on MCX.
