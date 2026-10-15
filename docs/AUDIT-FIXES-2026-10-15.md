# Audit fixes, phase 1 (2026-10-15)

Follow-up to the end-to-end audit of 15 Oct (findings F1–F13). This change set fixes the measurement defects, adds the
evidence machinery the audit asked for, and tests every candidate change to the trading logic against the existing
system before deciding whether to make it.

**Result in one line:** no tested change to the trading logic beat the existing system out of sample, so the trading
logic is unchanged. Profitability has **not** been shown to improve. What changed is that the system can now
measure, compare and archive what it needs to find an improvement that holds.

## 1. The Old Indicator

Requirement: the Old Indicator (the consensus indicator engine, `family = INDICATOR`) keeps generating trades on
every supported stock and index.

**It is untouched.** No direction, confidence, vote, gate, option-selection, stop, target or slot rule changed. The
only edits inside decision-path files are bookkeeping that runs after a trade has closed, or values no decision
reads:

| File | Change | Why no decision can move |
|---|---|---|
| `market-bias.ts` | Session-end close stamps the session close as `exitTime` (was the rollover instant) | Written at the close; the post-loss cooldown runs on Redis TTLs, not `exitTime`; performance membership is decided by mint time |
| `setup-cost.ts` | Adds a `quoteUsableForR` flag and `costForDiagnostics()` | Every number `measureSetupCost` returns is computed exactly as before; only the copy written to `setup_events` withholds R for a non-market quote |
| `validation-gates.ts` | Adds `sessionEndExitTime()` | New pure function, read by the two measurement paths above |
| `index.ts` | Registers the `barArchive` service | Writes `bar_archive` only while no exchange is trading; nothing reads that table in the decision path (guarded by a test) |

**Regression evidence (all pass):**

- `strategy-regression-fingerprint.test.ts`: 21 tests (A2–F3, the A4 stage, S1, router, slot ranking, option builder, gates).
- `trade-setup-golden.test.ts`: 316 frozen snapshots of `buildTradeSetup`, 138 available and 177 refused, covering every refusal code.
- `full-replay.test.ts`: 6 tests; the whole decision path replayed from recorded I/O tapes.
- The new suite asserts that no decision-path file imports `evaluation-core`, `evaluation-reports` or `bar-archive`.

**Universe coverage in production.** Since 5 Oct the Old Indicator minted trades on:

- 5 index underlyings: NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX;
- 88 stocks;
- 4 MCX commodities: CRUDEOIL, GOLD, SILVER, NATURALGAS.

None of that path changed, so it keeps doing so.

The Evidence scorecard marks the Old Indicator **PROTECTED BENCHMARK**. The written rule cannot propose it for
demotion, whatever its numbers.

## 2. Changes

### 2.1 Measurement fixes (audit F11, F13)

| # | Change | Defect it fixes | Test |
|---|---|---|---|
| M1 | `returnedToEntryOf()` in `measurement-core.ts`; the post-exit tracker and `summarisePostExit` derive "price came back to entry" from the stored entry, exit and post-exit min/max | For a losing exit the old check (post-exit low ≤ entry) was true by construction, so every stopped-out trade counted as "price came back to entry" | `audit-fixes-2026-10-15.test.ts` |
| M2 | `sessionEndExitTime()`; session-end exits of intraday trades stamped at the exchange close | Hold time and "open at the same time" counts treated a trade closed at 15:30 as open until the overnight rollover, inflating concurrency | same |
| M3 | `segmentOf(exchange, instrument)` splits NSE/BSE into INDEX vs STOCK in the diagnostics | Index and stock options were reported as one "NSE" segment although their costs and results differ. The shadow promotion counter keeps the old exchange-only split on purpose, so promotion counting does not change. | same |
| M4 | Order-flow report adds an ALL_TOUCHED row (every block judged at its first touch) | The per-state rows were survivorship-biased: a block still in FIRST_TOUCH is one that has not failed yet, so that row looked better than touched blocks really do | same |
| M5 | A two-sided quote with spread above 50% of mid is stored in `setup_events` without cost in R | MCX GOLD legs quoted 230.5 / 26,797 produced costs of 50–216R and dragged every MCX net figure | same (3 tests, including "live measurement unchanged") |

### 2.2 Evidence framework (audit F1, F3, F4, F5)

New, read-only, never imported by the decision path:

