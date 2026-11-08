# 4. Dhan Order-Flow Engine v2: Final Technical Report (8 Nov 2026)

Phases P1–P6 of `03-implementation-plan.md` are merged and deployed, in PRs #160–#165.

- **No order API.** Execution is paper-only, in options.
- **No performance claim.** The validation numbers start at zero, because footprint data only exists from the day recording began (9 Nov). Every report flags samples under 200 trades.

## What runs, end to end

```
Dhan WS (one socket, ~244 futures contracts, 100 instruments per subscribe message)
  -> reconciler (LTQ vs volume change; unreconciled volume is never given a price or a side; INCOMPLETE above 20%)
  -> 15-minute footprints (multi-tick rows, about 5 bp each) + recorded trade events (gzip, kept 30 days)  [P1]
  -> engines: footprint v2, CVD, volume profile, VWAP, structure, absorption, exhaustion, regime   [P2]
  -> setups A–D + 10-point score + mandatory gates + no-trade engine; expiry gamma (tagged)         [P3]
  -> SIGNAL -> options paper candidate through the fresh-start adapter and store (DHAN_* tags)       [P4]
  -> Signal Diagnostics -> Dhan engine v2: setup board, contract engines, footprint ladder, validation [P5/P6]
  -> validation: recorded signals graded on recorded trades; footprint replay from recorded events  [P6]
```

## Endpoints

| Endpoint | What it returns |
|---|---|
| `GET /api/diagnostics/order-flow/engine[?symbol=]` | Engine state per contract |
| `GET /api/diagnostics/order-flow/engine/signals[?date=]` | The day's setup signals, with the paper decision for each |
| `GET /api/diagnostics/order-flow/engine/validation[?from&to]` | Per-setup report: win rate, expectancy (gross and net), profit factor, max drawdown, chronological out-of-sample and walk-forward splits, broken down by symbol and by regime. At most 62 days. |
| `GET /api/diagnostics/order-flow/engine/replay?symbol&from&to` | Footprint replay of one contract, at most 10 days |

## Switches

| Variable | Effect |
|---|---|
| `DHAN_FLOW_V2` | Expanded instrument universe |
| `DHAN_FLOW_STOCKS` | Stock futures |
| `DHAN_ENGINE_SHADOW` | Setup evaluation and recording |
| `DHAN_ENGINE_PAPER` | Paper entries |
| `FLOW_EVENT_RETENTION_DAYS` | Retention for recorded trade events; default 30, allowed 7–365 |

## Acceptance (Part 25) status

| Area | Status |
|---|---|
| Data / feed (1–8) | Done. Per-instrument status (ESTIMATED / STALE / UNAVAILABLE), reconciliation, the LTQ overflow guard, tick and lot size from the master file (tick size is in paise), BSE_FNO = 8, the silence watchdog, a quality log every 15 minutes. |
| Calculations (9–16) | Done, each with hand-computed fixture tests and property tests (CVD additivity, value area always ≥ 70%). |
| Strategies, regime, scoring (17–18) | Done. Both directions run through the same rules (mirroring), and every refusal is named. |
| Options / SL / risk / no-trade (19–23) | Done through the existing adapter: books, fees, IV filter, delta band. Risk limits are record-only flags (owner decision D2). Option spread, daily loss and F&O restrictions are evaluated by the paper adapter. In the signal's no-trade report they are listed as "not evaluated", never assumed clear. |
| Backtest / paper (24–25) | Recorded-signal grading and footprint replay are done. **Candle backtests of A–D are not possible**: every setup needs footprint or CVD, which Dhan's candle history cannot provide. |
| Dashboard (26) | Done. Every value carries a status badge. |
| Infrastructure (27) | ~9 ms per contract evaluation (about 2 s of CPU every 15 minutes); recorded events about 20–40 MB a day with a nightly cleanup; the same single Dhan socket; Angel One unchanged. |
| No execution (28) | True. There is no order code anywhere. |

## Known limits (stated, not hidden)

1. Setups decide on 15-minute closes. Part 11 asks for 5-minute confirmation, but 5-minute footprints with price rows are not built yet.
2. Reference levels come from the futures contract's own bars, not the spot index (Part 15).
3. Setup B needs RVOL from 20 recorded sessions of the same time slot, so it cannot fire before about 20 sessions.
4. The R:R on a signal is gross, on the underlying. Paper trades carry the real option fees. The validation report's net figure deducts 2 ticks of futures slippage.
5. Expiry gamma takes the day high and low from the minute chain samples. R1 is not available on that path.
6. Paper translation shifts the futures plan onto the paper reference by the current basis. It refuses if either price is older than 60 s or the two differ by more than 3%.

## Expiry gamma paper trades (owner decision, 8 Nov: 30% stop-loss)

A gamma SIGNAL is paper-traded on the **expiry-day** index option (ATM or one strike ITM, |delta| 0.55-0.85) with a
premium-defined exit: a stop **30% below the entry premium** and the module's **15:15 time exit**; entries until 15:00.
No underlying target, structural invalidation, trailing, no-progress or max-hold exit applies to it (its underlying
levels are model inputs only). On an index's expiry day, 13:10-15:20 IST, the worker also subscribes that day's option
books (5 strikes, CE + PE). Every other strategy keeps its own rules (0DTE refused, |delta| 0.45-0.65, 25% emergency
stop, entries until one hour before the cutoff), checked by tests. Gamma is still not graded in the validation report,
which grades underlying plans; its paper results are in the paper store under DHAN_EXPIRY_GAMMA.

## Audit fixes (8 Nov)

