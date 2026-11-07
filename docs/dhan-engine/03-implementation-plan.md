# 3. Detailed Implementation Plan (with resource estimates)

Status: **APPROVED (7 Nov)** — D1 hybrid, D2 record-only risk flags, D3 options paper, D4 existing strategies keep
running, D5 Expiry Gamma kept as a tagged module, D6 network allowed, D7 storage with nightly cleanup.
Progress: P1 merged (data integrity, recording). P2 merged (engines, `packages/analytics/src/dhan-engine/`, snapshot at
`GET /api/diagnostics/order-flow/engine[?symbol=]`). P3 in review: setups A–D + 10-point score + mandatory gates +
no-trade engine (`setups.ts`) and the tagged expiry-gamma module (`expiry-gamma.ts`), recorded SHADOW-only in
`dhan_engine_signals` (`GET /api/diagnostics/order-flow/engine/signals[?date=]`). P3 merged.
P4: a DHAN_* SIGNAL becomes an options PAPER candidate through the fresh-start adapter and store (same arming, books,
fees, IV filter, record-only risk flags); the futures plan is translated to the paper reference by the current basis
(recorded). The paper decision is written on the signal row. Expiry gamma stays shadow: its rule defines no stop, and
paper sizing needs one (owner decision pending). `DHAN_ENGINE_PAPER=false` switches paper entries off. P5–P6 next.

P3 known limits (recorded, not hidden):
- A–D decide on 15-minute footprint closes (Part 11 asks for 5-minute confirmation; 5-minute footprints with price
  rows are not built yet); the 30-minute frame is two 15-minute bars.
- Reference levels (PDH/PDL, OR) come from the futures contract's own bars, not the spot index (Part 15).
- Setup B needs RVOL against 20 recorded sessions of the same slot: it cannot fire before ~20 sessions of v2 bars.
- R:R is gross on the underlying; option spread / costs, daily loss and F&O restrictions are phase 4 (listed as
  "not evaluated" in every no-trade report, never assumed clear).
- Expiry gamma: day high / low from the minute chain samples' spot; R1 is not available on that path (null).
All thresholds below are the master prompt's initial research values, configurable and versioned. None is claimed
profitable. Execution stays paper-only / human-approved (Part 23).

---

## 3.1 Decisions needed from the owner before any code

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Data provider | (a) Dhan exclusive for everything (master, books, options); (b) **Hybrid**: Dhan for order flow, footprint, structure and candles, with option books and contract pricing staying on today's adapter | **(b)**. A full switch rewrites the working option-pricing path and risks both feeds at once. |
| D2 | Risk rules for this engine | (a) Prompt Part 16 enforced (3 trades/day, stop after 2 losses, max 2 open, 1% daily); (b) 7 Nov rule: record-only in paper | For a *validation* engine, (a) as **recorded flags** keeps samples comparable. Your call. |
| D3 | Futures long/short signals | (a) Paper-trade futures too; (b) signals only, options paper-traded | (b) first; futures paper needs new margin/fee/position code. |
| D4 | Fresh-start 2.0 strategies | (a) keep running alongside; (b) move to shadow when A–D start | (a) until A–D have data. |
| D5 | Expiry-Gamma module (separate request) | keep separate / drop | Keep separate; not part of A–D. |
| D6 | Network access | allow `dhanhq.co` in the session's network settings | Needed to re-verify every **REVALIDATE** item in report 2. |
| D7 | Tick-recording storage | ~0.5–1 GB/month extra (see §3.4) | Needed for any footprint backtest. |

## 3.2 Architecture (target)

```
Dhan WS (existing single connection, more instruments)
  → packet parser (existing)            → per-instrument health (staleness, gaps)   [new]
  → event normaliser + reconciler       → trade events (ESTIMATED side) + unreconciled volume   [new]
  → raw event recorder (compressed)     → replay store   [new]
  → per-contract engines (one series per contract; expiries never mixed):
       candles · footprint (tick rows, diagonal + stacked imbalance) · CVD · session volume profile · VWAP(+bands)
       · structure (2/2 pivots, BOS/CHoCH, sweeps, FVG) · absorption · exhaustion · regime   [extend / new]
  → setups A, B, C, D (independent modules, shadow first)   [new]
  → scoring + mandatory gates + no-trade engine   [new]
  → options selection (existing adapter) · risk engine · paper store (existing)
  → dashboard: footprint ladder, CVD, setup board, audit   [new UI]
```

One process, one Dhan socket, shared in-memory state, bounded buffers. Strategy modules read the engines; none opens
a connection or calls REST on its own.

## 3.3 Phases, each a separate PR with tests and owner sign-off

