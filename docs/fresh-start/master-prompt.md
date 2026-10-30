# MASTER PROMPT — Fresh-Start Intraday Single-Leg Options Buying Research System

Version: FRESH-START-SPEC-1.1
Prepared: 31 October 2026
Scope: Indian index, stock and commodity options; SIGNAL_ONLY and PAPER_TRADING only.

## HARD RULES — read first

1. Fresh strategy start: legacy NEW entries stay disabled; preserve evidence and monitor residual open paper positions.
2. Work only in the connected remote workspace; do not install software or change files/configuration on my local machine.
3. Single-leg CE/PE buying only; SIGNAL_ONLY/PAPER_TRADING only; no real-order implementation or submission.
4. Start with read-only Phase 1 and proposed Phase 2 specification only; no code, deployment or activation yet.
5. Four unproven research strategies; 70% net-win rate is an aspiration, never a promised outcome.
6. Protect analytics purity and learning isolation; AI cannot change trading/risk rules automatically.
7. No fabricated data, fills, probabilities, usage metrics or retrospective improvements to results.
8. Resolve source authority, expiry permissions and stop references explicitly before affected implementation.
9. Unapproved or null critical parameters keep affected execution disabled; partial approval never enables everything.
10. Detailed requirements below remain authoritative. Report a real conflict; do not use this summary to bypass them.

## 1. [R-01] Mandate and starting state

Act as a trading-system researcher, quantitative reviewer and software engineer working on my existing terminal. I buy single-leg calls and puts. Do not substitute option selling, spreads, short straddles/strangles or futures execution for this mandate.

I report that ALL existing strategies have been disabled. Treat this as the desired state and verify it read-only during the audit; do not claim independent verification before checking. This is a fresh start for strategy research, not permission to rewrite the entire application.

- Keep every legacy strategy disabled for NEW entries.
- Never silently reactivate Old Indicator, S1, A2–F3, OB1, OF1, experiment arms or any other old entry engine.
- Preserve historical trades, decisions, research evidence, configurations and audit logs. Do not delete, relabel or improve old results retrospectively.
- Do not copy legacy strategy decisions into new strategy results. Reuse infrastructure and verified calculations where appropriate; reuse a legacy trading rule only if explicitly included in the approved new specification.
- Give new strategies, risk policies, datasets and parameter packs independent immutable version identifiers and separate reporting cohorts.
- Inspect startup, scheduled jobs, Redis recovery, scanners and experiment workers for any path that could resurrect disabled legacy entries.
- If any old paper position remains open, keep its original monitoring and exit plan operational unless I explicitly authorize its retirement. Disabling new entries must not orphan an existing position. Never change its entry, initial risk, target or historical outcome to fit the new policy.
- No code, deployment, infrastructure mutation, broker order or data deletion is authorized by this prompt's initial phase. Start with Phase 1 and Phase 2 only.

## 2. [R-02] Objectives and honest performance claims

Research objectives:

1. Positive net expectancy after realistic execution costs.
2. Controlled drawdown and exposure.
3. Reproducible behavior under chronological out-of-sample testing.
4. Reliable data, fills, monitoring and exits.
5. A research aspiration of at least 70% net-profitable completed trades, without optimizing only for win rate.
6. Low unnecessary API, infrastructure and implementation complexity.

The 70% aspiration is NOT a promise, an activation threshold by itself or evidence that these four strategies have an edge. A valid outcome is that none qualifies. Do not invent performance, target-hit probabilities or profitable parameters to satisfy this objective.

A high win rate with larger losses and small wins is unacceptable when net expectancy is non-positive. Correctness tests, passing builds and successful deployment do not prove profitability. “Institutional-grade” is not an acceptance criterion.

## 3. [R-03] Development boundaries

- Reuse the actual repository architecture unless measurements justify changes.
- Keep `packages/analytics` pure: no network, database, cache, environment reads, mutable external state or wall-clock dependencies. Pass inputs and time explicitly.
- Preserve the existing learning isolation boundary. AI may explain saved evidence and propose experiments, but cannot select trades, change parameters, promote strategies, bypass refusals or modify risk automatically.
- All work happens in the connected remote workspace; my local machine remains untouched. Do not install software on my local computer. Do not install Railway CLI or other local tooling. Use available connected services and the remote workspace. Report unavailable capabilities.
- Do not weaken tests or regenerate historical golden outputs merely to make new logic pass. Add version-specific tests when behavior changes intentionally and explain the change.
- Do not create new broker connections, Railway services, databases, scheduled jobs or external messaging integrations without a justified, reviewable proposal and authorization.
- Do not send Telegram, email or other external messages unless separately authorized. Audit/UI reporting is sufficient initially.
- Proposals are not approved rules. Label every unapproved trading parameter `PROPOSED_NOT_APPROVED` and keep execution disabled.
- Do not block unrelated read-only audit work because one market/data source is unavailable. Block the affected strategy/market capability and state its exact dependency.

## 4. [R-04] Work allowed now: Phase 1 and Phase 2

### Phase 1 — Read-only audit

Inspect the actual repository, configuration, deployment, database schema and available broker integrations without changing them.

Deliver:

- Architecture and requirement-to-module map with actual file/service references.
- Actual legacy strategy enablement status, startup/recovery paths and residual open-position handling.
- Reusable modules, verified defects, incomplete features and duplication.
- Actual broker feed connections, subscription registry, credentials-presence status without revealing secrets, API scheduling and rate-limit handling.
- Existing Redis/PostgreSQL roles, data retention and restart behavior.
- Current Railway capacity and available resource telemetry, without guessing plan limits or prices.
- Historical underlying AND individual option-contract data availability, timestamp resolution, bid/ask coverage and contract metadata coverage.
- Capability matrix per market: SUPPORTED, PARTIAL, UNAVAILABLE, NEEDS_CONFIGURATION or NEEDS_APPROVAL.
- A distinction between verified facts, user-reported state, assumptions and unknowns.

Do not run heavy research jobs against production during this audit.

### Phase 2 — Complete technical and trading specification

Produce explicit decision tables, parameter schemas, formulas, state machines, pseudocode, data contracts, API/schema changes if needed, tests, rollback plan and bounded resource estimates.

For every strategy, resolve every subjective phrase into measurable rules. Propose sensible initial research values with reasoning, but do not represent invented values as book rules, validated rules or approved defaults. Use credible primary documentation for broker/exchange facts. If inaccessible, record NEEDS_VERIFICATION rather than guess.

Conclude with a concise approval matrix containing the exact proposed rule pack, unresolved critical ambiguities, reuse/change list and validation plan. Stop before code changes. My approval of a particular spec authorizes that spec's next phase, not unrelated strategy changes or real-money execution.

