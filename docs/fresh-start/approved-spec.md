> Approval record: user approved implementation on 2026-10-30 ("approved hai"). The report below preserves the original reviewed proposal and audit wording. Implementation approval supersedes its proposed labels; paper activation, deployment and live execution are not approved by this record. Numeric choices remain hypotheses.

# Fresh-start terminal: Phase 1 audit and Phase 2 proposed specification

Date: 31 October 2026, IST
Input specification: Options_Buying_Fresh_Start_Master_Prompt.md, FRESH-START-SPEC-1.1.
Status: REVIEWABLE PROPOSAL — NOT APPROVED FOR IMPLEMENTATION OR ACTIVATION.
Scope executed: bounded read-only repository/platform investigation and specification. No application code, database rows, variables, deployments, trades or external notifications changed.

## 1. Executive verdict

The existing infrastructure is substantially reusable. A wholesale rewrite, another database or one worker per strategy is unnecessary on the evidence inspected. Strategy disablement, execution semantics and account risk must be resolved before any new paper entries are implemented/activated.

Critical findings:

1. **Legacy all-off status is not independently verified.** Deployed code defaults STRUCTURE, CONSENSUS_SETUPS, RESEARCH_PAPER_TRADING, OB1 paper and OF1 trading on. Railway's variable-name inventory contains no corresponding disable overrides. Deployment boot logs explicitly show research paper trading enabled. There is also a Redis manual risk-off switch whose current value was inaccessible; its coverage is not a universal guarantee across every entry/experiment path. Do not assert that all legacy strategies are disabled, nor assert that new trades are currently occurring: markets were closed and authenticated strategy/risk state was unavailable. A durable, universal new-entry veto with separate exit monitoring is the first proposed correction.
2. **The existing official paper ledger is not the proposed executable-quote engine.** Source documents official midpoint entry/LTP-triggered exits; the separate execution-observation ledger estimates ask entry and bid exit without replacing the official outcome. New strategy results must be based on their own executable-quote simulation, not an old midpoint outcome relabeled as realistic.
3. **Existing automated daily risk breaker is explicitly disabled.** It counts generated setups rather than a true filled-position account. The fresh-start account needs an independent filled-trade/capital ledger and atomic reservations. Do not simply turn that old breaker on.
4. **Historical option execution evidence is unverified.** Repository bar archives cover underlying research and the execution ledger covers observations of some paper positions; neither establishes full historical contract bid/ask coverage. Dhan documentation offers rolling-relative-strike options OHLC/IV/OI data, but rolling ATM series must not be treated as a fixed held contract across a trade. Bid/ask evidence, entitlements, field availability and dated instrument identity still need testing.
5. **Resource reuse is supported; exact spare capacity is not proved by average load.** Backend, Redis and PostgreSQL are each single replicas. One 24-hour metric window was inspected; it does not establish peak open-market headroom or billing limits. Rate-limiter queues inspected are not explicitly length-bounded.

No new strategy is proven profitable. Proposed numeric values below are initial hypotheses, deliberately explicit so they can be reviewed, frozen and tested. They are not claimed to be optimal or empirically validated.

## 2. Evidence and limits of the audit

### 2.1 Repository and deployment

- Repository: maknightriderr/Index-F-O-Terminal.
- Current fetched main: `ab9f8fdccfc34ef6eafbada1ef556c3ab414ba59`, merged PR #72.
- Local reviewed content matches fetched main's tree; local commit metadata differs because publication used the GitHub connector.
- Railway project/environment: fno-terminal / production; backend latest deployment `4cb98d48-fdee-4b9a-a7c9-c3b108b4c413`, SUCCESS.
- Public readiness returned commit `ab9f8fd`, ready/database/Redis/schema/brokerAuthenticated all true at this audit probe. This does not verify the authenticated full health report or strategy disablement.
- Protected `/api/diagnostics/summary` returned HTTP 401. No credentials requested, exposed or bypassed. No production SQL or Redis queries were run.
- This was targeted architecture/critical-path review, not a claim of exhaustive line-by-line code/security audit, complete production data inventory, or current strategy performance verification.

### 2.2 Railway topology and metrics

| Item | Observed evidence | Qualification |
|---|---|---|
| Backend | One replica, ams, GitHub main source, no mounted volume | Reuse existing service; instance count is not a concurrency guarantee |
| Redis | One replica, redis:8.2.9, 500 MB provisioned volume | Used/free space and persistence behavior not independently queried |
| PostgreSQL | One replica, PostgreSQL 18 image, 5,000 MB provisioned volume | Database contents, extension availability, retention and free space remain unverified |
| Backend memory | Last 24h sampled current ~0.886 GB, average ~1.564 GB, maximum ~2.488 GB | 15-minute sampling can miss short peaks |
| Backend CPU | Raw CPU_USAGE current ~0.0084, average ~0.0812, max ~0.1769 | Preserve provider measurement units; not a market-open stress test |
| Reported limits | CPU_LIMIT 8; MEMORY_LIMIT_GB 8 | Reported runtime limits, not subscription price or guaranteed dedicated capacity |
| Network | Per-sample RX/TX measurements available | Not summed into a monthly bill or claimed API counts |
| Pending infrastructure changes | None reported staged | No new infrastructure created |

`railway.json` declares Nixpacks, server dependency-inclusive build, readiness `/api/health/ready`, 180-second health window, ON_FAILURE restart with 10 attempts. Railway's service summary also exposes a RAILPACK base setting; reconcile effective repository-file precedence during implementation rather than changing builders as an incidental cleanup. Prior successful build logs used the repository build path.

### 2.3 Disablement evidence

