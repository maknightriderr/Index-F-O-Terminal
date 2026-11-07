# 2. DhanHQ Data Availability and Footprint Feasibility Report

**Source of facts.** `dhanhq.co` is not reachable from the audit session (it is not on the session's allowed network
domains), so the official docs could not be re-read live. Facts below come from (a) the repo's working Dhan
integration, which was written against the v2 docs and runs in production, and (b) the limits stated in the master
prompt. Every item marked **REVALIDATE** must be checked against https://dhanhq.co/docs/v2/ before implementation.
Nothing here is invented: where something is unknown it says so.

---

## 2.1 What each Dhan source provides

| Source | Provides | Confirmed by | Limits |
|---|---|---|---|
| Live feed, FULL packet | LTP, LTQ (int16), LTT (epoch s), ATP, cumulative day volume, total buy/sell qty, OI, high/low OI, OHLC, **5 levels of depth** (qty, orders, price) | Parser in production (`dhan-feed-packets.ts`) | 5 connections/user, 5,000 instruments/connection, 100 per subscribe message (prompt; **REVALIDATE**) |
| Live feed, QUOTE | LTP, LTQ, LTT, ATP, volume, buy/sell qty, OHLC (no depth, no OI) | Parser | same |
| Live feed, TICKER | LTP, LTT | Parser | same |
| Full market depth (20 / 200 level) | Deeper book | **Not used in the repo** | Segments and availability **REVALIDATE** |
| Market quote REST | Snapshot quotes | `providers/dhan/quotes.ts` | 1 call/s, ≤ 1,000 instruments |
| Intraday historical | OHLCV + OI candles, 1/5/15/25/60 min | `providers/dhan/history.ts` | ≤ 90 days per call; data APIs 5/s; how far back **REVALIDATE** |
| Daily historical | Daily OHLCV | not used yet | **REVALIDATE** |
| Option chain | Per-strike OI, volume, IV, Greeks, LTP/bid/ask for an underlying + expiry | `providers/dhan/greeks.ts` (indices) | 1 unique request / 3 s |
| Expired options data | Historical premiums of expired contracts | **not used yet** | Granularity / fields **REVALIDATE** |
| Instrument master (CSV) | Security id, segment, symbol, expiry, strike, option type, lot size, tick size | `resolveNearestFutures` (one download/day) | One download/day is enough |

## 2.2 Segment coverage

| Market | Dhan feed today | Feasible? |
|---|---|---|
| NSE index futures (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY) | ✅ subscribed | ✅ |
| BSE index futures (SENSEX, BANKEX) | ❌ not wired (only NSE_FNO=2, MCX_COMM=5 codes in code) | Segment support **REVALIDATE**. Even if supported, BSE index **futures** trade thinly, so an estimated footprint may be too sparse to be meaningful. Needs a liquidity measurement before any strategy uses it. |
| MCX (GOLD, SILVER, CRUDEOIL, NATURALGAS + minis) | ✅ 6 subscribed | ✅; GOLDM, SILVERM, COPPER, ZINC, ALUMINIUM, LEAD can be added (same segment) |
| NSE stock futures (~200) | ❌ | ✅ within one connection's 5,000-instrument limit. Liquidity varies widely; many are too thin for a footprint. |
| Spot indices | not on Dhan feed (Angel provides) | Reference levels only. A footprint is never built from a spot index (no traded volume). |

## 2.3 Footprint feasibility: the honest limits

1. **No aggressor side.** The feed reports the last trade and the book, not who initiated it. Every buy/sell split
   is **ESTIMATED** (quote rule against the pre-trade quote, then tick rule). It must never be labelled exact.
2. **The feed is a snapshot stream, not a trade stream.** Between two packets several trades can occur. The packet's
   cumulative volume reveals the total, LTQ reveals only the last trade's size. Rule for the new engine
   (Part 4.1): if `volume − prevVolume > LTQ`, the excess is **unreconciled volume**, which:
   - is recorded separately,
   - is never assigned a price level or side,
   - marks the interval INCOMPLETE above a threshold.

   Today's code books the whole difference as one trade at LTP, which is incorrect under the prompt.
3. **Classification accuracy cannot be measured against truth**, because no exchange aggressor data exists to compare
   with. What can be measured is a **data-quality index** per interval:
   - reconciled share (volume explained by observed LTQs),
   - quote-rule share vs tick-rule share,
   - UNKNOWN share,
   - packet gaps.

   Signals should require minimum quality on these numbers.
4. **Historical footprint does not exist.** Dhan history is OHLCV(+OI) candles. A historical footprint/CVD cannot be
   reconstructed from candles (Part 4/19). **Footprint-dependent setups (A, B, C, D all use footprint/CVD) can only be
   validated on data recorded from the day recording starts.**
5. **Sample-size consequence.** At 200 trades per setup (Part 19), a setup that fires ~1–2 times a day across the
   universe needs ~3–6 months of recorded live data before statistical validation. Candle-only components (structure,
   VWAP, RVOL, OI) can be backtested now on Dhan candles.
6. **Tick size.** The new footprint must bucket by the instrument's tick size (from the master) or explicit multi-tick
   rows per instrument; a native-tick ladder on NIFTY futures (tick 0.05–0.10) is too granular to read, so multi-tick
   rows must be configured and versioned.
7. **LTQ is int16** in the documented layout. Large single prints (> 32,767 units) would overflow; **REVALIDATE** the
   field width and add an overflow guard.
8. **Time stamps.** LTT is in seconds; bar assignment today uses receive time. Packet ordering/sequence numbers are
   not provided in FULL packets (per the parser). Sequence-quality tracking must rely on LTT monotonicity and volume
   monotonicity.

## 2.4 Assumptions that cannot be validated with Dhan data

| Assumption | Why it cannot be validated |
|---|---|
| Inferred buy/sell equals true aggressor flow | No ground-truth aggressor data from the exchange via Dhan |
| Unreconciled volume is evenly distributed / ignorable | Its price and side are unknowable |
| OI change at a strike = writers covering / buying | OI does not reveal participant identity or intent (Part 9 already says so) |
| Absorption = passive large orders | Depth snapshots (5 levels) do not show iceberg / hidden liquidity or order cancellations between packets |
| A 300% diagonal imbalance or 80th-percentile absorption threshold is predictive | Research parameters; only recorded forward data can test them |
| BSE index futures footprint is usable | Liquidity unknown until measured |
| Historical setup performance before recording starts | No historical footprint |

## 2.5 What is feasible now vs later

| Component | Feasible now | Status label |
|---|---|---|
| Market structure, VWAP (candle-based, labelled), RVOL, OI, option chain, Greeks/IV | ✅ backtestable on Dhan candles + chain | VERIFIED (exchange data) / approximation labelled |
| Delta, CVD, footprint, imbalance, absorption, exhaustion, volume profile from trades | ✅ live, forward only | ESTIMATED |
| Footprint-based setup statistics | ⏳ after recorded data accumulates | — |
| 20-level depth features | ❓ | REVALIDATE availability |

## 2.6 Infrastructure impact of using Dhan more

- **Connections:** reuse the existing single Dhan socket (limit 5); expanding to ~230 instruments stays far under 5,000.
- **Bandwidth/CPU:** FULL packet = 162 bytes. At an assumed average 1–3 packets/s/instrument × ~230 instruments ≈
  40–110 KB/s, a few % of one vCPU for parsing. This is an estimate and must be measured in phase 1.
- **REST:** no polling of what the socket provides; option chain ≤ 1 unique call / 3 s (already enforced); master once a day.
- **Angel One:** untouched unless the owner chooses to move option books to Dhan.