## 5. [R-05] Market coverage and eligibility

Support capability-based discovery of:

- NSE index options with verified active contracts.
- Eligible NSE stock options.
- BSE index/stock derivatives only where current listings, contract data and broker support are verified.
- MCX options mapped to their exact relevant commodity futures contracts.

A named index or commodity is not proof that an eligible option is currently listed or supported. Never manufacture instruments or assume historical/current specifications are identical.

Record exchange, instrument type, underlying/reference instrument, contract expiry, exercise/settlement properties, strike, CE/PE, token, lot quantity, tick size, any price-unit multiplier, status, session and applicable quantity limits. Validate official/broker sources and effective dates. Maintain a point-in-time historical instrument universe for backtests; using today's surviving instruments alone is insufficient.

Store events as UTC epoch/UTC timestamps. Display IST explicitly. Use exchange calendars and session-aware bar alignment, holidays, special sessions, breaks and contract-specific restrictions. Do not infer a tradable session from weekday alone. Define previous session and opening range separately for each exchange/product.

## 6. [R-06] Price references, volume and data lineage

Assign a documented role to every series:

- Index spot may supply price context. Do not assume a cash-index series has directly traded volume or a meaningful volume-weighted VWAP.
- When index volume/VWAP uses a futures proxy, identify the exact futures contract and explain its basis, expiry/roll handling, session alignment and historical availability.
- Stock spot price/volume may supply stock setup context; sector/index comparisons need timestamp-aligned references.
- MCX option pricing and contract selection must use the verified futures reference appropriate to that option contract.
- Option premium observations are a different price series from underlying spot or futures.

Do not compare spot price to a futures-denominated VWAP/level without an approved, causal reference-alignment method. Never plot option-premium stops on an underlying-price chart. Never silently switch references or roll futures series through a live setup.

Every observation must identify source, instrument, event timestamp, receipt timestamp, availability timestamp where relevant, units, status and whether the value is observed, derived, modeled, inferred or unavailable.

A quote usable for a NEW entry needs valid, positive, non-crossed bid/ask and approved freshness/depth conditions. LTP is not an executable fill. Missing mandatory data blocks its dependent entry. Missing optional data must be disclosed and handled by an explicit rule, not silently assigned a neutral score.

Detect missing/duplicate/out-of-order ticks, invalid OHLC, session gaps, feed disconnections, stale quotes and clock problems. Never join missing intraday bars to manufacture a pattern. Define thresholds per data source and instrument class; do not declare one universal freshness window without validation.

### R-06-SRC — Multi-source authority and failover (critical Phase 2 closure)

For each exchange/product/instrument/data field, provide a source-authority matrix: authoritative source, permitted secondary source, canonical instrument/contract mapping, timestamp semantics, units, freshness limit, conflict tolerance, allowed switching conditions and approval state. The primary for quotes need not be the primary for historical candles or metadata, but the choice must be explicit and reproducible.

- **R-06-SRC-01:** Dhan and Angel One tokens are provider-specific. Match canonical exchange, instrument type, exact expiry, strike, side, reference contract and units before comparing or substituting data. A similar symbol is insufficient.
- **R-06-SRC-02:** Do not merge raw ticks into an unqualified single series, average conflicting quotes, combine one source's bid with another's ask, or select whichever quote produces a better backtest/fill. Comparisons must account for event-time skew, receipt latency and quote completeness.
- **R-06-SRC-03:** Specify disagreement checks, thresholds, sustained-conflict handling and explicit states such as PRIMARY_VALID, SECONDARY_APPROVED, CONFLICT and UNAVAILABLE. In a material unresolved conflict, block dependent NEW entries rather than invent authority. Continue unaffected monitoring.
- **R-06-SRC-04:** Approve failover/recovery rules before enabling automatic failover. Define synchronization, warm-up, failback hysteresis, bar-boundary handling, pending-entry treatment and whether a setup must be revalidated/rebuilt after a source switch.
- **R-06-SRC-05:** Persist source/epoch transitions in decisions, candles and fills. Never silently replace the data originally used to generate a historical signal. Corrections become versioned evidence.
- **R-06-SRC-06:** An open position's reference and stop do not silently change during failover. Specify how a compatible alternate feed monitors that same contract, how gaps are handled, and which paper outage state applies when equivalence cannot be established. A fresh secondary LTP is not a substitute for executable bid/ask or a different futures reference.

Source arbitration is a design requirement here, not a claim that current broker feeds agree or that failover has been implemented. No affected multi-source execution path is implementation-ready until this matrix is approved.

## 7. [R-07] Shared data and multi-timeframe calculations

Use one shared market-data layer and central reference-counted subscription registry. Strategies cannot create their own feed connections or duplicate indicator workers.

Candidate timeframes from the original proposal:

- 1m: optional execution refinement.
- 3m: optional confirmation experiment.
- 5m: proposed primary setup timeframe.
- 15m: proposed intraday context.
- 30m: optional broader context.
- Daily: previous-session levels and volatility context.

Do not require all six timeframes for every entry. In Phase 2 specify the smallest mandatory set per strategy, with optional refinements isolated as experiments. Avoid repeatedly confirming the same move until entry becomes late.

Use only data available at decision time. A bar must have closed AND arrived before it can confirm a setup. Higher-timeframe aggregation cannot leak its later final high, low, close or volume. Distinguish exchange close time from detection/receipt time. Late data and corrections do not retroactively create an executable historical entry.

Compute common indicators once per relevant update and reuse them. EMA/ADX/RSI are candidates, not automatically independent confirmations or mandatory gates. Specify formula, warm-up, timeframe, units and handling of missing/partial sessions for every adopted indicator.

Relative volume must use a documented comparable reference, preferably equivalent elapsed session intervals, with lookback, minimum history and calendar handling. Do not compare an opening five-minute bar to a full-day volume total.

## 8. [R-08] Regime model

Use separate, explainable axes rather than forcing overlapping concepts into one label:

- Trend: bullish, bearish, range or unclear.
- Volatility: expanding, contracting, normal or unstable.
- Event risk: clear, elevated or unknown.
- Data suitability: valid, partial, stale or unavailable.

Define the exact calculations, thresholds, session warm-up and conflict policy in Phase 2. Strategy compatibility is a decision table. A range reversal can have different requirements from a trend continuation; do not require bullish trend alignment to prove every bullish reversal.

Any mandatory event-risk dependency that cannot be measured blocks its affected capability. Do not claim “no event risk” merely because a news feed is empty. Optional features such as breadth or IV rank must not freeze the entire terminal when their dependent strategies do not require them.

### R-08-EVT — Event-risk data and operational expectations