- `apps/server/src/config/trading-flags.ts`: STRUCTURE_DEFAULT=true, CONSENSUS_SETUPS_DEFAULT=true, RESEARCH_PAPER_TRADING_DEFAULT=true.
- `apps/server/src/config/order-flow-flags.ts`: ORDER_BLOCK_MODE_DEFAULT=PAPER, OF1 defaults enabled/trading true.
- `apps/server/src/services/experiment-engine.ts`: arms and new entries default on; separate new-entry drain switch exists. Setting EXPERIMENT_ARMS off is not equivalent to safe draining because it stops the engine.
- `apps/server/src/services/risk-circuit-breaker.ts`: Redis `risk:manual_off` exists; automatic breaker flag false. Some call sites condition riskOffReason on that disabled automatic-breaker flag. Experiment admission must be reviewed independently.
- Current-deployment boot log at 2026-10-30T18:38:20Z (31 October 00:08 IST): research paper-trading enabled=true.
- Earlier ENTER logs fetched across service deployments predate PR #72 deployment. They are historical evidence only and were NOT used to claim trades after the user's disablement statement.

Outcome: **BLOCKED_VERIFICATION** on universal all-off. Desired state is clear; effective state is not established. No toggle changed in this phase.

## 3. Architecture/reuse map and requirement traceability

Existing paths below were located/reviewed as relevant integration points. Proposed paths are explicitly new, not existing files.

| Requirement | Existing module/evidence | Decision / proposed change |
|---|---|---|
| R-01 legacy separation | trading-flags.ts, order-flow-flags.ts, experiment-engine.ts, state-recovery.ts | REUSE_WITH_FIX: durable entry veto and separate namespaces; open plans untouched |
| R-02 honest results | strategy-validation.ts, paper_execution_observations migration 044 | REUSE_WITH_FIX: evidence class, filled-trade denominators, new account |
| R-03 boundaries | packages/analytics, AI boundary tests, io-tape.ts | VERIFIED_EXISTING mechanisms; add regression guards for new modules |
| R-04 audit/spec | This document and approval register | PROPOSED_NOT_APPROVED; data/platform limits remain visible |
| R-05 instruments/calendar | Angel provider instrument master; Dhan verified token mapper; shared utils; holiday-calendar-check.ts | REUSE_WITH_FIX: point-in-time contracts/calendar, not today's master alone |
| R-06/SRC data | providers/angel-one/index.ts, providers/dhan/quotes.ts, subscription-manager.ts, feed-freshness.ts | REUSE_WITH_FIX: explicit source epochs, conflicts and non-silent failover |
| R-07 timeframes | existing pure analytics and bar archive | REUSE_WITH_FIX: closed/available bar clock, shared 1m-to-5m/15m aggregation and same-slot RVOL |
| R-08/EVT regime/events | market-bias.ts, corporate-actions.ts | NEW_REQUIRED new deterministic regime; corporate-actions is not a complete event-clearance service |
| R-09 strategies | Legacy strategy implementations | NEW_REQUIRED isolated four-strategy module; no legacy decision reuse |
| R-10 parents | slot-arbitration.ts, mint locks | REUSE_WITH_FIX: new parent IDs and account-level no-double-entry guard |
| R-11 scoring | legacy confidence/quality components | NEW_REQUIRED score variant; disabled initially; no score probability claims |
| R-12/EXP contracts/IV | fno-validation.ts, option-chain.ts, pure analytics payoff | REUSE_WITH_FIX: capability-based expiry gates, scenario models and dated specs |
| R-13 fills | paper-execution-ledger.ts | REUSE_WITH_FIX: observations become input to an independent fill engine, never overwrite legacy official results |
| R-14/REF stops | pure trade setup and monitor | NEW_REQUIRED independent underlying/premium state; frozen initial risk |
| R-15 gaps/recovery | feed-gap-check.ts, state-recovery.ts, trade-setup-monitor.ts | REUSE_WITH_FIX: same-token watchers retained; unresolved fills not invented |
| R-16 account | risk-circuit-breaker.ts, calculatePositionSize | NEW_REQUIRED filled-account, capital reservations and premium cap |
| R-17 history | backtest/harness.ts, bar-archive.ts, io-tape.ts | REUSE_WITH_FIX adapters; BLOCKED_DATA for observed option execution history |
| R-18 statistics | strategy-validation.ts | NEW_REQUIRED independent-day uncertainty/experiment tracking |
| R-19 rollout/AI | auto-review-job.ts, auto-review-store.ts | REUSE_WITH_FIX new-source allowlist; no automatic risk/strategy edits |
| R-20 resources | shared subscriptions, rate-limiter.ts, request-priority.ts | REUSE_WITH_FIX queue limits/cancellation and bounded scanning |
| R-21 charts/UI | instrument-chart.tsx, chart-confirmation.ts, chart-zones.ts | REUSE_WITH_FIX explicit swing-vs-trade labels and new-source filters |
| R-22 tests | replay, golden, source boundary and browser suites | Add new requirement-mapped tests; preserve legacy fixtures |
| R-23 phases | No activation performed | OUT_OF_SCOPE until approval |
| R-24 output | This packet | Audit/spec proposal delivered; not implementation/validation completion |

No evidence was found that every requested feature is already implemented. No complete historical P&L/trade-count inventory was accessible.

## 4. Proposed new architecture and state contracts

Logical modules in the existing server, not separate microservices:

1. `new-strategies/config` — immutable approved pack loader, capability matrix and entry switch. Reads configuration outside analytics.
2. `new-strategies/market-context` — canonical contracts, approved source epochs, shared closed bars and mandatory-data status.
3. Pure analytics `new-intraday/{orb,vwap-pullback,sweep,first-pullback,regime}` — explicit inputs/time and deterministic candidate/refusal outputs.
4. `new-strategies/admission` — exact mandatory conditions, contract scenarios, parent arbitration and account reservation.
5. `new-strategies/paper-execution` — ask/bid eligibility, latency, partial/unfilled states, fee ledger.
6. `new-strategies/positions` — underlying invalidation, premium protection, time exits and durable recovery.
7. `new-strategies/research` — offline point-in-time replay, evidence classes, experiments and reports.
8. Read-only API/UI projections and audit events.

Proposed versions: new strategy IDs `NEW_ORB_RETEST_V1`, `NEW_VWAP_PULLBACK_V1`, `NEW_PREVIOUS_SESSION_SWEEP_V1`, `NEW_FIRST_OPENING_PULLBACK_V1`; parameter pack `NEW-INTRADAY-PROPOSAL-1`; source policy `NEW-SOURCE-PROPOSAL-1`; fill policy `NEW-QUOTE-FILL-PROPOSAL-1`. All PROPOSED_NOT_APPROVED, all enabled=false.

### State machines

Setup: OBSERVING → QUALIFIED → CONFIRMED → ADMISSION_PENDING → RESERVED → ENTRY_PENDING → FILLED / PARTIAL / CANCELLED / EXPIRED / REFUSED. A strategy close is not a fill.

Position: OPEN → EXIT_TRIGGERED → EXIT_PENDING → PARTIALLY_EXITED → CLOSED; any missing execution evidence can enter UNRESOLVED without silently becoming CLOSED. Monitoring continues.

Capability: DISABLED / BLOCKED_CONFIG / BLOCKED_DATA / SOURCE_CONFLICT / READY_SIGNAL_ONLY / READY_PAPER. No state implies live execution.

Restart: load open positions and risk reservations first, restore monitors, reconcile pending fills idempotently, then consider new entries only if the approved global entry switch and per-capability approval both pass.

## 5. Source authority and capability proposal

### Source policy

- Proposed signal OHLC/volume authority: Angel data on exact index futures for index strategies, actual stock equity for stocks, exact mapped futures for MCX. No cash-index volume VWAP.
- Index spot remains context/pricing input where the approved option model requires it; signal levels/stops remain on their futures reference. Freeze the reference contract for the setup/position. Do not compare a futures VWAP to spot to confirm an entry.
- Proposed executable option quote authority: complete eligible Angel SNAP_QUOTE on the exact contract. Current QUOTE_PROVIDER value was not read; an underlying adapter can currently route some REST quotes through Dhan. New policy must expose actual provenance and refuse unapproved routing rather than inherit that silently.
- Proposed Dhan secondary: monitoring-only until quote timestamp, contract mapping, book units and conflict tests qualify that capability. No automatic new-entry source fallback in the initial pack.
- Never combine primary bid with secondary ask or average conflicting books. No best-backtest quote selection.
- Proposed comparison gate, only after both quote-time semantics are verified: same canonical contract, event skew ≤1s, midpoint disagreement >max(2 ticks, 0.5% midpoint) sustained over 3 comparable observations = SOURCE_CONFLICT. These are unvalidated engineering proposals. A failed comparison blocks dependent entries; it is not automatically evidence one provider is wrong.
- Any source switch starts a new persisted epoch, cancels unfilled entries and requires setup revalidation plus complete current bars. Failback requires 60s stable observations and a completed setup-bar boundary. Open positions retain original references and use only mapped alternate monitoring, with unresolved gaps disclosed.

### Market matrix

| Market | Initial proposed eligibility | Mandatory blockers |
|---|---|---|
| NSE index options | New strategies specified; still disabled | Valid futures/option/spot mapping; quote-time/depth, event calendar and approved expiry policy |
| NSE stock options | New strategies specified; still disabled | Point-in-time F&O eligibility, issuer-event coverage, corporate actions and individual option liquidity |
| BSE verified options | Discovery/context only initially | Current listings/broker support, model/calendar/volume-reference verification; no presumed stock derivatives |
| MCX futures options | Discovery/context only initially | Exact futures link, option exercise/settlement/model, quantity multiplier/session/expiry verification |

The four strategies are generic pure algorithms; enabling BSE/MCX requires their separate capability-specific calendar, model and parameter approval. It is not silently inherited from NSE.

### Expiry proposal (R-12-EXP)

- Initial research/paper proposal: 0DTE OFF for every market; stock-option new entries also excluded on the final two exchange trading sessions through expiry.
- For NSE indices: eligible dated contracts with 1–10 exchange trading sessions remaining; for stocks: 3–15; evaluate at most two expiries, not automatically nearest.
- No BSE/MCX expiry bucket eligible until its product verification is complete.
- Last new entry 60 minutes before the verified session/contract cutoff; forced paper exit trigger 10 minutes before that cutoff. Final quote/fill may remain unresolved if unavailable; no fabricated timely fill or delivery.
- Use calendar DTE and remaining tradable seconds separately. Upcoming holiday/cutoff derives from approved calendar, not weekday arithmetic.
- All values above are proposed risk/research exclusions, not claims about exchange rules. Current exercise/settlement and broker restrictions remain NEEDS_VERIFICATION.

### Event proposal (R-08-EVT)

A mandatory verified scheduled-event clearance source is required for each enabled market. Propose index macro blackout 15m before/after a covered high-impact scheduled event, and stock issuer-result-day exclusion. Missing/incomplete source coverage gives BLOCKED_EVENT_DATA, not CLEAR. Corporate-action data alone is not an earnings/news calendar. Unscheduled-news risk cannot be declared eliminated. No paid source or external messaging authorized. These proposed windows require approval and provider-coverage tests.