- **`evaluation-core.ts`** (pure). Day-clustered bootstrap intervals (seeded, reproducible), Spearman rank correlation by day, Bonferroni correction. It also holds the written rule `EVIDENCE-1.1` (1.0 plus the gate condition below):
  - **Demotion candidate:** at least 30 trades with the upper 95% bound below 0.
  - **Edge shown:** at least 100 trades over at least 20 trading days, with the corrected lower bound above 0 and both halves positive.
  - **Protected:** `INDICATOR`.
  - **Gate verdict** (1.1): a gate is read as FILTERS_WORSE or REFUSES_NO_WORSE only when its refusals fall on at least 5 trading days. Otherwise it is INCONCLUSIVE. After the first deploy, RISK_OFF (61 refusals, all on one day) and WIDE_SPREAD (74 on two days) read FILTERS_WORSE. With the refused side on one or two days, resampling days cannot vary its mean, so those intervals were far too narrow.
- **`evaluation-reports.ts`**. Four reports, each cached for 10 minutes:

  | Endpoint | Answers |
  |---|---|
  | `GET /api/diagnostics/scorecard` | Which strategy has an edge after costs (paper trades, the reliable sample, and graded candidates) |
  | `GET /api/diagnostics/signal-quality` | Does the direction call predict the next 30/60/120 minutes; which vote dimensions carry information |
  | `GET /api/diagnostics/gate-validation` | Does each gate refuse worse decisions than the ones taken |
  | `GET /api/diagnostics/portfolio-risk` | What the portfolio limits already in the code would have done to the paper book |

- **Evidence page** (Performance → Evidence). It shows the four reports with counts and intervals. Each scorecard row also shows the strategy's current code-level stage, so A4 reads "already SHADOW since 2026-10-08" rather than looking like a new proposal.

Every action the rule produces is a proposal. Nothing on this page changes what is traded.

### 2.3 Pre-registered shadow measurements, SHADOW-1.1 (audit F2)

These two rules apply to trades from 2026-10-16 IST. Both are flagged on each closed trade and reported beside SHADOW-1.0
on the Signal Engine tab. They never skip a trade.

- `NET_RR_FLOOR_1`: planned net reward below 1× risk after the trade's own cost.
- `POSITIONING_OPPOSED`: the positioning cluster (futures + options OI) votes against the call.

Each needs at least 30 forward trades and a 0.10R improvement before it may be proposed as a gate.

### 2.4 Price history archive (audit F9)

- **Migration `041_bar_archive.sql`:** table `bar_archive`, one row per bar, keyed (symbol, exchange, interval, bar_time).
- **Service `barArchive`** (the 19th supervised service), which:
  - runs only while NSE, BSE and MCX are all closed;
  - stores the closed 15-minute and daily bars of every symbol the engines evaluated that day, plus 7 fixed indices and commodities;
  - spaces broker history requests 2.5 s apart, archives at most 120 symbol-days per pass, and never fetches a symbol-day twice.

Without stored history, every rule could only be tested on a few weeks of paper trades. From the first deploy the
archive grows by one session per night, which is what a real walk-forward backtest needs.

## 3. Candidate changes tested and rejected

Each was tested in-sample and then out-of-sample, with intervals that resample whole trading days.

| Candidate | In-sample | Out-of-sample | Decision |
|---|---|---|---|
| **Flip the direction when futures and options OI both oppose it** (from F1: OI is the only dimension with a positive rank correlation) | Signed 60-minute move +0.189 ATR better [+0.042, +0.328], 21 Sep–1 Oct, 7,513 decisions | +0.019 [−0.066, +0.098], 2–14 Oct, 1,269 decisions | **Rejected.** The effect did not hold. Kept as the SHADOW-1.1 measurement `POSITIONING_OPPOSED`. |
| **Refuse trades with net R:R below 1** (from F2) | Would skip 99% of indicator trades (228 of 231); skipped −0.042R, kept n = 3 | Skipped −0.006R (n = 134); kept −0.165R (n = 6). All trades: skipped −0.002, kept −0.074 | **Rejected.** It would remove almost every Old Indicator trade, and the few kept did no better. Kept as the SHADOW-1.1 measurement `NET_RR_FLOOR_1`. |
| **Portfolio caps** (F4; table below) | See §4 | See §4 | **Not enabled.** No cap improved net R per trade. They cut 63–94% of Old Indicator trades. |
| **Remove or retune any gate** (F5) | All 13 gates with 40+ graded refusals are INCONCLUSIVE on 15,595 decisions (24 days; production report after deploy, rule 1.1) | n/a | **Unchanged.** No gate is shown to filter worse decisions, and none is shown to refuse equally good ones. Removing one would be the same mistake as fitting it. |