Phase 2 must identify each proposed event source, covered markets/instruments, event types, publication/availability timestamps, freshness/completeness checks, blackout rules, licensing/cost requirements and approval status. Examples of event categories to assess include scheduled issuer announcements and scheduled macro/commodity announcements; naming a category does not establish that a reliable feed is available.

State whether event clearance is mandatory, optional or not used for EACH strategy/market/expiry combination. A mandatory dependency with no verified source results in BLOCKED_EVENT_DATA for that combination. It must not block unrelated eligible combinations. An empty or unavailable news response is not evidence of no scheduled/unscheduled event risk.

Expectation: some event-sensitive capabilities may remain unavailable until an appropriate source is approved. Never silently waive the dependency, promise detection of all unscheduled news, or buy/integrate a paid feed without authorization. Log unknown coverage and approval needs explicitly.

## 9. [R-09] Exactly four new research strategies

Implement no additional strategy without approval. Each is an unproven research hypothesis until option-level validation passes. CE and PE are long options; bearish underlying direction means buying a put, not selling a call.

For EACH strategy, the Phase 2 specification must include:

- Permitted instruments, reference series, session and entry window.
- Mandatory timeframes and warm-up.
- Exact setup, trigger, order eligibility and expiry conditions.
- One unambiguous entry method: close-following executable quote, trigger break, or retest entry. Do not silently blend methods.
- Structural invalidation, buffer and premium emergency-stop rules.
- Realistic objective/target selection and action when no usable target exists.
- Maximum entry extension, quote age and permitted delay after confirmation.
- Time stop, maximum holding period, no-progress exit if adopted and mandatory session cutoff.
- Re-entry limits, setup identity, parent-move identity and deduplication rules.
- Every parameter's units, proposed value, reason, validation range and approval state.
- Bullish/bearish examples, mirrored cases, boundary cases and refusals.

### Strategy 1 — Opening Range Breakout + VWAP + Volume

Proposed opening-range duration from the original prompt: first 15 minutes of the applicable session. Treat this as an initial research proposal, not a validated optimum. Define which session opening applies to each product and any missing-opening-bar rule.

Bullish concept: completed breakout above the opening-range high, reference-aligned VWAP support, defined relative-volume participation, acceptable breakout-candle geometry, no prohibited context conflict and no excessive entry extension. Bearish concept mirrors the opening-range low.

Phase 2 must define breakout buffer, close location, body/range test, permitted range-width/ATR conditions, entry method, retest policy, setup expiry, failure and target. A breakout-close entry and a breakout-retest entry must be separate predeclared variants if both are researched.

### Strategy 2 — VWAP Pullback + Trend Continuation

Bullish concept: established bullish structure, price/reference aligned with VWAP, controlled pullback toward defined support/VWAP, weaker pullback participation where measurable, intact invalidation level and a completed continuation trigger. Bearish conditions mirror.

Specify trend establishment, VWAP distance/tolerance, pullback depth/duration, volume comparison, permitted pullback count, trigger and whipsaw rejection. “Price above VWAP” alone is insufficient. EMA alignment is used only if included in the approved parameter pack.

### Strategy 3 — Previous-Session High/Low Sweep + Reversal

Bullish concept: breach of the previous-session low or an explicitly permitted known support, failure to sustain, completed reclaim and a defined reversal trigger. Bearish concept mirrors at the previous-session high/resistance.

A wick alone is insufficient. Define minimum/maximum penetration, reclaim deadline, trigger, trend-expansion exclusion, sweep-extreme invalidation and target. Enumerate eligible levels; do not expand “support” into arbitrary post-hoc levels. Required swing levels must have been confirmable before use.

### Strategy 4 — First Pullback After a Strong Opening Move

Bullish concept: an objectively qualified opening impulse, controlled first pullback, intact structure and completed continuation trigger. Bearish conditions mirror.

Define opening impulse window, minimum/maximum displacement relative to the chosen ATR, candle geometry, relative volume, pullback boundaries and trigger. Define what counts as the FIRST pullback and when that identity resets. Do not relabel a failed second/third attempt as the first.

Displacement may be part of this strategy's definition; do not make it a universal requirement for all four strategies without approval.

## 10. [R-10] Overlap, ranking and no-trade policy

Strategies 1, 2 and 4 can describe the same move. Independence of evaluation does not imply independent trading opportunities.

- Evaluate approved strategies in parallel on shared data.
- Give overlapping candidates a stable parent-move identifier.
- Default proposal: at most one selected position per underlying/parent move; enforce across strategy, strike and expiry, not merely identical contract keys.
- Define whether opposing signals cancel, block, rank or coexist. Do not open CE and PE merely because each separate detector fires.
- Maintain portfolio correlation/exposure limits as an additional control.
- Record all qualified, rejected and arbitration-losing candidates separately from executed paper trades.
- Use deterministic, approved tie-breaking. A fill failure must not create duplicate exposure through an uncontrolled fallback.

Mandatory setup, data, contract, risk and exposure failures cannot be compensated by a score. Return a machine-readable refusal code and exact failed condition. Revalidate eligibility immediately before a simulated fill; a valid signal may no longer be a valid entry after price moves.

Minimum net reward/risk, if adopted, is an approved policy parameter. Do not silently inherit the terminal's previous thresholds, invent a new optimum or move target/stop to satisfy a ratio. Propose and justify the baseline and a small number of controlled alternatives in Phase 2.

## 11. [R-11] Scoring: transparent research, not probability

The original proposal's regime/context/quality/VWAP/volume/breadth/liquidity/IV/risk weights sum to 100, and proposed grade cutoffs were 85/75. Preserve them as an optional, explicitly unvalidated research variant, not a known profitable rule.

For any adopted score, define each normalized component in [0,1], weight in points, formula and missing-data behavior. Final score = sum(weight_points × normalized_component). If weights instead sum to 1, multiply the result by 100 exactly once.

Avoid double-counting correlated trend evidence. Compare the same strategy's mandatory-rule-only baseline against a frozen score-gated variant. Do not search hundreds of weight/cutoff combinations against the final holdout.

An 85/100 score is a heuristic score, not an 85% win probability. Never label it accuracy or probability without a separately calibrated and out-of-sample validated probability model.

## 12. [R-12] Contract, expiry, IV and Greeks

Evaluate a bounded, approved set of ATM/near-ITM/near-OTM strikes and eligible expiries. Underlying liquidity does not establish option liquidity. Do not choose the cheapest premium or nearest expiry automatically.

Mandatory contract rules must define quote freshness, bid/ask spread, displayed depth/quantity, volume/OI requirements, lot size, tick size, expiry restrictions and data availability. Volume/OI are not substitutes for an executable quote.

