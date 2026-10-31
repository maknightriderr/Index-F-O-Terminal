# Approved paper research with incomplete economic-calendar data

## Authorization and scope — 1 November 2026

The user explicitly authorized using free event sources and, when adequate free data is unavailable, enabling paper trades despite missing event data, with its impact explained. This supersedes the earlier mandatory complete macro/commodity coverage rule **for paper research only**. It does not authorize live execution, guessed contract quantities, fabricated quotes, account resets, or deletion/reconstruction of past records.

Production policy: `PAPER_EVENT_UNVERIFIED_V1`. The source class's strict mode remains available and is still its explicit default; only the production paper factory selects the approved research policy. No paid key, paid subscription, new dependency, local installation or extra broker subscription is required. `FRESH_EVENT_COVERAGE_CONFIRMED` is not changed to pretend coverage exists. Existing free RBI/BEA/EIA/BLS observations continue independently, alongside the newly verified partial ShowMyTrades feed.

## Current free-source check

- [ShowMyTrades](https://showmytrades.com/docs/api/economic-calendar) supports nine currencies, excluding INR. Its actual keyless two-day high-impact request returned HTTP200 with three fresh reported events. The new supplemental adapter uses it for additional known-event vetoes, not complete coverage. Its terms permit server caching/own-client use; the UI credits it. Calendar data is not exposed through a public unauthenticated calendar API.
- [FinanceCalendar](https://www.financecalendar.com/api/) documents free access with attribution, but the bounded live status probe returned HTTP403 in this session. Prior incomplete/stale coverage was not promoted to verified data.
- RBI/BEA/EIA production snapshots were verified in PR88; those limited scopes remain useful known-event evidence, not complete calendars. BLS's last production probe returned HTTP403. MoSPI's exact public UI API returned HTTP502 in the previous qualification phase. No access denial was bypassed or copied third-party calendar relabeled as complete.

No complete India/global free replacement was verified. A useful partial global feed was verified and integrated. The explicitly approved paper exception therefore applies; further source scaffolding is not a prerequisite to collecting research fills.

## Exactly what changes

| Missing input | Paper research behavior |
|---|---|
| Macro provider absent, not coverage-confirmed, failed, stale or otherwise unavailable | Missing-coverage veto becomes a recorded warning |
| Complete commodity scheduled-event coverage unavailable | Missing-coverage veto becomes a recorded warning |
| A freshly observed macro/BLS/BEA/EIA release blackout | Entry remains blocked |
| A known RBI meeting day or authoritative event with uncertain release time | Entry remains blocked |
| Stock result day, uncertain issuer meeting, missing issuer coverage, corporate-action/ex-date or unresolved split-adjusted history | Existing veto remains mandatory |
| Missing/ambiguous contract link, source conflict, unknown lot/depth quantity, stale/incomplete quote, poor payoff, sizing/account/legacy-inventory/monitor failure | Existing veto remains mandatory |

Only the five named missing macro/commodity coverage codes may be waived. Every candidate/contract's immutable event-calendar evidence records policy identity, actual missing codes, waived codes, surviving blockers, source snapshots and observed time. Missing evidence is `EVENT_DATA_UNVERIFIED`, never `CLEAR`/verified by inference. Status exposes the approved policy; optional paid-provider configuration is no longer reported as required.

The strategy triggers, parameter pack, risk-account keys, capital, estimated fee assumptions, latency/depth requirements, first-observed quote selection, daily loss/streak controls, correlation/parent constraints, lot sizing, stops, monitoring and exit reducers remain enforced. No strategy-version or account-day reset is used to start with clean counters. Markets still need valid sessions and actual qualified data before a fill; a configured paper policy is not proof that a trade has occurred.

## Measurement and review integrity

- Frozen **fill contract** evidence determines the event cohort, not today's configuration or a later calendar update.
- Read-only SQL reports each policy/evidence cohort separately, alongside a clearly labeled combined account overview. Verified, unverified and old-unrecorded results are never silently relabeled. Empty samples remain unavailable, not zero performance.
- The research partitioner refuses mixed event-policy/evidence cohorts, and the event-qualified validation gate refuses unverified/unrecorded event samples. Descriptive paper P&L is still available for the separate research cohort; this does not promote it to proven edge.
- AI reviews receive the frozen policy and coverage warning before the full position tape. They must disclose missing evidence and cannot attribute a loss to news/IV crush without observations. The AI stays explanation-only and cannot change trading or learning state.
- Existing portfolios and historical state are not rewritten. Combined account risk and realized losses continue to include every event cohort.

## Impact of missing data

A setup can now be admitted near an unobserved announcement. Sudden price moves/reversals, IV contraction and changing spreads can make option outcomes differ materially from a routine session. Premium can lose value after an event even when direction is favorable; the [Options Industry Council's volatility-crush explanation](https://www.optionseducation.org/news/september-office-hours-faqs-volatility-crush%2C-assignment-risk-and-vertical-spreads) describes that effect. The existing modeled IV stress is a hypothesis, not a bound on possible event-driven IV changes.

Net paper P&L arithmetic still uses observed simulated entry/exit quotes, quantity and estimated costs. Missing news does not make the arithmetic itself wrong, but it changes the population of trades and reduces causal interpretation. A news-driven gain can inflate apparent strategy edge; a news-driven loss can obscure it. The magnitude/direction of the effect cannot be predicted without a suitable sample and event labels. Paper execution also cannot prove real queue position, available fills or slippage during a fast event; planned risk is not a guaranteed gap-loss cap.

Use these results to study the explicitly labeled policy, not as evidence that a complete event filter, IV-crush avoidance or real execution was validated. No profitability guarantee is made.


## Free global adapter details

The keyless ShowMyTrades request uses only the fixed documented API, high-impact filter and two-day window. Metadata must have agreeing epoch/ISO clocks within30s of receipt, a generation age below15minutes and a window bracketing the current blackout horizon. Counts, unique IDs, currencies, impact, timestamps and status are validated; malformed/truncated/stale responses invalidate observation. Explicit moved times retain both old/new blackout windows; tentative/disagreeing schedules add a day-level uncertain-time veto. Source failure never establishes no events or complete coverage.

The existing refresh path coalesces requests. It normally refreshes within15minutes and may retry near expiry no faster than once per minute; failed reads back off15minutes. A ten-second deadline, one-megabyte cap and no redirects apply. Snapshots persist before qualification and expire by the source-generation horizon. Full parsed source snapshots are stored once; fill tapes retain compact immutable IDs, hashes, validity/window times and counts rather than republishing the entire feed. Free-source fields remain untrusted evidence for explanation-only AI.

## Final validation

Clean full server suite:1,947 passed with5 existing skips using two test workers. Full web suite:176 passed. Analytics suite:65 passed. Both production builds and final server typecheck passed. The first parallel build/test run completed all assertions but encountered a Vitest worker-RPC timeout; the isolated bounded-concurrency rerun completed cleanly. No assertions, timeouts or production limits were weakened.

Integration checks exercise real shared-feed quote arrival through contract selection, approved missing-event admission, frozen risk and durable entry/exit; a known blackout appearing at arrival still refuses the fill. Actual source parsing, source failure/clock/expiry/persistence behavior, read-only cohort aggregation, unchanged historical state/counters, retained issuer/unit/quote controls, AI disclosure, mixed-cohort refusal and UI warnings/labels are covered. The actual ShowMyTrades sample returned three current reported events and passed the parser; production transport access is verified separately after deployment.