## 6. Explicit shared research rules — all proposed, not active

Propose one minimal baseline rather than six simultaneous timeframe confirmations:

- 5-minute setup bars and closed 15-minute trend context. One-minute bars for aggregation/measurement; optional 1m execution timing is NOT a second entry strategy initially. No mandatory 3m/30m/200EMA/RSI/ADX gates.
- Every bar must be closed, received, valid, session-aligned and available before decision. No trade across a missing required bar. Maximum decision processing delay proposed 2s after bar receipt; mark late rather than backdate.
- ATR: Wilder ATR(14) on 5m; context ATR(14) on 15m; require 75 valid closed 15m bars and 100 closed 5m bars. ATR excludes synthetic missing-bar fills; calendar gaps are handled as actual previous-close true range, recorded.
- Proposed VWAP proxy: cumulative sum(HLC3 × traded volume)/sum(volume) of same-session closed 1m bars of the SIGNAL reference. Label BAR_VWAP_PROXY, not exact tick VWAP. Zero/missing cumulative volume blocks dependent candidates.
- Relative volume: current completed bar volume / median volume for the same elapsed-session slot in the prior 20 comparable sessions, at least 15 valid references. Sessions with altered schedules excluded from the comparable sample. RVOL missing does not become 1.
- Bull context: last completed 15m close > EMA20 > EMA50. Bear mirrors. Strong trend additionally requires EMA20–EMA50 separation ≥0.25 ATR15 and EMA20 change over 3 closed 15m bars ≥0.10 ATR15 in direction. EMA values are mathematical context, not win probabilities.
- Range context: no strong directional context and at least 2 sign changes around session VWAP in the latest 6 closed 5m bars. Otherwise unclear. S1/S2/S4 need directional context; S3 allows range or non-strong opposing context. Unknown mandatory data blocks.
- Candlestick body fraction = abs(close-open)/(high-low), with zero-range bars ineligible. Close location = (close-low)/(high-low); bearish mirrored.
- Confirmed swing uses 2 closed bars each side. A pivot is available only on the second right bar's close/receipt, never at its historical origin.
- Target: nearest strictly ahead, direction-appropriate pre-existing opposing level from previous-session high/low, completed OR boundary and confirmed swing levels; S3 also includes previous-session midpoint. Ties deduplicated within one tick. If no ahead level exists, NO_TARGET. Never skip a near obstacle merely to obtain larger payoff.
- Entry uses the first eligible ask after a proposed 250ms simulation latency following confirmation receipt, within 2s. Underlying must not be invalidated and extension from confirmation close must be ≤0.25 ATR5 in direction. If no eligible quote arrives, UNFILLED/EXPIRED, never a close-price fill.
- Maximum one selected entry per parent move, one open new-strategy position per underlying. Parent epoch = instrument/session/direction/confirmed move origin; origin freezes when first candidate qualifies, siblings share it. A parent ends on its structural invalidation, target completion or session end; losing a trade alone does not create a fresh parent. Re-entry requires a new approved parent and ≥3 completed 5m bars since closure; maximum two entries per underlying/session.
- Simultaneous candidates: earliest confirmation-availability timestamp, then highest worst-case modeled net reward/risk, then earliest parent origin, then stable strategy ID. No heuristic entry score gate initially. Record all losing arbitration candidates.
- Net payoff proposal: reject below 1.5 after explicit cost/slippage and stress scenario; use unchanged stop/target. This is a NEW explicit proposal, not inheritance of RISK-3.0 and not evidence 1.5 is optimal. Research only one prespecified no-floor comparison; do not enable that variant for paper automatically.

## 7. Four deterministic strategy proposals

The bearish case mirrors PRICE logic; both calls and puts remain bought options. ATR and buffers freeze at setup confirmation unless explicitly stated. Invalidating before fill cancels entry.

### NEW_ORB_RETEST_V1

- Opening range = first three complete 5m bars after verified product session open. All three mandatory. OR width between 0.5 and 3.0 ATR5 at range completion.
- Entry window: OR completion until session open+120m, also respecting global entry cutoff.
- Bull: directional bull context; completed 5m close > ORH+0.05ATR5, body fraction ≥0.60, close location ≥0.75, RVOL≥1.5, close above aligned VWAP.
- Retest required within next 3 complete 5m bars: bar low within ORH±0.15ATR5, close >ORH, body fraction ≥0.50, bullish close and close location≥0.70. First qualifying retest confirms; breakout without retest is not chased.
- Invalidation = minimum low of all bars from first retest interaction through confirming retest minus 0.10ATR5. Any intervening completed close <ORH−0.15ATR5 expires the setup.
- Target = shared nearest-ahead rule; quote/scenario/sizing gates apply. Buy at next eligible ask, not at the historic breakout.

### NEW_VWAP_PULLBACK_V1

- Entry window open+30m through last-entry cutoff. Require directional 15m context and signal reference above VWAP (bull).
- Impulse reference = 3 complete 5m bars immediately preceding pullback start, with positive net move≥0.75ATR5 and final close above prior confirmed swing high. Require RVOL of at least one impulse bar≥1.2.
- Pullback starts at first later candle closing below its prior close; lasts 2–5 bars. Must approach VWAP within 0.20ATR5, retrace no more than 60% of impulse close-to-start distance, and preserve most recent confirmed bullish swing low.
- Median pullback volume <0.8×median of the three impulse bars. Two consecutive closes below VWAP invalidate.
- First bullish completed candle closing above preceding bar high AND VWAP, body fraction≥0.50, confirms after at least two pullback bars. No trigger by the fifth bar = expired.
- Underlying invalidation = minimum pullback/confirmation low−0.10ATR5. Target/shared admission unchanged.
- S2 candidates sharing an S4/ORB origin use the same parent and cannot stack exposure.