The original strike score weights (liquidity 25, delta 15, expected premium move 20, theta 10, IV 10, gamma 10, net payoff 10) are unvalidated proposals. Define normalized components and compare against a simpler selection baseline before approving them.

Record observed/model-derived IV and Greeks with pricing model, input reference, rates/dividend/carry assumptions where needed, time convention and units. Choose a model suitable for the verified contract; do not assume one model handles every equity and commodity product identically.

Premium = intrinsic + extrinsic under the contract's correct reference/model. Distinguish expiry breakeven from intraday mark-to-market breakeven after costs.

For sensitivity estimates:

`dPremium ≈ Delta*dUnderlying + 0.5*Gamma*dUnderlying² + Vega*dIV + Theta*dt`

Define whether IV is decimal or percentage points, vega per which IV unit, theta per which time unit, premium price units and quantity multipliers. Use the same conventions in calculations and tests. Do not confuse annualization/session conventions or subtract theta twice.

This local approximation is not a guaranteed target or executable option path. Use repricing/scenarios for material moves, time changes or IV changes. Include IV contraction and adverse spread scenarios, especially around events. IV/HV and IV rank describe context; neither high nor low IV alone proves an attractive purchase. IV rank/percentile require adequate point-in-time history with a defined lookback and expiry/moneyness comparability.

### R-12-EXP — Expiry, 0DTE and settlement-window policy (critical Phase 2 closure)

Specify and approve an eligibility matrix separately for index, stock and commodity options and each supported exchange. Generic “expiry restrictions” is insufficient.

- **R-12-EXP-01:** `allow_0dte`, minimum time to final tradable cutoff, permitted expiry/session windows, last NEW-entry time and mandatory exit deadline must be explicit. Until approved, the affected expiry bucket is ineligible; do not assume expiry-day trading is permitted.
- **R-12-EXP-02:** Store both the defined calendar DTE and remaining tradable time. Identify exchange timezone, final trading cutoff, holiday adjustments and data availability. A date difference is not an adequate risk clock for a short remaining session.
- **R-12-EXP-03:** Verify current contract-specific exercise/settlement and broker/data restrictions, particularly stock-option settlement/delivery exposure and MCX option-to-futures reference/expiry relationships. Do not assume index rules apply to stocks or commodities. Missing verification blocks the affected bucket. This is a verification mandate, not legal/compliance certification.
- **R-12-EXP-04:** Define expiry-day quote, depth, spread, latency, premium-risk and scenario requirements. Test large gamma effects, time decay, IV changes, gaps and missing exit quotes. Do not widen stops or relax risk merely to obtain an expiry-day trade.
- **R-12-EXP-05:** Define the latest eligible exit before the relevant cutoff with a configured time buffer. If no reliable exit quote exists, follow the paper outage/uncertain-exit policy; do not manufacture an on-time fill, zero-value settlement, physical delivery or a broker transaction.
- **R-12-EXP-06:** Validate expiry-day and non-expiry-day results separately. Any stock settlement-window or commodity expiry exclusions must be visible in eligibility, rejected-candidate logs and coverage reports.

Do not hardcode current exchange dates, weekly listings, cutoff times or broker restrictions from memory. Cite current primary sources during Phase 2 and retain effective dates in historical tests.

## 13. [R-13] Paper execution and cost accounting

Default execution mode is PAPER_TRADING or SIGNAL_ONLY. No live-order adapter endpoints are required in this project phase. Read-only market-data adapters can be reused.

- Buy entry uses an eligible ask-side quote with defined latency, size and slippage assumptions.
- A long-option exit uses an eligible bid-side quote, not ask, midpoint or an assumed LTP fill.
- Record signal time, computation time, trigger, quote time, simulated arrival, eligibility, fill/partial fill and cancellation.
- If order size exceeds credible executable depth, use an approved conservative partial-fill/slippage rule or refuse; never infer unlimited liquidity from LTP/volume/OI.
- Depth is indicative, not a fill guarantee. Clearly label the simulation's limitations.
- Pending entries expire/cancel on invalidation, stale data, spread breach, capacity breach or the strategy deadline.
- A historical bar high/low does not prove a fill at a specific premium or event ordering.

Avoid double-counting costs. If ask-entry/bid-exit already embeds spread, do not subtract the same spread again. State which slippage is embedded in fills and which explicit charges remain. Use effective-dated exchange/broker charge schedules with official verification; estimates remain labeled.

Do not fabricate fills when quotes are missing. Report SIGNAL_VALID_EXECUTION_UNVERIFIED, UNFILLED, PARTIAL or another explicit state. Missing-data cases cannot quietly disappear from coverage reporting.

## 14. [R-14] Stops, invalidation and trailing: separate price spaces

Maintain separate state for:

1. Underlying strategy invalidation.
2. Underlying volatility/buffer reference, if approved.
3. Option-premium protective/emergency stop.
4. Any option-premium trailing stop.

ATR must identify its instrument, timeframe, period, smoothing and units. Underlying ATR cannot be subtracted directly from option premium. Computing an underlying ATR buffer and then mapping a scenario into option premium is an estimate, not an exact identity.

Use the strategy's actual invalidation. Do not tighten a stop to manufacture attractive R:R, widen it merely to avoid rejection or invent a farther target. Refuse unsuitable geometry/contracts. Define what happens when the premium emergency stop triggers before the underlying invalidates; do not assume they trigger together.

For a purchased CE AND a purchased PE, the option-premium protective stop is below the protected premium reference and ratchets upward as premium gains. Buying a PE does not reverse the premium stop direction.

Underlying swing trailing differs: a bullish CE thesis may trail below confirmed higher lows; a bearish PE thesis may trail above confirmed lower highs. Those are underlying levels, not option-premium prices. Never overlay them on the wrong series.

Research the following as separate exit variants using identical eligible entries, with position-capital interactions reported separately:

- Fixed structural invalidation plus defined target/time exit: baseline.
- R-multiple protection: exact +1R/+1.5R/+2R activation and locked levels require approval.
- Premium ATR trail: `highest eligible observed premium since fill - multiplier*option_premium_ATR`, only when suitable historical/live premium candles exist.
- Confirmed underlying swing trail.
- One explicitly specified hybrid, only if it adds measurable value.

Do not automatically combine all trails. Define whether premium highs use executable bid marks or another approved observation, touch/confirmation rules, monotonic direction, tick rounding and persistence. A trailing activation beyond an already-earlier profit target cannot be advertised as an expected next action. Entry-price breakeven is not after-cost breakeven.

### R-14-REF — Protected premium reference (critical Phase 2 closure)

The phrase “protected premium reference” is not an executable rule. The approved state machine must name these independent fields and their price space:

