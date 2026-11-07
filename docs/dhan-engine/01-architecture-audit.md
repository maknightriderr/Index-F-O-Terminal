# 1. Existing Architecture and Codebase Audit

Scope: Master Prompt V2.0 (DhanHQ order flow + footprint + market structure engine), Part 24 / Part 26.
Audited on 7 Nov 2026 against `main` @ `37429b3` (PRs up to #159). No code was changed for this audit.

Status legend used throughout: **Implemented** · **Partial** · **Missing** · **Incorrect** (works, but not as the
master prompt specifies) · **Data limitation** · **Performance issue** · **Requires validation**.

---

## 1.1 System topology

| Layer | Where | Notes |
|---|---|---|
| Backend | `apps/server` (Express/TS) on Railway, service `backend` | Single process; timers supervised by `service-supervisor`. |
| Web | `apps/web` (Next.js) on Vercel | Command Center, Workspace, Strategy Lab, Signal Diagnostics (order-flow panel). |
| Shared logic | `packages/analytics` (pure, no IO), `packages/shared` (types, calendars) | All strategy maths is pure and unit-tested here. |
| Storage | Postgres (Railway) + Redis (Railway) | Postgres disk ~2.9 GB (5 Nov); nightly trim of fresh-start inputs > 10 days. |
| Resources (24 h, 6 Nov) | backend RAM avg 1.8 GB, max 5.1 GB; CPU avg 0.19 vCPU, max 1.16 | RSS 1.6–2.15 GB, of which ~1.2 GB native (instrument master, buffers). |

## 1.2 Market-data providers today

| Provider | Used for | Code | Limits enforced in code |
|---|---|---|---|
| **Angel One** WebSocket (SNAP_QUOTE) | Live ticks/books for the fresh-start engine (index/stock/MCX futures, option books, OI per tick) and the legacy UI | `lib/subscription-manager.ts` (shared, 950-token cap), `fresh-start/feed.ts` (≤ 400 tokens) | 950 shared tokens; watchdog reconnect |
| Angel One REST | Instrument master (the system's master of record), candles (fallback), option chain build | `providers/angel-one` | Retries / 403 backoff |
| **Dhan** WebSocket (FULL) | Order flow for **10 futures only**: NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, CRUDEOIL, CRUDEOILM, GOLD, SILVER, NATURALGAS, NATGASMINI | `services/dhan-feed.ts`, `lib/dhan-feed-packets.ts` | 1 connection; daily Data-API plan check; exponential backoff; 429 → 30 min |
| Dhan REST quotes | Quotes for contracts verified identical on both masters (`QUOTE_PROVIDER=DHAN`) | `providers/dhan/quotes.ts` | 1 call/s, ≤ 1000 instruments/call, merged requests |
| Dhan REST intraday candles | Candles when the contract is verified identical; else Angel | `providers/dhan/history.ts` | ≥ 300 ms between calls (5/s), ≤ 90 days per call |
| Dhan option chain | IV / Greeks for NSE/BSE indices | `providers/dhan/greeks.ts` | ≥ 3.2 s between calls |
| Dhan auth | 24 h token; TOTP auto-login or RenewToken; token in Redis, never logged | `services/dhan-session.ts` | — |

Production check (Railway logs, 6 Nov): the Dhan feed resolves its 10 futures and connects after every deploy
("connected and subscribed (FULL packets, data only)"). The Data-API plan is active.

## 1.3 Engines and strategies today

| Engine | State | Notes |
|---|---|---|
| Legacy indicator / bias engine (`market-bias.ts`, trade-setup, OF1, OB-2.0) | **All trading paused since 30 Oct** (owner decision); Market Intelligence UI still computed | OF1 = location + order flow + price response (close to Setup D/A in spirit); OB-2.0 order blocks; FVG module; regime classifier (+DI/−DI fixed 7 Nov). |
| Fresh-start 2.0 (`services/fresh-start`, `packages/analytics/src/fresh-start`) | **Active (paper)** | 3 active: `NEW_RS_STOCK_V1`, `NEW_INDEX_BREADTH_V1`, `NEW_MCX_FLOW_V1`; 7 × 1.x in shadow. Options only. |
| Paper store | Active | Postgres, portfolio row lock per entry, Telegram notices, risk flags recorded (not enforced) in paper. |
| Execution | **None** | No order API is called anywhere (Dhan or Angel). Matches Part 23. |

## 1.4 Order-flow / footprint stack vs the master prompt

| Prompt item | Current implementation | Status |
|---|---|---|
| Single normalized data layer (3.1) | Dhan FULL packets → `tradeFromFullPacket` → `order-flow-store` (5-min flow bars + 15-min footprints). Angel feed is a separate layer for prices/books. | **Partial** |
| Instrument coverage (Part 2) | Dhan feed: 4 NSE index futures + 6 MCX. **No BSE (SENSEX/BANKEX), no stock futures, no COPPER/ZINC/ALUMINIUM/LEAD, no GOLDM/SILVERM.** | **Partial** |
| Instrument mapping from Dhan master (2.4) | Nearest future resolved daily from Dhan's scrip master CSV (one download/day). Tick size and lot size are **not** taken from it. | **Partial** |
| Packet parsing (3.2) | Header, TICKER, QUOTE, FULL (5-level depth), DISCONNECT; little-endian; malformed tails dropped. Unit-tested. Segments: NSE_FNO=2, MCX_COMM=5 only. | **Implemented** (segments **Partial**) |
| Connection health (3.2) | Backoff, plan check, token refresh; no per-instrument staleness; no explicit ping/pong handling beyond the `ws` library. | **Partial** |
| Trade classification (4.1) | Quote rule against the **previous packet's** best bid/ask, then tick rule; unclassified kept separate. | **Implemented** |
| Volume discontinuity (4.1) | `volume − prevVolume` is booked as **one trade at LTP**, even when it covers several trades between packets. LTQ is parsed but not reconciled; no incomplete-interval flag. | **Incorrect** (vs 4.1) |
| LTQ field width | Parsed as int16 (per the documented layout); a quantity > 32,767 would overflow. | **Requires validation** |
| Volume delta / delta % (4.2) | Per bar; null when < 80% classified. | **Implemented** |
| CVD (4.3) | **None** (no candle/session/rolling CVD, divergence, reset). | **Missing** |
| Price-row aggregation (4.4) | Fixed per-symbol step (NIFTY 5, BANKNIFTY 10, CRUDEOIL 2 …), not the instrument tick size. | **Incorrect** (vs 4.4) |
| Imbalance (5.1) | Same-level buy ÷ sell ≥ 3 (horizontal), with a min-share filter. Not diagonal. | **Incorrect** (vs 5.1) |
| Stacked imbalance (5.2) | Only a count of imbalance levels; no "3 consecutive" logic. | **Missing** |
| Absorption (5.3) | Heuristic: ≥ 40% of the bar's sell volume in its lowest third and close in upper half. No percentile baseline, no follow-up confirmation. | **Partial** |
| Exhaustion (5.4) | None. | **Missing** |
| Volume profile (Part 7) | Per-bar POC / VAH / VAL (70%, grown from POC, tie rule documented). No session / developing profile, HVN/LVN, per-expiry separation. | **Partial** |
| VWAP (8.1) | Fresh-start: session VWAP from 1-min candles (an approximation, not labelled as such). Legacy engine: VWAP from candles. No bands/slope module. | **Partial** |
| Relative volume (8.2) | Same time-of-day slot, median of ≥ 15 (up to 20) prior sessions. | **Implemented** |
| Market structure (Part 6) | `analyzeMarketStructure`, `detectLiquiditySweep`, FVG module, swing levels in fresh-start; BOS/CHoCH with tick buffer and 2/2 confirmed pivots not specified as in Part 6. | **Partial / Requires validation** |
| OI engine (Part 9) | F&O scanner (futures OI change + interpretation for ~200 stocks), option chain OI per strike, PCR, intraday positioning windows, index futures OI samples (fresh-start). | **Implemented** (mostly) |
| Four setups A–D (Part 10) | Not implemented as specified. OF1 (paused) overlaps Setup D/A partially. | **Missing** |
| Multi-TF regime (Part 11) | Regime classifier (1H ADX ± 15m fallback) in legacy engine; fresh-start uses 15m EMA trend + efficiency. Not the Daily/30m/15m/5m/1m stack. | **Partial** |
| 10-point scoring (Part 12) | None. | **Missing** |
| Option selection (Part 13) | Fresh-start adapter: exact contracts, parity basis, premium scenarios, delta 0.45–0.65, spread caps, IV rank, fees; quotes from Angel books. | **Implemented** (Angel books) |
| SL / targets / trailing (Part 14) | Structural stop, premium emergency stop, trailing (TREND profile), NO_PROGRESS, MAX_HOLD. Partial at +1R not implemented (single position). | **Partial** |
| Risk (Part 16) | 0.5%/trade; daily 1%, 3-loss pause, max 2 open are **recorded, not enforced** in paper since 7 Nov (owner decision). Prompt asks: max 3 trades/day, stop after 2 losses. | **Conflict — needs owner decision** |
| Futures long/short signals | Not supported (options only). | **Missing** |
| Data status labels (3.5) | Order-flow: EXACT / INFERRED / UNAVAILABLE; fresh-start refusal codes (…_STALE / …_UNAVAILABLE). No uniform VERIFIED/ESTIMATED/UNAVAILABLE/STALE/INVALID per field. | **Partial** |
| Dashboard (Part 20) | Order-flow panel, Command Center radar, Strategy Lab, trade audit. No footprint ladder, no CVD chart. | **Partial** |
| Backtesting (Part 19) | Research runner (fresh-start), structure backtest; candle-based only. No tick recording → no footprint replay. | **Partial / Data limitation** |
| No automatic execution (Part 23) | No order API anywhere. | **Implemented** |
| Secrets (Part 22) | Tokens never logged (URL-carried tokens: only messages logged); Redis-held session. | **Implemented** |

## 1.5 Storage relevant to the new engine

| Table | Content |
|---|---|
| `order_flow_bars` (migration 038) | One row per symbol per closed 15-min bar: delta mode, trades, volume, buy/sell/unclassified, delta, delta %, POC/VAH/VAL, imbalance counts, **levels (jsonb)**. |
| `order_blocks`, `order_block_shadow`, `of1_candidates` | OB-2.0 lifecycle and OF1 candidates (legacy). |
| `oi_snapshots`, `futures_snapshots` (043) | OI history. |
| `fresh_*` (047–050) | Fresh-start evaluations, candidates, adapter decisions, paper positions/events. |

**No raw trade / tick events are stored.** A genuine footprint replay (Part 19) needs them recorded from now on.

## 1.6 Conflicts with decisions already taken (need the owner)

1. **"Dhan as exclusive provider"** vs today: Angel One is the master of record and the source of option books for
   the paper adapter. A full switch touches every engine and is the single largest risk in the plan.
2. **Risk limits:** prompt = max 3 trades/day, stop after 2 consecutive losses, max 2 positions, 1% daily loss
   (enforced). 7 Nov owner decision = record-only in paper.
3. **Session windows:** prompt = NSE primary 09:30–11:30, secondary 13:30–14:45. Fresh-start = 10:00 to cutoff
   (session close − 60 min = 14:30).
4. **Strategies:** prompt says implement A–D exactly and "do not invent". The three fresh-start 2.0 strategies and
   the proposed Expiry-Gamma module are outside A–D.
5. **Futures signals:** new instrument class for the paper store (today options only).

## 1.7 Reusable components (do not rebuild)

Dhan session/auth, Dhan packet parser, quote/history/greeks clients with rate limits, `order-flow-store` (bars,
persistence, UNAVAILABLE handling), `buildFootprint` / `valueArea` / `inferTradeSide`, F&O scanner (OI interpretation,
RS), option chain + intraday positioning, fresh-start adapter (contract selection, parity, fees, sizing), paper
store, Telegram notifier, decision summary / operational evidence logs, calendars, nightly retention.