| Phase | Deliverable | Key tests | Exit criteria |
|---|---|---|---|
| **P1 Data integrity** | Reconciler (LTQ vs volume delta; unreconciled volume; INCOMPLETE intervals), per-instrument staleness, VERIFIED/ESTIMATED/UNAVAILABLE/STALE/INVALID field status, tick/lot size from Dhan master, LTQ overflow guard, BSE_FNO segment (only if D6 confirms support), subscription expansion (stock futures, MCX metals), raw event recorder | Packet fixtures; reconciliation maths; overflow; session boundaries; reconnect; missing data | 1 week live: data-quality index per instrument logged; packet rate/CPU/memory measured |
| **P2 Engines** | Footprint v2 (tick rows, diagonal imbalance 300%, stacked ≥ 3, min-volume filter), CVD (candle/session/rolling, divergence, reset), session/developing volume profile (70% VA, HVN/LVN), trade-based VWAP + bands (candle VWAP labelled approximation), structure per Part 6, absorption (50-obs baseline, 80th pct, ATR progress, confirmation), exhaustion, multi-TF regime | Hand-computed fixtures for every formula; property tests (CVD additivity, VA ≥ 70%, no division by tiny denominators); live/replay parity on recorded data | Values match fixtures; dashboard shows them with status labels |
| **P3 Setups A–D (shadow)** | Four independent modules exactly as Part 10; 10-point score; mandatory gates; no-trade engine (Part 18) | Per-setup gate tests both directions; no double counting; every refusal named | Signals recorded with full evidence; no paper entries yet |
| **P4 Options + risk** | Futures-signal → option selection via existing adapter (delta 0.45–0.65, spread/IV/theta rejects, conservative premium risk); risk engine per D2; partial at +1R evaluation, trailing on 1/3-min swings | Sizing to lot multiples; fee maths; correlated-risk aggregation | Paper entries for setups the owner enables |
| **P5 Dashboard** | Footprint ladder, CVD panel, setup board, trade audit with rejection reasons, data-quality badges | UI unit tests | Estimated vs verified data visibly distinct |
| **P6 Validation** | Candle-based backtests now; footprint replay as recorded data accumulates; out-of-sample + walk-forward; per-setup report (win rate, expectancy, PF, DD, net R, costs, by instrument/regime) | Report reproducible from stored data | ≥ 200 trades per setup where data allows; no claim beyond the evidence |

Rough effort: P1 and P2 are the bulk (each several working sessions); P3–P5 follow. Footprint setups cannot be
statistically validated before months of recorded data (report 2, §2.3.5). That is a data limit, not a schedule choice.

## 3.4 Resource-consumption estimates (to be measured in P1)

| Resource | Today | Added (estimate) | Basis |
|---|---|---|---|
| Dhan WS connections | 1 | 0 | reuse |
| Dhan instruments | 10 | ~230 (≈ 200 stock futures + 6 index + ~12 MCX + 2 BSE if supported) | limit 5,000 |
| Packet rate | small | ~230–700 packets/s peak (assumed 1–3/s/instrument) | measure in P1 |
| CPU | 0.19 vCPU avg | +0.05–0.15 vCPU | parsing + per-trade engine updates |
| RAM | 1.8 GB avg | +100–300 MB | per-contract footprint levels, CVD, profiles, bounded tick buffers |
| Postgres rows | — | footprint bars: ~230 instruments × ~25 bars/day ≈ 6k rows/day (+ levels jsonb) | current 15-min table, extended |
| Raw tick recording | none | ~1–3 M trade events/day → compressed blobs per instrument per 15 min ≈ 20–40 MB/day, **≈ 0.5–1 GB/month** | not one row per tick (that would be ~10× larger) |
| Dhan REST | quotes 1/s, chain ≤ 1/3 s, candles ≤ 5/s | option chain for 6 indices ≈ 1 call per 18 s; candles only for history seeding | no polling of socket data |
| Angel One | unchanged | 0 | D1 = hybrid |
| Railway plan | — | no new services; one more Postgres growth line (D7) | — |

Safeguards: bounded buffers with drop counters; recorder writes batched every 15 min; nightly retention for raw
blobs (configurable, e.g. 90 days); the engine degrades to UNAVAILABLE, never blocks the existing feeds.

## 3.5 Acceptance (Part 25) mapping

Each of the 28 acceptance items maps to a phase: data/feed items 1–8 → P1; calculation items 9–16 → P2; strategies,
regime, scoring 17–18 → P3; options/SL/TSL/risk/no-trade 19–23 → P4; backtest/paper 24–25 → P6; dashboard 26 → P5;
infrastructure 27 → measured in every phase; no execution 28 → already true and kept by a test. A final technical
audit report closes the project.

## 3.6 What will not be done

No order API, no fabricated data, no claim of a win rate, no changes to Angel/Dhan credentials or production
variables without approval, no rewrite of working modules, no deploy without the owner's go-ahead.