| Field | Definition required before approval |
|---|---|
| Entry reference | Signal/trigger reference, separate from actual quantity-weighted simulated entry fill. |
| Initial R | Frozen currency/per-unit risk definition at fill, cost coverage, and treatment of partial fills; never recalculated from a trailed stop. |
| Current executable exit mark | Eligible bid, required size/depth, freshness and valuation policy; no silent LTP substitution. |
| Premium high-water mark | Whether highest eligible bid, size-aware exit mark or another explicitly approved series; start time, session handling and missing observations. |
| Activation reference | Exact series and gross/net units used to decide +1R/+1.5R/+2R or other protection activation. |
| Stop trigger reference | Exact quote/trade series, crossing/touch rule and timestamp used to activate the simulated protective exit. |
| Trailed stop level | Formula, tick rounding, monotonic update rule, partial-fill behavior and durable persistence. |
| Exit fill | Separately modeled executable bid-side fill after trigger and latency; not a guarantee of the stop level. |

Specify how fees and spread enter breakeven and R activation without double-counting. For bought CE and bought PE, a premium protective stop ratchets upward, while the underlying invalidation direction may differ. Do not swap bid, ask, midpoint and LTP across activation, trailing and fills without explicit rules and tests.

If a required reference is stale or missing, mark the affected operation unavailable/uncertain and apply the approved paper monitoring policy. The approval checklist and configuration schema must include every reference above; no silent fallback is permitted.

## 15. [R-15] Event ordering, forced exits and feed gaps

Use event timestamps and an idempotent per-position state machine, not a static rule list that can override an earlier observed fill.

- Session cutoff is a hard forced-exit deadline, not a low-priority exit to ignore while another condition persists.
- Define emergency, strategy invalidation, target, premium stop, trailing, opposite-signal and time exits with deterministic tie-breaking for genuinely simultaneous events.
- Never loosen stops. Treat crossed/gapped stops as adverse execution scenarios; do not guarantee a fill at the stop price.
- If stop and target occur in one OHLC bar without ordering data, label ambiguity and report conservative/alternative bounds separately. Do not choose the profitable sequence.
- On feed loss, block dependent new entries, retain position state/subscriptions and apply the approved paper-only outage policy. Do not fabricate emergency exit prices or mark positions closed without evidence.
- On recovery, backfill only available evidence, record uncertain gaps, and check every position sharing a token independently before treating recovery as complete.
- Preserve watches across intraday/positional slots, strategies and same-contract positions. Subscribe once where possible; unsubscribe only after the final dependent watch/order is gone.
- Restart recovery must reconstruct positions, pending fills, risk counters, parent identities and monotonic stop state without creating duplicates or reviving disabled entries.

Real broker stop reconciliation/emergency orders belong to a separately approved future live-execution project, not this paper engine.

## 16. [R-16] Sizing, capital and portfolio risk

Define units before implementing any sizing:

`RiskBudgetCurrency = configured_available_paper_capital * risk_fraction`

`RiskPerLotCurrency = modeled_loss_to_protective_exit_for_one_lot + nonembedded_exit/entry_costs`

`RiskLimitedLots = floor(remaining_risk_budget / RiskPerLotCurrency)`

`FinalLots = min(RiskLimitedLots, PremiumAffordableLots, ExposureAllowedLots, ApplicableQuantityLimitLots)`

Lot quantity and price-unit multiplier are contract-specific. Do not multiply by both twice. Include actual selected expiry/strike metadata. Record how stop-based loss is modeled when invalidation is on the underlying and premium also depends on IV/time.

Zero permitted lots means NO TRADE. No “active position with zero risk” display. Reserve paper capital/risk atomically for simultaneous entries; do not let each candidate independently spend the same available capital.

Track both planned stop risk and total premium outlay/max-loss exposure for a purchased option. A stop budget is not a guarantee against gaps. Set a separate approved premium-outlay limit and stress assumptions. No martingale, averaging down or size increases intended to recover losses.

Original initial paper-risk proposals, not universal recommendations:

- Per-trade planned risk: 0.25%.
- Daily loss ceiling: 1.00%.
- Maximum open positions: 2.
- Maximum highly correlated concurrent positions: 1.
- Pause after 3 consecutive net losses.

Specify capital base, premium cap, realized/unrealized loss treatment, costs, partial exits, pause duration, reset calendar/session and pending-order cancellation behavior before approval. Daily limits must survive restart. Reaching a daily limit blocks new risk; existing-position handling follows its separately approved policy.

Report correlated index, sector and commodity exposure. Define the correlation/grouping method causally; unavailable estimates require conservative disclosed rules, not a claim of independence. Use model-consistent quantities when reporting aggregate delta/vega across heterogeneous instruments.

## 17. [R-17] Historical validation and research discipline

Historical option-buying performance requires dated individual option-contract prices and sufficient execution evidence. Underlying-only tests are signal studies; model-repriced premiums are modeled option scenarios. Neither is an observed option execution backtest. Label these evidence classes separately.

Inventory actual data before promising a test period. Include expired/delisted instruments where relevant, corporate actions, futures rolls, calendar changes, historical eligibility, lot/tick/multiplier changes and effective-dated costs. Freeze dataset versions and integrity/coverage reports.

Use chronological development, validation and final untouched holdout periods, plus predeclared walk-forward evaluation. No random shuffling. Prevent bar-close, swing-confirmation, indicator, contract-selection and data-availability lookahead. Lock parameters before seeing final-holdout outcomes. Once inspected, a holdout is no longer untouched for further tuning.

Predeclare a small experiment budget. Do not independently optimize every strategy/exchange/instrument/timeframe/regime/IV/direction/trailing combination and report only winners. Track all attempted variants, selection bias, multiple comparisons, sensitivity, turnover and capacity. Keep an executable simple baseline. Rejected/losing periods cannot be omitted.

Compare exits on identical entries for a direct exit-method study. For full portfolio comparisons, separately simulate capital, concurrent exposures, re-entry eligibility and opportunity displacement—identical entries are not automatically feasible under every portfolio path.

Freeze target generation and exits before testing; a projected move or attractive R:R is not an estimated win probability. A useful strategy can fail the 70% aspiration, and a 70% strategy can still fail net profitability.

## 18. [R-18] Result definitions and evidence gates

Define a win as a completed filled trade with NET P&L > 0 after the specified costs. Define a loss as NET P&L < 0, flat as zero within a predeclared rounding tolerance. Report partial fills, partial exits and quantity-weighted costs correctly.

Win-rate denominator includes all completed filled positions, including target, stop, time, forced-session and other completed exits. Keep open, unresolved, unfilled, cancelled and missing-data cases separately visible. Do not compute accuracy on target/stop outcomes alone. Report data coverage and exclusions, including their reasons.