### NEW_PREVIOUS_SESSION_SWEEP_V1

- Initial level universe only previous completed regular-session high/low, not arbitrary supports. Missing reliable previous session blocks.
- Window open+30m through entry cutoff; range context or no strong opposing trend. Strong opposite trend blocks reversal entry.
- Bull: low breaches PDL by 0.05–0.75ATR5. A complete close back above PDL must occur within the sweep bar or next two bars. Reclaim close location≥0.70 and RVOL≥1.2.
- Within next two closed bars, first bullish close above reclaim-bar high with body fraction≥0.50 confirms. New lower extreme before confirmation resets/cancels that candidate, not silently widens its stop.
- Invalidation = recorded sweep extreme−0.10ATR5; target shared rule including previous-session midpoint. No positive room/net payoff = refusal.
- Bear mirrors PDH breach/reclaim and close below reclaim-bar low. Wick alone cannot confirm.

### NEW_FIRST_OPENING_PULLBACK_V1

- First impulse = first three complete 5m session bars. Bull net move from first open to third close≥1.5ATR5 measured at impulse completion; third close in upper 20% of impulse range, above VWAP; aggregate volume≥1.5×median equivalent first-15m volume over the reference sessions; bull context required.
- First pullback starts with the first subsequent close below prior close. Allow 1–3 bars, retracement between 20% and 50% of impulse open-to-close distance, median pullback volume<0.8×median impulse-bar volume. A retracement above 50% invalidates the FIRST-pullback opportunity for the session.
- First bullish candle closing above previous bar high, above VWAP and body fraction≥0.50 confirms. Entry deadline session open+120m plus global cutoff.
- Underlying invalidation = pullback/confirmation low−0.10ATR5. Target/shared admission unchanged.
- At most one S4 attempt per instrument/session. No second/third pullback relabeled as first.

These are complete initial hypotheses for discussion, not documented profitable rules from a cited trader. Every threshold is included in the proposed pack and cannot silently change after results are seen.

## 8. Contract, model and execution proposal

### Contract shortlist

- Long CE for bull, long PE for bear; |delta| 0.45–0.65; rank at most 5 strikes across at most 2 eligible expiries per candidate.
- Both bid/ask positive, not crossed, quote observation age≤2s with a verified quote-event/availability timestamp; stale last-trade time is not necessarily quote age. If only receipt/LTT is available, timestamp qualification remains blocked rather than pretending quote age is known.
- Spread≤1.0% midpoint for indices, ≤1.5% for stocks; displayed executable depth must cover admitted quantity. Unknown units/depth blocks this initial strict paper variant. These limits are unvalidated proposals and can materially reduce fills.
- Reuse pure IV/Greeks calculations only after model/unit tests. For European-style NSE contracts, propose a European model with correct spot/forward/dividend/carry inputs, subject to exercise-style verification. No model applies to MCX by assumption. Missing necessary inputs blocks model-based admission.
- Index signal can use futures, but option pricing must use the verified model reference; record spot/futures basis and assumed scenario translation. Unverified basis mapping blocks scenario admission.
- Time to objective scenario = 15m, capped by remaining trade time; stress IV by −2 volatility percentage points as an explicit adverse scenario as well as unchanged IV. Compare model-repriced target vs modeled invalidation/premium emergency risk after costs; use the lower scenario payoff, not a guaranteed prediction.
- No live IV-rank gate until comparable historical IV availability verified. Current model IV/Greeks mandatory; IV rank/breadth optional research observations.

### Fills and fees

- Entry: eligible ask observed after simulation arrival, plus one option tick adverse slippage. Initial strict variant requires full size at displayed ask depth; otherwise do not fill. Partial-fill support is specified for later bounded execution variants, not silently assumed implemented.
- Market exit: eligible bid after trigger+250ms, minus one tick adverse slippage floored at zero. No quote means EXIT_PENDING/UNRESOLVED and monitoring continues.
- Target: underlying objective triggers a market exit in this baseline; it is NOT a guaranteed premium limit target. Report both underlying objective and scenario premium estimate separately. The bid-side fill determines actual net paper result.
- Actual ask/bid embeds spread. Explicit costs are effective-dated broker/exchange/statutory fees plus declared nonembedded slippage; never deduct spread twice. Fee schedules/contract multipliers need verified fixtures before activation.
- Gaps cross triggers at observed times; fills use subsequent executable evidence, never forced stop prices. Intrabar ambiguous historical target/invalidation → no invented sequence; conservative bounds and coverage flags.

## 9. R, stops, exits and account proposal