| # | Gap found | Fix |
|---|---|---|
| 1 | A restart / deploy wiped the order-flow memory: session VWAP, CVD and profile restarted from the restart but were still labelled complete; the opening range moved to the first bar after the restart; previous-day levels, absorption baseline and expiry-gamma baseline were lost | On start, today's and the previous session's closed bars are rebuilt from `order_flow_events` (same rules as live). The bar the process started in is kept as an INCOMPLETE gap marker, and the session VWAP / CVD from there are INCOMPLETE. Setups never use incomplete session totals (A6 / C2 / D3 CVD, B2 / D1 VWAP, D1 profile zones). The opening range uses the exchange open. Expiry-gamma samples and fired sides are kept in Redis for the day. |
| 2 | DHAN paper exits used the fresh-start 5-minute rules (60-min max hold, no-progress exit) | Exit profile `STRUCTURE` (Part 14): structural stop on a 5-minute close, the setup's target, no breakeven at +1R, from +1.5R a stop 1R behind the best price, no max-hold / no-progress exit. Partial booking and exit on opposing absorption / CVD reversal are not implemented: the paper engine closes whole positions and the monitor does not read the engines. |
| 3 | A DHAN signal on a stock not in the fresh worker's selection could not be priced | The stock takes a stock slot for 5 minutes, its books become urgent, the paper path waits up to 30 s for its price, and the entry window is 45 s. The extended-entry check (0.25 ATR) still bounds the price. |
| 4 | DHAN and fresh-start strategies shared one paper account (cash, risk, one position per instrument), and the schema allowed one account per day | Separate book per session (`<version>:DHAN:<session>`): own capital, reservations, one-position-per-instrument and cohort. The schema index is now one account per session, version and book. |
| 5 | DHAN strategies were missing from the performance report, Strategy Lab, the fresh-start panel and Telegram | Added (`FRESH_REPORTED_STRATEGIES`, web `PAPER_STRATEGY_IDS`, labels). |
| A | The store still refused expiry-gamma entries after 14:30 (one hour before the cutoff) | A premium-exit candidate enters until its own `entryUntil` (15:00), never inside the last 10 minutes. |
| — | BSE policy text said `zeroDte:false` without noting the gamma exception | Comment added. |

Still open, and needs data: the MCX GOLD option calendar ends on 28 Nov and the SILVER option links on 1 Dec. The next published calendars must be added, or the fresh-start MCX path stops on those dates.

## Second audit (8 Nov, evening)

| # | Gap found | Fix |
|---|---|---|
| 1 | The schema still enforced one open position per **risk group** (`fresh_one_open_group`), although 2.0 made it a record-only flag (owner D2). A second index (NIFTY + BANKNIFTY / SENSEX, all `NSE_INDEX_CORRELATED`) or a same-sector stock passed admission with `WOULD_BLOCK_CORRELATED` and then failed with a unique violation: no position, no refusal recorded. This affected fresh-start since #154, the DHAN book and expiry gamma. | The index is dropped; one position per instrument and one fill per parent stay enforced. The store turns any schema uniqueness conflict into an `EXPOSURE_OR_PARENT` refusal instead of an exception. |
| 2 | Every fresh-worker scan (10 s) disarmed paper entries at its start and re-armed them only after several awaits (DB, subscription sync, Redis key scan). Candidates arriving in that window (Dhan engine signals, a pricing finishing mid-scan) were refused `PAPER_DISABLED`. | No transient disarm. The armed state is decided once per scan; the closed-market, stop and error paths disarm explicitly. |
| 3 | DHAN setups recorded SIGNALs until 14:45 (Part 17 secondary window), but paper entries stopped at 14:30 (fresh-start one-hour rule), and a bar closing at 14:45 counted as tradable. | DHAN candidates enter until 45 minutes before the cutoff (`lastEntryBeforeCutoffMs`; 14:45 NSE / BSE). A bar closing at 14:45 is AFTER_CUTOFF. |
| 4 | PDH / PDL / PWH / PWL were taken from whatever days were in memory, so a partial day or week (late feed, restart, short stock memory) gave false levels. | Levels are used only when the previous trading session (exchange calendar) and every trading day of the previous ISO week are covered (first bar within 30 minutes of the open, last within 30 minutes of the close); otherwise they are dropped. |
| 5 | An external (DHAN) candidate had to start within 2 s in the evaluations queue, which is busiest at bar closes. | It may start for up to 15 s, inside its own entry window. |
| 6 | The Command Center account card measured both books' trades against the fresh-start capital. | `accountView` is per book (fresh-start by default). |

Verified, not bugs:
- Monitor exits for positions on references that leave the selection still work: 5-minute closes are built from live prints, and held tokens stay subscribed.
- The option chain includes the expiring contract on expiry day (`expiry >= today`).
- Holiday, fee and MCX calendar horizons are already alerted 30 days ahead (`CALENDAR_HORIZON`).
- Secrets are never logged.

Calendar facts:
- NSE is closed on Tue 10 Nov and Tue 24 Nov 2026.
- The NIFTY weekly expiry is therefore **Mon 9 Nov** (then 17 Nov and Mon 23 Nov), per Dhan's instrument master.
- SENSEX expires on Thu 12 Nov.

Data still needed:
- MCX GOLD option calendar (ends 28 Nov) and SILVER option links (end 1 Dec).
- From 1 Jan 2027: the 2027 NSE / BSE / MCX holiday lists, fee schedule and MCX contract specifications.
- Without them, the fresh-start worker (and so the DHAN paper path) stops with `BLOCKED_CALENDAR_YEAR` on 1 Jan 2027.