Report currency P&L only when quantity, multipliers and cost coverage support it. Otherwise report a clearly defined per-unit/R result with missing fields disclosed. Initial R is frozen at entry under an approved definition; trailing a stop to entry never resets the R denominator to zero.

Report trades, independent sessions, net-win rate, 95% confidence interval, average net win/loss, expectancy, gross/net P&L, profit factor, maximum drawdown with declared equity-marking basis, recovery, holding time, longest loss sequence, costs, fill/coverage assumptions and exposure. Separate strategy, market, direction, timeframe, parameter version and chronological cohorts; show sample sizes for every slice.

Use day/session-aware uncertainty estimates where trades are dependent. Do not count four signals on one move as four independent successes. Separate trade-level intervals from dependence-aware evidence. Thirty trades can reveal implementation issues; it is not automatic proof of profitability or 70% reliability.

For target reporting:

- Observed net-win rate >=70%: say OBSERVED_TARGET_REACHED, with sample and uncertainty.
- If uncertainty still supports materially lower rates: say EVIDENCE_INCONCLUSIVE, not “validated 70%”.
- A strong claim of sustained >=70% needs a predeclared statistical criterion, such as the lower bound of the stated confidence procedure exceeding 70%, and adequate independent observations. Do not choose the criterion after seeing results.
- Positive net expectancy, acceptable drawdown, robustness and execution coverage remain separately necessary.

In Phase 2 propose numerical promotion criteria, precision/sample targets, minimum independent sessions, drawdown limits, holdout design and sensitivity tests for approval. No auto-promotion based only on a point estimate, one winning month or passing tests.

## 19. [R-19] Paper rollout, isolation and AI

After approved implementation and historical validation, enable only explicitly approved new paper strategy versions. Never reactivate legacy engines as a fallback to produce more trades.

Keep candidate, shadow, paper and any future execution modes explicit. Do not pool legacy and new results or claim paper fills are broker fills. If a live paper sample contradicts a backtest, investigate timestamps, fills, data and regime rather than silently tune parameters.

AI reviews may run automatically on saved records under bounded provider budgets and cooldowns. They must distinguish measured facts, missing evidence and hypotheses, and never alter entry/exit/risk rules automatically. Provider failure cannot stop deterministic monitoring or cause a trade. Do not send secrets or arbitrary untrusted stored text as instructions.

Current project excludes order placement, live modification/cancellation and real-money execution. A future live project requires its own explicit authorization, reconciliation/emergency design and readiness review; this prompt grants none of that authorization.

## 20. [R-20] Infrastructure and broker API efficiency

Inspect current official Dhan and Angel One documentation before fixing supported capabilities or numeric limits. Record reference, retrieval date, endpoint/mode and effective scope. Broker limits/authentication/expiry behavior can differ. Missing documentation is NEEDS_VERIFICATION, not a guessed limit.

Use a modular monolith/existing service topology by default. Logical modules are not an instruction to create separate Railway services. Keep independent broker request managers with bounded concurrency, batching where supported, deduplication, budgets, backoff/jitter, retry classification and metrics.

Priority: active-position safety and evidence capture, pending fill/state reconciliation, existing setup monitoring, shortlisted candidates, universe discovery, then historical/optional analytics. Reserve/test capacity rather than promising impossible absolute isolation in a shared process. Avoid aggressive dashboard polling and duplicated component requests.

Two-stage discovery: cached instrument universe plus lightweight shortlist, then bounded detailed option/streaming subscriptions for eligible candidates. Keep position/pending-entry subscriptions regardless of shortlist changes. Document scanner cadence and its detection delay. Do not claim complete opportunity capture when subscriptions/data are sparse.

Cache metadata, incrementally fetch historical data and aggregate candles once. Recompute indicators only when their inputs change. Use bounded cache sizes/TTLs, queues, API calls, reconnection loops and database writes. No whole-universe full-chain polling or one connection per strategy/instrument.

Backoff honors provider guidance. Distinguish authentication, permanent invalid requests and transient errors. Stop invalid retry loops; retain durable work for later controlled recovery when appropriate. Do not halt position monitoring because optional analytics is unavailable.

Use controlled reconnection, fresh-data validation and independent per-position gap checks. Do not restart the entire backend to hide feed failures. Preserve risk state when a feed is down.

Database writes should use appropriate uniqueness/idempotency, indexes, pooling and bounded batches. Store candles, decision snapshots, positions, fills, risk changes and audit evidence. Raw ticks are opt-in justified research/debug data with a retention budget, not unlimited default storage. Never erase active/audit records to save space.

Do not run heavy backtests/optimization continuously on the production risk worker. Use existing approved remote resources where possible, controlled off-session/batch jobs and measured CPU/RAM limits. New infrastructure or paid data plans require an explicit proposal and approval.

Monitor available CPU/RAM, restarts, storage growth, connections, query latency, subscriptions, queue depth, API counts/failures, cache hits, detection latency and monitoring latency. Mark unavailable metrics NOT_AVAILABLE. Daily/weekly reports can be read-only on-demand reports initially; recurring schedules or notifications need explicit specification and authorization.

## 21. [R-21] UI and explainability

Provide separate views for market/data health, new-strategy candidates, blocked setups, selected paper trades, performance and system usage. Clearly show disabled legacy engines and their historical results separately.

Every candidate/trade shows its strategy/version, parent move, reference series, event/decision time in IST, regime, setup conditions, contract/expiry/strike, source quote time, executable-side quote, fills, quantity, original risk, costs, structural invalidation, premium stop, target/time exit, trailing state, score explanation, missing data and refusal/exit reason.

Chart conventions:

- Distinguish PATTERN_CANDIDATE, SWING_CONFIRMED, ENTRY_TRIGGERED, PAPER_FILLED, INVALIDATED and EXITED.
- “Confirmed” alone is insufficient and must not imply a target is guaranteed.
- Timestamp markers when their information became available. Retrospective origins may be shown only as clearly linked historical geometry, never as an earlier actionable signal.
- Use closed bars for confirmation; show provisional observations as provisional, if shown at all.
- Default to relevant current annotations; historical annotations are separately toggleable.
- Do not invent OB/FVG/pattern overlays or add them as mandatory gates to these four strategies. If retained as optional chart context, disclose definitions, reference/timeframe, confirmation, expiry and invalidation; they are not automatically new entry signals.
- Never mix premium and underlying price axes. Unknown fields show a missing state, not zero.

Keep explanations concise: why setup qualified, why refused, what invalidates it, and what remains uncertain. A high score is not a win probability or a recommendation to execute a real order.

## 22. [R-22] Tests, acceptance and rollback

Build a requirement-to-test matrix. Necessary tests include:

- Historical/current instrument mapping, units, calendars, expiry and session boundaries.
- Closed/available bars, multi-timeframe causality, volume/VWAP reference alignment and missing bars.
- Every strategy's mandatory condition, mirrored directions, first-pullback identity and boundary cases.
- Shared parent arbitration, duplicate suppression, concurrency and idempotent simulated fills.
- Bid/ask fills, cost double-counting, liquidity/size limits, quote latency and partial/unfilled outcomes.
- IV/Greeks units, model inputs, scenario limitations and unavailable history.
- Structural/premium stop separation, bought-PE direction, tick rounding, gap uncertainty, trailing monotonicity and unreachable trail triggers.
- Capital/premium affordability, zero-lot refusal, atomic risk reservation, daily limits and restart persistence.
- Feed outage/recovery, same-token multiple positions, subscription references, authentication expiry and bounded retries.
- Full decision replay with frozen time/data and no real IO; separate accepted and refused end-to-end cases.
- Legacy entry engines stay off after deployment/restart/recovery; old positions remain monitored.
- Analytics purity, learning isolation and no broker-order side effects.
- UI meaning, chart timestamps, reference integrity, IST display, mobile behavior and accessibility.
- Resource/API budgets and representative load measurements on the approved deployment capacity.

Do not change frozen research baselines without a versioned reason. Tests establish implementation behavior, not trading edge.

Rollback is reversible and versioned: disable new entries while preserving monitoring/open plans and evidence. Do not restore legacy entries automatically, erase losing trades, reset daily limits or downgrade the data-quality requirements to make a rollout look healthy.

## 23. [R-23] Phases after approval

Only after Phase 1–2 approval:

3. Validate pure logic, formulas, units and datasets using the approved spec.
4. Implement one bounded module at a time with integration tests and measured resource impact.
5. Run predeclared chronological historical/holdout experiments, without tuning on final holdout.
6. Run explicitly approved forward paper trading; measure signal, fill, monitoring, costs and resource coverage.
7. Deliver an independent results/readiness assessment. Keep real-money execution absent from scope.

Before each activation/deployment, provide the concrete diff, tests, configuration/version changes, migrations, rollback and limitations. Code changes, strategy activation and production deployment are distinct actions; obtain the authorization appropriate to the requested phase rather than treating a research target as permission to trade.

## 24. [R-24] Required Phase 1–2 output

Deliver a reviewable document containing:

1. Executive verdict and verified fresh-start/legacy-disablement status.
2. Repository/infrastructure audit and module-reuse map.
3. Market/data capability matrix and missing historical option evidence.
4. Four complete deterministic strategy specifications and proposed parameter packs.
5. Reference-series, regime and timeframe decision tables.
6. Contract/expiry, pricing, IV/Greeks and fill/cost methodologies.
7. Stop/trailing state machines, event ordering and paper outage policy.
8. Sizing, premium affordability, daily/portfolio limits and restart recovery.
9. Cross-strategy parent arbitration and deduplication design.
10. Scoring experiment, baseline and constrained optimization plan.
11. Statistical protocol, outcome definitions, coverage, promotion criteria and evidence limits.
12. Shared feeds, API/resource budgets, monitoring and storage plan.
13. UI/chart status semantics and required audit records.
14. Requirement-to-test map, migration/rollback proposal and phased implementation plan.
15. Ambiguity/limitation register and one concise approval checklist.
16. Explicit approval rows for R-06-SRC source arbitration, R-12-EXP expiry/0DTE eligibility, R-14-REF premium references and R-08-EVT event coverage.
17. A populated proposed configuration schema derived from Appendix B, with all unresolved critical values still null/NEEDS_APPROVAL and execution disabled.

Phase 1–2 can proceed with unresolved design choices documented. Approval to code a capability requires its mandatory design choices to be closed. A market-data availability issue remains a data issue even when the specification honestly describes it. Paper-only scope does not certify future live compliance; pricing-model requirements do not prove a model has been selected/tested; statistical requirements do not mean sufficient observations exist.

For every requirement show VERIFIED_EXISTING, REUSE_WITH_FIX, NEW_REQUIRED, PROPOSED_NOT_APPROVED, BLOCKED_DATA, NEEDS_VERIFICATION or OUT_OF_SCOPE with evidence and impact.

FINAL INSTRUCTION: Start with the read-only audit and complete proposed technical specification only. Do not modify code, reactivate any strategy, deploy, create infrastructure, send notifications or place real orders. Continue independent read-only work when one dependency is blocked. Present unresolved critical trading choices explicitly for approval; never silently invent an executable rule or claim the 70% aspiration has been achieved.


## Appendix A — Traceability and approval rules

R-01 through R-24 are stable requirement-group IDs corresponding to the numbered sections. R-06-SRC, R-08-EVT, R-12-EXP and R-14-REF identify critical subgroups. The individually numbered SRC/EXP requirements have stable IDs; assign additional child IDs to atomic requirements while producing Phase 2, without deleting or changing the meaning of the parent requirements.

Each requirement-to-module/test/approval row must contain:

`requirement_id | exact requirement | capability/market | proposed_rule_or_config_key | evidence | module/file | test_id | status | unresolved_dependency | approver/version`

Keep process/requirements status separate from implementation/testing status. “Specified” does not mean “implemented”, “tested” or “profitable”. Preserve the history of revisions and approvals; do not mark all child requirements approved when only their parent summary was reviewed.

Critical implementation approval gate:

- Exact four strategy rule packs and entry/exit/time-stop parameters approved.
- Source authority, conflict, failover/recovery and price-space mapping approved for affected inputs.
- Expiry-day permissions, settlement-window exclusions and cutoff policies approved.
- Entry/R/high-water/activation/trigger/fill references and units approved.
- Required event-risk sources and unknown-data handling approved.
- Sizing, premium affordability, exposure, daily-limit and outage policies approved.
- Dataset capability, fill/cost evidence class, validation protocol and test plan agreed.
- Scope remains paper-only; legacy NEW entries remain disabled.

No authorization is inferred from this checklist being present. Record actual approval against the exact version. Partial approval enables no unapproved path.

## Appendix B — Non-executable configuration skeleton

This YAML is a specification template, NOT a deployable parameter pack. Null values are intentional. Resolve them through Phase 2 proposals and approval; never coerce null into zero, true or a platform default. This is a structural template, not a claim that the current terminal accepts this YAML.

A future runtime validator must refuse affected strategy activation if status is not APPROVED, any required field is unresolved, the policy is incompatible with the market, or the referenced approval is missing. Audit tooling must be able to load and display the incomplete proposal without enabling execution. Exclusions/NOT_USED for optional fields must be explicit in the approved per-capability schema.