- Baseline exits only: underlying invalidation, underlying target, premium emergency stop, no-progress time exit, max-duration exit and session deadline. Trailing research methods are separate variants, not all-on filters.
- Proposed premium emergency level: 25% below quantity-weighted ask/slippage entry fill, tick-rounded up toward entry for protective conservatism. This is a risk policy hypothesis, not a replacement for structural invalidation. Initial paper approval must explicitly accept or replace it.
- Initial planned per-unit risk = maximum of modeled loss at underlying invalidation under approved stress and entry-to-premium-emergency loss, plus nonembedded costs. Record model risk vs total premium-at-risk separately. Freeze initial R at fill. Unknown model/fees blocks sizing. A gap can exceed R; maximum premium/capital cap remains independent.
- Current exit mark/high-water = eligible size-aware bid, never ask/LTP. Missing depth makes high-water unavailable rather than backfilled favorably.
- No trail enabled in baseline. Proposed comparison: at +1R net liquidation value move premium stop to fee-adjusted breakeven; at +2R lock +1R net. Activation and stop formula use frozen initial currency R; trigger at eligible bid crossing level. Never lower premium stops for bought CE or PE. Target/time deadline can exit before trail activation.
- Separate ATR variant needs actual option-premium ATR(14) candles; unavailable data blocks that variant only. Underlying swing trail follows confirmed 2-right-bar pivots in correct underlying direction. Hybrid requires separate approval.
- No-progress proposal: after 3 complete 5m bars since fill, if maximum favorable underlying excursion<0.25 initial underlying risk distance AND current underlying move is adverse, trigger market exit. Maximum hold 12 complete 5m bars (60m), always bounded by session deadline.
- Event ordering: earliest observable event wins; session deadline is a forced trigger. Exact simultaneous stop/target tie chooses protective exit. Once EXIT_TRIGGERED, no second exit order; fills idempotent. Stop/gap risk is never capped by accounting fiction.
- Capital must be user-configured; no assumed ₹5L. Proposed planned risk 0.25% capital/trade, gross premium outlay≤5% capital/trade, daily net-loss ceiling 1%, two open positions, one correlated risk-group position, pause after three net losses for remainder of session.
- Daily loss includes realized and conservative executable-mark unrealized net P&L, estimated liquidation fees and pending reservations. If required position mark is unavailable, freeze new risk; do not value it as zero loss. Initial session capital freezes; daily reset follows approved exchange-account trading-day convention and never merely process restart.
- Lots=min(risk budget capacity,premium affordability,exposure capacity,contract quantity capacity). Units=lots×verified lot quantity×price-unit multiplier only once. Zero lots=NO_TRADE.
- Reserve capital/risk transactionally before entry. Release unfilled reservations on explicit expiry/cancellation. Same underlying parent and correlated index/sector group cannot independently spend the same capital.
- Reaching daily limits cancels unfilled entries and blocks new risk. Existing positions retain approved exit plans; no arbitrary liquidation or legacy reactivation.

## 10. Proposed persistence, API and UI contracts

Proposed additive tables in a new research namespace (not yet created):

- `new_strategy_packs`: immutable pack JSON/hash, approval status, version, approval identity/time; no pack executable before APPROVED.
- `new_strategy_candidates`: setup/parent IDs, strategy/pack/reference/source epoch, event/availability time, condition bits, rejected reason, evidence class, snapshot hashes.
- `new_paper_orders`: idempotency key, candidate, arrival/expiry, reserved quantity/capital, requested contract, fill/cancel state.
- `new_paper_fills`: order/event sequence, exact source quote reference, side/quantity/price, timestamps, explicit fees and slippage version.
- `new_paper_positions`: position ID, stable contract/underlying reference, original plan/initial R, current stop, remaining quantity, high-water and exit state.
- `new_paper_accounts`/`new_risk_reservations`: session equity, reservations, daily drawdown/pause state and transactional concurrency.
- `new_strategy_audit`: append-only transition/event evidence with version IDs; `new_strategy_runs`: dataset/experiment/holdout registry.

Unique order key=(candidate,pack,entry-attempt); fills unique=(order,fill-sequence). Active-underlying and parent exclusivity enforced by transactional admission/partial unique indices, including residual legacy-position exclusion. DB remains source of truth; Redis mirrors bounded working state and is rebuilt without re-enabling entries. Migration idempotency, size/retention and approved rollback must be tested before deployment.

Proposed API: GET new-strategy status/capabilities/candidates/positions/performance/audit; all cached/read-only. Separate authenticated POST for future approved paper activation/pause; no GET may run decisions or mint trades. No real-order endpoints. No API/auth/session extension introduced merely to bypass the present 401.

Proposed UI: legacy OFF/verification-needed status, exact new pack approval, BLOCKED_DATA reasons, source reference/epoch, option ask/bid vs modeled fields, zero-lot NO_TRADE, currency vs R evidence, and counts with actual population/coverage. “Swing confirmed” means chart observation, never trade/target confirmation. New actual fill markers distinct from candidate/swing/exit markers; current relevant labels default, history toggle. Underlying chart never shows premium stops on the same axis.

## 11. Research and statistical proposal

Evidence classes: underlying signal study; modeled contract scenario; observed option OHLC study with intrabar bounds; executable-quote paper simulation; actual broker fills remain out of scope. Do not pool them.

Do not preselect dates that the data cannot support. After coverage inventory, freeze chronological earliest 60% development, next 20% validation, last 20% untouched holdout by sessions with fixed boundaries. Freeze all four rule packs before holdout, track every attempted variation. Dates and coverage need approval, not backfilled optimistic assumptions.

Initial experiment budget proposal: mandatory-rule baseline; one frozen score variant using original proposed weights; one no-payoff-floor research-only variant; exit comparisons on the same eligible entries. Do not independently cross every strike/expiry/regime/timeframe/parameter choice. Freeze the set before testing; reserve additional new data for changes after holdout inspection.

Report total candidates, valid signals, covered/eligible entries, unfilled, filled, completed, open, unresolved and each exclusion. Win=net P&L>0; all completed filled exits count, including forced/time exits. Flat tolerance=one minor currency unit after final account rounding, separately reported. Quantity-weight partial positions by actual fills; never count each partial exit as a new trade.

