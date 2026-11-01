# Operational activation qualification

Updated 1 November 2026. This replaces the 31 October operational handoff's mandatory paid-calendar configuration step. It does not rewrite historical evidence or change trading rules.

## Current paper scope

The user approved INR500,000 virtual capital and forward paper research in the requested NSE index, NSE F&O stock, BSE index and four MCX commodity option scopes. All four new strategy hypotheses are configured; entry eligibility remains dependent on actual source, contract, event, risk and monitoring checks. This is not evidence that every market is trading or that any strategy is profitable. Live execution remains excluded.

BSE policy is approved at1–10 sessions/no0DTE/max1% spread. MCX policy is approved at3–15 sessions/exclude final2/max1.5% spread. Do not ask for those parameter approvals again or reset account counters.

`PAPER_EVENT_UNVERIFIED_V1` allows missing complete macro/commodity-calendar coverage for labeled paper research. No paid calendar credential is required for that policy. Known fresh blackouts/uncertain event times, issuer/results/actions, verified units/quotes, risk and exits remain mandatory. Optional paid credentials cannot substitute for verified coverage. Event-unverified, verified and historically unrecorded results stay separate.

## Observing operations automatically

The existing startup calendar preflight records current public-source results. The operational-evidence reporter prepared in the next-phase branch adds change-only readiness observations to existing worker scan callbacks. Platform logs can then show market-session state, recovery/monitor/scanner flags, entry arming, market blockers, observed-book counts and source response codes without logging credentials, quotes, contracts, raw errors or source payloads.

At most one changed snapshot per worker per minute is emitted. Changes during that interval coalesce to the latest state at the next existing scan; unchanged state is suppressed. This is sampled operational evidence, not a complete transition history. No new timer, database query/write, subscription or broker request is added. Logging failure cannot change trading or exit decisions. Slow/stalled scanning can delay these observations; the existing supervisor/readiness checks remain separate. A reporter log is not an authorization or second source of readiness truth.

Use the authenticated Paper Trades status for the current detailed view. PR90 added recorded first/latest ledger checks; PR91 adds market/strategy/event-cohort session coverage. Both use explicit missing/inconsistent evidence and bounded newest100 samples. Do not bypass authentication to fetch them or claim they were inspected without an authorized session.

## Unresolved MCX unit evidence

Angel's generic instrument/response documentation and official socket decoder describe lot/quantity fields, but do not establish the current product-specific relationship among broker order quantity, premium quotation exposure and socket-depth quantity basis. Quantity layout alone cannot clear `BLOCKED_MCX_BOOK_QUANTITY_UNITS`.

Required evidence is current broker-specific documentation or independently corroborated exact-contract observations, recording product/schema/effective dates and reconciling depth units to broker lot quantity and premium multiplier. An integral multiple, large book or matching fields from the same feed is insufficient. Another broker's units cannot establish Angel's units. Raw MCX metadata remains unverified; no flag is promoted by these operational reports.

## Completion evidence still needed

During an actual applicable session, verify authenticated current readiness, exact instrument/source epochs, fresh eligible quotes and full-size depth, current event evidence and monitored account/legacy risk. Let the existing engine decide whether a candidate fills. Entry-only, pending and completed lifecycles must stay distinct. Capture newly observed entry/exit records, costs and event cohorts; do not manufacture trades or restore deleted PostgreSQL history.

A supported session date and consistent internal ledger do not prove full tape capture, independent units/model calibration, actual broker execution, actual charges, statistical independence or trading edge. Keep performance unvalidated until the predeclared cohort/holdout evidence criteria are met. Missing external evidence is not solved by another deployment.

No local installation, paid purchase, live order or message to broker/support is authorized by this handoff.

## Next-phase validation

Server suite1,965 passed with5 existing skips; server production build and typecheck passed. Projection/redaction, changed-state coalescing, cooldown, clock rollback, emitter failure and immutability tests pass. Worker lifecycle tests verify automatic closed-market evidence and recovery-failure evidence while retaining the existing two-timer limit, no weekend provider work, held-watch priority and MCX quantity veto. This operational reporter is prepared in a separate draft PR; it is not part of PR91's production release.