**Signal quality, for the record (F1).** Over 15,353 intraday decisions (23 days), the direction call's hit rate is:

| Horizon | Hit rate | Signed move (ATR) [95% interval] |
|---|---|---|
| +30 min | 53.0% | +0.014 [−0.027, +0.069] |
| +60 min | 50.6% | −0.037 [−0.118, +0.084] |
| +120 min | 49.1% | −0.143 [−0.338, +0.132] |

No interval excludes zero. The only vote dimensions with a rank correlation above zero are:

- futures OI: ρ 0.10 [0.03, 0.17]
- options OI: ρ 0.09 [0.03, 0.14]
- IV: ρ 0.11 [0.01, 0.18]

## 4. Comparison against the existing system

The paper book since the 5 Oct architecture change is replayed under each portfolio limit already present in the
code: 460 closed trades, of which 371 are Old Indicator. Trades are taken as minted; a trade is skipped when the limit
would have refused it. All figures are net of each trade's estimated cost, in R. Intervals resample whole trading
days. Source: `pt3.json` export of `/api/paper-trades`, computed with `evaluation-core.ts`.

#### All, 5–14 Oct (8 trading days)

| Variant | Trades | Old Indicator trades kept | Win / loss / expired | Win rate (all trades) | Mean net R per trade [95%] | Total net R | Max drawdown (R) | Worst day (R) | Avg net win / avg net loss (R) |
|---|---|---|---|---|---|---|---|---|---|
| **Existing (no caps)** | 460 | 371 of 371 | 240/33/187 | 52.2% | −0.032 [−0.077, +0.016] | −14.75 | 22.37 | −7.79 | +0.33 / −1.11 |
| Same-direction cap 3 | 138 | 106 of 371 | 70/7/61 | 50.7% | −0.050 [−0.163, +0.065] | −6.84 | 11.38 | −4.83 | +0.34 / −1.15 |
| Max 5 open | 140 | 117 of 371 | 68/7/65 | 48.6% | −0.063 [−0.161, +0.050] | −8.81 | 11.10 | −5.99 | +0.28 / −1.09 |
| Daily loss stop 3R | 433 | 347 of 371 | 228/32/173 | 52.7% | −0.024 [−0.066, +0.021] | −10.30 | 18.01 | −4.67 | +0.34 / −1.11 |
| Full circuit breaker | 48 | 24 of 371 | 20/0/28 | 41.7% | −0.031 [−0.172, +0.106] | −1.50 | 4.81 | −2.59 | +0.37 / n/a |
| Old Indicator alone | 371 | 371 of 371 | 205/23/143 | 55.3% | −0.027 [−0.095, +0.038] | −10.15 | 15.88 | −7.12 | +0.29 / −1.09 |
| All other families | 89 | 0 of 371 | 35/10/44 | 39.3% | −0.052 [−0.136, +0.061] | −4.60 | 13.21 | −2.15 | +0.57 / −1.15 |

#### In-sample, 5–9 Oct (5 days)

| Variant | Trades | Old Indicator kept | Mean net R [95%] | Total net R | Max DD | Worst day |
|---|---|---|---|---|---|---|
| **Existing** | 284 | 231 of 231 | −0.046 [−0.102, +0.001] | −13.17 | 18.49 | −7.79 |
| Same-direction cap 3 | 74 | 55 | −0.071 [−0.218, +0.089] | −5.29 | 8.46 | −4.83 |
| Max 5 open | 81 | 67 | −0.114 [−0.218, −0.031] | −9.27 | 10.30 | −5.99 |
| Daily loss stop 3R | 262 | 211 | −0.034 [−0.079, +0.001] | −8.82 | 14.16 | −4.41 |
| Full circuit breaker | 30 | 16 | −0.116 [−0.281, +0.017] | −3.48 | 4.81 | −2.59 |

#### Out-of-sample, 12–14 Oct (3 days)