Proposed minimum evaluation gate: ≥200 completed filled trades AND ≥60 independent sessions per strategy, positive mean net R with day-block-bootstrap 95% lower confidence bound>0, net PF≥1.2, max marked-equity drawdown≤5% configured capital, and declared quote/contract/cost coverage. These are initial research selection criteria, not a promise of statistical power; feasibility/power must be assessed from actual dependence and coverage. Thin market slices remain inconclusive.

70% is secondary: observed rate≥70% reports point estimate+interval, not validated accuracy. For a claim of at least 70%, require predeclared dependence-aware confidence procedure with lower bound≥70% and sufficient independent evidence; do not choose the procedure after results. Trading approval also needs profitability, drawdown, execution coverage and paper evidence; high win rate alone fails.

Forward paper proposal after historical acceptance: at least 30 fresh sessions and 100 completed covered trades per strategy, ongoing operational/coverage checks; no auto-promotion on a numerical gate alone. If observed executable historical data is unavailable, report that acceptance route blocked; signal/model research may proceed but cannot be advertised as observed option profitability.

Rolling relative-ATM history requires exact strike/expiry tracking: once a trade enters, its contract is fixed. If rolling history lacks that contract's subsequent path, exit is UNOBSERVED, not a switch into whichever option is now ATM. Request no paid feed/download until coverage and authorization are settled.

## 12. Broker documentation verification

Read on 31 October 2026:

1. Dhan introduction: https://dhanhq.co/docs/v2/ — documents separate data/quote categories and rate limits. Inspected page currently lists data 5 requests/s, quotes 1 request/s. This is documentation, not verified account entitlement or permission to increase usage.
2. Dhan live market feed: https://dhanhq.co/docs/v2/live-market-feed/ — describes up to five connections with 5,000 instruments each, request batch maximum 100, and full packets containing market depth. Proposed system uses existing necessary connections, not the maximum.
3. Dhan expired options: https://dhanhq.co/docs/v2/expired-options-data/ — documents rolling relative-strike historical OHLC/IV/OI/spot; not a historical executable bid/ask guarantee. Account coverage and exact dated contracts remain untested.
4. Dhan historical candles: https://dhanhq.co/docs/v2/historical-data/ — documents minute-history capabilities. Actual entitlement/request coverage not sampled.
5. Dhan option chain: https://dhanhq.co/docs/v2/option-chain/ — located; adapter/field-specific semantic verification remains pending.
6. Angel SmartAPI docs: https://smartapi.angelone.in/docs — access response said unauthorized; current numeric limits remain NEEDS_VERIFICATION. Repository comments are not a substitute for current official API documentation.

No authenticated broker data downloads or order APIs were called. Exchange calendars, exercise/settlement and charge schedules are not verified by these broker page reads; those remain separate blockers.

## 13. Resource/queue proposal and current gaps

Reuse one backend, shared Angel subscription manager, existing Dhan feed where appropriate, existing Redis/PostgreSQL and pure analytics. Avoid new services. Reuse request prioritization but add explicit queue length, cancellation/deadline and per-workload concurrency controls; the current token bucket limits request rate, not outstanding queued memory.

Proposed initial engineering limits for review: scanner candidate queue 100, scanner 2 in-flight batches, option-analysis queue 20 with 2 concurrent builds, history 1 background request at a time, shortlist ≤20 underlyings and 5 strikes×2 expiries per actual qualifying candidate. New subscriptions budget=min(approved broker capacity,250) after reserving all existing position/pending-order dependencies. Never evict active risk watches to fit the shortlist. Angel numeric broker capacity is unresolved, so this does not authorize 250 subscriptions yet.

Discovery cadence 5m, shortlisted evaluation on completed 5m events, active positions on eligible shared streaming observations with bounded monitoring fallback. Do not poll whole option chains for each strategy every tick. Cache instrument master by validated version/day, not repeated dashboard demand. No heavy research job during live risk workloads on the current worker. Proposed UI current screen poll≥30s unless shared socket events suffice; historical pages paginated.

Use observed peak memory plus margin for load tests; no arbitrary Node heap change now. Test monitoring latency under scanner/history saturation, source outage and restart. Resource targets/alerts need baseline measurements before hard budgets. Backend 8 GB runtime limit and observed ~2.49 GB sampled peak do not prove the new workload is safe.

On-demand report initially: actual API counters, active subscription registry, queue depth, duplicate requests prevented, data latency and storage growth. Historical counts, database free space, exact account quota/billing and instrument-date coverage currently NOT_AVAILABLE. No fabricated daily/weekly totals or scheduled notification job.

## 14. Implementation sequence after concrete approval

P0 — Establish/verify safe legacy NEW-entry veto without disabling residual exit monitoring; include every normal, background, experiment and restart path. Existing manual-off state must be inspected through authorized read-only access or tested interfaces; a shadow/disabled counter is not a global veto.

P1 — New immutable pack/capability validation, canonical contracts/source epochs, closed-bar availability and mandatory-data refusal. All new enabled flags remain false.

P2 — Pure four-strategy/context functions and fixtures; parent arbitration, versions and source/reference tests. No database/network inside analytics.

P3 — Independent paper account, transactional reservations, executable ask/bid fills, fee ledger, exact references/stops and restart recovery.

P4 — Read-only projections, chart semantics and separate new-source performance; migrate idempotently with rollback.

P5 — Data coverage inventory/small authorized samples, predeclared research protocol, offline experiments. No claim of historical execution fidelity without evidence.

P6 — Explicitly approved forward paper activation by market/pack only, with monitoring/rollback and independent review.

