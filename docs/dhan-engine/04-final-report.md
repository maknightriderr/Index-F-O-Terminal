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

## Decision pending from the owner

- **Expiry gamma paper trades.** The rule as given defines no stop-loss, and paper sizing needs one. Until the owner states one, gamma is recorded as SIGNAL rows only. Example choices: the opposite side of the midday range, a fixed premium percentage, or the 15:15 time exit only with a premium stop.