| Variant | Trades | Old Indicator kept | Mean net R [95%] | Total net R | Max DD | Worst day |
|---|---|---|---|---|---|---|
| **Existing** | 176 | 140 of 140 | −0.009 [−0.088, +0.103] | −1.58 | 7.05 | −4.77 |
| Same-direction cap 3 | 62 | 47 | −0.012 [−0.130, +0.115] | −0.76 | 3.38 | −2.72 |
| Max 5 open | 63 | 50 | −0.017 [−0.114, +0.223] | −1.09 | 3.38 | −2.86 |
| Daily loss stop 3R | 171 | 136 | −0.009 [−0.095, +0.103] | −1.48 | 7.05 | −4.67 |
| Full circuit breaker | 18 | 8 | +0.110 [−0.140, +0.259] | +1.98 | 1.50 | −0.84 |

**Reading:**

- **No variant changes net R per trade by more than its interval.** Every interval overlaps the existing system's, in-sample and out-of-sample. None is a profitability improvement.
- **The caps cut drawdown mostly by cutting volume.** The same-direction cap, max-open and full breaker remove 63–94% of Old Indicator trades. That conflicts with the requirement to keep its opportunities.
- **The daily loss stop is the only variant that keeps the Old Indicator's opportunities.** It keeps 94% of its trades. Over the whole period it lowers drawdown (22.4R → 18.0R) and the worst day (−7.8R → −4.7R), mostly because of 7 Oct. Out of sample it made no difference (−1.48R vs −1.58R). It is a tail-risk control, not an edge. It is listed below as a decision for the owner, not enabled.
- **The full breaker's +0.110 out of sample is 18 trades over 3 days.** Its interval spans −0.140 to +0.259, and in-sample the same rule was −0.116. Noise.
- **Other families are not worse than the Old Indicator** in a way the data can show: −0.052 vs −0.027, with overlapping intervals.
- **No strategy meets the "edge shown" bar.** A4 is the only demotion candidate on graded candidates: −0.253R [−0.408, −0.087], n = 274. It has already been in SHADOW since 8 Oct, with no paper trades after that date.

The structural reason is the same everywhere: average net win +0.29R against average net loss −1.09R. A win rate
near 53–55% cannot overcome that payoff ratio (break-even needs about 79% on closed trades), and 39% of Old Indicator
trades expire without reaching either level. This is audit F2. No filter tested here changes that shape. It needs a different stop/target construction,
tested first in shadow.

## 5. Validation run

| Check | Result |
|---|---|
| Server typecheck (`tsc --noEmit`) | clean |
| Web typecheck | clean |
| Server tests | 78 files, 1,311 passed, 0 failed |
| Web tests | 11 files, 82 passed, 0 failed (including 3 new Evidence-page tests) |
| `next build` | succeeded |
| ESLint, changed web files | no new findings. `api.ts` has 15 pre-existing `no-explicit-any` errors, identical on `main`. |
| Report reproduction | `evaluation-core.ts` run on production exports reproduces the audit's figures (direction hit 50.59% at +60 min; A4 −0.2533R; Old Indicator −0.027R) |

## 6. Not changed, and decisions for the owner

- **Trading logic.** Unchanged, as above.
- **MCX.** The Old Indicator keeps trading MCX as before.
  - The audit (F6) found MCX option costs about twice as high per unit of risk, and a weaker signal there.
  - Moving MCX indicator trades to shadow would remove opportunities, so it needs your explicit approval.
  - The Evidence page now splits MCX from index and stock results so you can judge it.
- **Daily loss stop (3R).** This is a tail-risk control that keeps 94% of Old Indicator trades. It is compiled off (`DAILY_RISK_BREAKER_ENABLED = false`, protected constant). Turning it on is your decision; it is not shown to raise profit.
- **A4.** No action needed. It has been in SHADOW since 8 Oct, and the scorecard now says so.
- **Order flow (F13).** It is down while `DHAN_ACCESS_TOKEN` is expired. Refresh the token in Railway.
- **Deploy.** Merging deploys migration 041, the archive service and the Evidence reports. Nothing else in production behaviour changes.

## 7. Limits of this evidence

- **Short windows.** The paper book since the 5 Oct change covers 8 trading days; the out-of-sample split has only 3. Intervals are wide, and a real effect of about 0.05R per trade could not be detected yet.
- **Paper fills.** Results are on simulated fills at mid with modelled costs. Real fills will be worse, not better.
- **No historical price archive before this change.** "Historical backtesting" here means replaying recorded decisions (23 days of snapshots). The bar archive is what makes longer backtests possible from now on.