No step is implemented by this document. No legacy strategy is substituted for an incomplete new module. No P0 infrastructure/config mutation occurred in this audit phase.

## 15. Requirement-to-test plan

| Test ID | Requirements | Required assertion |
|---|---|---|
| T-ENTRY-VETO | R-01/R-19/R-22 | Legacy defaults, manual-off, experiments, timers and restarts cannot bypass new-entry veto; old exits still run |
| T-TIME | R-06/R-07 | Decision sees only closed/received bars, session alignment and known pivots; missing bars do not confirm |
| T-SOURCE | R-06-SRC | Exact contract/units, source epoch, stale/conflicting books, no mixed bid/ask, controlled failback |
| T-EXPIRY | R-05/R-12-EXP | 0DTE/excluded windows fail closed; verified calendars/cutoffs; no fabricated expiry fill |
| T-STRATEGY-1..4 | R-08/R-09 | Every boolean condition and boundary, mirrored CE/PE, first-pullback identity, invalidation and time expiry |
| T-PARENT | R-10 | Same move across strategies/strikes/expiries cannot stack exposure or duplicate entry under concurrent requests |
| T-MODEL | R-12 | Correct reference/model, percentage-point vega/theta/time units, adverse IV and premium scenarios |
| T-FILL | R-13 | Ask entry/bid exit after latency, depth/size/unknown age, no LTP substitution, explicit fees without spread duplication |
| T-RISK | R-14/R-16 | Frozen initial R, zero-lot refusal, currency/multipliers, atomic reservation and full premium vs stop risk |
| T-TRAIL | R-14-REF | Bought CE/PE premium direction; underlying PE stop differs; bid high-water; monotonic durable levels |
| T-EXIT | R-15 | Gaps/ties/cutoffs/event ordering, unresolved execution, no second fill or forced favorable prices |
| T-RESTART | R-01/R-15 | Existing plans/tokens/risk reservations recovered; no old entry reactivation; shared-token watches preserved |
| T-REPLAY | R-17/R-18 | Accepted AND refused full paths deterministic from stored tape with no real IO; fixed held contract |
| T-STAT | R-18 | All completed exits in denominator, flats/missing/unfilled separate, day dependence and version isolation |
| T-UI | R-21 | Swing observation != actual entry, IST/reference axes, blocked reasons, currency/evidence coverage, mobile/accessibility |
| T-RESOURCE | R-20 | Queue bounds, cancellation, backoff, reserved monitoring, no duplicated subscriptions/scanners |
| T-BOUNDARY | R-03/R-19 | Analytics pure, learning isolation intact, AI cannot edit policies, no broker order side effects |

New tests and strategies have NOT run because implementation has not started. Prior PR #72 validation is historical evidence for existing code, not a test report for these proposed modules.

## 16. Approval register and limitations

| ID | Concrete proposed decision | Status / impact |
|---|---|---|
| A0 | P0 safe universal legacy-entry veto with old exit drain retained | NEEDS_APPROVAL to change code/config; current all-off verification critical |
| A1 | Four exact rules and shared numeric pack in sections 6–7 | PROPOSED_NOT_APPROVED; new entries disabled |
| A2 | Angel authoritative signal/quote policy, monitoring-only qualified Dhan secondary | PROPOSED_NOT_APPROVED; live routing/time semantics need verification |
| A3 | Initial NSE scope; 0DTE excluded, stock final-two-session exclusion, BSE/MCX discovery only | PROPOSED_NOT_APPROVED; official product rules still needed |
| A4 | Scheduled event windows and mandatory per-market coverage | PROPOSED_NOT_APPROVED + BLOCKED_DATA until source qualified |
| A5 | Exact ask/bid, 250ms latency, one-tick adverse slippage, 2s age, strict depth | PROPOSED_NOT_APPROVED; quote timestamp/depth units must qualify |
| A6 | Initial risk, 25% emergency stop, 5% premium cap, 0.25% planned risk, 1% daily limit, 2 positions/1 correlation group | PROPOSED_NOT_APPROVED; configured capital mandatory |
| A7 | Target selection, 1.5 stressed net payoff, no-progress/max-time exits, no baseline trail | PROPOSED_NOT_APPROVED; high trade rejection possible |
| A8 | Optional trailing/score comparisons and research-only no-floor variant | PROPOSED_NOT_APPROVED; no automatic paper activation |
| A9 | Dataset inventory, split and evidence/statistical thresholds | PROPOSED_NOT_APPROVED + BLOCKED_DATA for executable historical tests |
| A10 | Additive persistence/API/UI plan, queue/resource proposals and rollback | PROPOSED_NOT_APPROVED; no new services required on present evidence |

Outstanding verified-access limitations: no authenticated strategy/risk/current-position report, no production SQL/Redis data inventory, no historical bid/ask entitlement sample, Angel official numeric limits inaccessible, no current complete exchange settlement/charge/calendar verification, no complete event-risk feed, no production load test. These do not justify inventing data or asserting implementation ready.

## 17. Rollback and next action

Next authorized action is review of this concrete proposed specification. Implementation requires approval of the rule/risk/source/expiry pack and P0 corrections, as required by the supplied master prompt. Approval to implement still does not enable strategies, place real orders, purchase data or deploy without the appropriate scoped instruction.

Rollback of a future new-paper rollout: veto NEW entries, cancel unfilled simulations idempotently, retain old/new open-position monitoring and original plans, preserve evidence/capital counters, do not reactivate legacy entries. Reverting binaries must retain readers for outstanding position versions until drained.

This packet records a fresh-start design, not a profitability result, compliance certification, production-disablement confirmation or completed implementation.