```yaml
spec_version: FRESH-START-SPEC-1.1
configuration_status: PROPOSED_NOT_APPROVED
approval_record: null
work_environment: CONNECTED_REMOTE_WORKSPACE_ONLY
local_machine_changes_allowed: false
current_scope: AUDIT_AND_SPECIFICATION_ONLY

execution:
  enabled: false
  permitted_future_modes: [SIGNAL_ONLY, PAPER_TRADING]
  selected_future_mode: null
  live_order_implementation_allowed: false
  real_order_submission_allowed: false

legacy:
  allow_new_entries: false
  allow_automatic_reactivation: false
  preserve_historical_evidence: true
  retain_existing_position_monitoring: true
  disablement_verification_status: NEEDS_VERIFICATION

source_authority:  # R-06-SRC; expand per field/instrument/market
  status: NEEDS_APPROVAL
  canonical_contract_identity_schema: null
  primary_by_field: null
  approved_secondary_by_field: null
  timestamp_alignment_policy: null
  cross_source_tolerance: null
  conflict_policy: null
  failover_conditions: null
  failback_conditions_and_hysteresis: null
  source_epoch_and_audit_policy: null
  pending_entry_switch_policy: null
  open_position_reference_policy: null

market_eligibility:  # separate entries for every approved market/product
  - market: NSE_INDEX_OPTIONS
    enabled: false
    status: NEEDS_APPROVAL
    underlying_reference: null
    volume_vwap_reference: null
    reference_alignment_policy: null
    mandatory_data: null
    expiry_policy:
      allow_0dte: null
      minimum_remaining_tradable_seconds: null
      allowed_expiries_and_windows: null
      last_new_entry_rule: null
      forced_exit_rule_and_buffer: null
      settlement_window_exclusions: null
      official_contract_verification: null
  - market: NSE_STOCK_OPTIONS
    enabled: false
    status: NEEDS_APPROVAL
    reference_and_expiry_policy: null
  - market: BSE_VERIFIED_OPTIONS
    enabled: false
    status: NEEDS_VERIFICATION
    reference_and_expiry_policy: null
  - market: MCX_VERIFIED_FUTURES_OPTIONS
    enabled: false
    status: NEEDS_VERIFICATION
    exact_futures_reference_and_expiry_policy: null

strategies:  # R-09; all four remain independent research proposals
  - id: NEW_ORB_VWAP_VOLUME
    enabled: false
    status: NEEDS_APPROVAL
    version: null
    mandatory_inputs_and_timeframes: null
    complete_entry_stop_target_time_exit_rule_pack: null
  - id: NEW_VWAP_PULLBACK
    enabled: false
    status: NEEDS_APPROVAL
    version: null
    mandatory_inputs_and_timeframes: null
    complete_entry_stop_target_time_exit_rule_pack: null
  - id: NEW_PREVIOUS_SESSION_SWEEP_REVERSAL
    enabled: false
    status: NEEDS_APPROVAL
    version: null
    mandatory_inputs_and_timeframes: null
    complete_entry_stop_target_time_exit_rule_pack: null
  - id: NEW_FIRST_OPENING_PULLBACK
    enabled: false
    status: NEEDS_APPROVAL
    version: null
    mandatory_inputs_and_timeframes: null
    complete_entry_stop_target_time_exit_rule_pack: null

parent_arbitration:
  status: NEEDS_APPROVAL
  parent_identity_and_lifecycle: null
  cross_strategy_underlying_exposure_policy: null
  deterministic_ranking_and_tie_break: null

premium_references:  # R-14-REF; do not default to LTP
  status: NEEDS_APPROVAL
  entry_fill_reference: null
  initial_r_definition_and_cost_units: null
  executable_exit_mark: null
  high_water_mark_reference: null
  protection_activation_reference: null
  protective_stop_trigger_reference: null
  trailing_formula_and_tick_rounding: null
  exit_fill_and_latency_model: null
  partial_fill_and_restart_policy: null

paper_risk:
  status: PROPOSED_NOT_APPROVED
  capital_currency: INR
  capital_amount: null
  proposed_risk_fraction_per_trade: 0.0025  # 0.25%; inactive proposal
  proposed_daily_loss_fraction: 0.01       # 1.00%; inactive proposal
  proposed_max_open_positions: 2
  proposed_max_highly_correlated_positions: 1
  proposed_pause_after_consecutive_net_losses: 3
  premium_outlay_cap: null
  risk_per_lot_units_and_multipliers: null
  daily_loss_unrealized_cost_and_reset_policy: null
  initial_stop_and_trailing_policy: null
  minimum_net_reward_risk_policy: null
  missing_quote_and_emergency_paper_policy: null

execution_evidence:
  status: NEEDS_APPROVAL
  bid_ask_freshness_and_depth_rules: null
  fill_latency_partial_fill_and_slippage: null
  embedded_vs_explicit_cost_ledger: null
  same_bar_ambiguity_and_gap_policy: null

event_risk:  # R-08-EVT; unknown does not mean clear
  status: NEEDS_APPROVAL
  verified_sources_and_coverage: null
  mandatory_optional_not_used_by_capability: null
  blackout_rules_and_freshness: null
  unknown_data_policy: null

scoring_and_contract_selection:
  status: PROPOSED_NOT_APPROVED
  mandatory_rule_only_baseline: null
  score_components_weights_and_cutoffs: null
  strike_expiry_filters_and_ranking: null
  iv_greeks_model_reference_and_units: null

validation:
  status: NEEDS_APPROVAL
  aspiration_net_win_rate: 0.70
  win_rate_is_guaranteed: false
  dataset_versions_and_evidence_classes: null
  chronological_development_validation_holdout: null
  experiment_budget_and_multiple_testing_policy: null
  minimum_independent_sessions_and_precision: null
  uncertainty_procedure_and_target_claim_criterion: null
  net_expectancy_drawdown_and_coverage_thresholds: null
  paper_activation_criteria: null

resource_policy:
  status: NEEDS_VERIFICATION
  approved_current_service_capacity: null
  official_broker_limits_and_effective_dates: null
  shared_subscription_and_api_budgets: null
  monitoring_reserved_capacity_and_queue_limits: null
  cpu_ram_storage_and_backtest_budgets: null
  external_notifications_enabled: false
```

## Closing instruction

Read this entire prompt. Do not treat the YAML skeleton or research proposals as approved executable rules. Begin Phase 1 read-only audit and Phase 2 proposed specification, keep existing strategy NEW entries disabled, preserve historical evidence and residual open-position monitoring, and deliver the versioned approval matrix. No local-machine changes, code changes, strategy activation, deployment, infrastructure mutation or real orders are authorized at this stage.
