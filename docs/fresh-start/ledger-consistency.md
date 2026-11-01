# Next phase: recorded paper-ledger consistency

Started 1 November 2026 after PR89 deployed as `6d84254`. Production readiness returned HTTP200 with database/Redis/schema/broker authentication healthy; Vercel web and Railway succeeded. The startup log confirmed `PAPER_EVENT_UNVERIFIED_V1` with missing macro coverage allowed and live orders disallowed. The keyless global feed observed six reported events and persisted snapshot `6303a6c985f8e0c42a54f6849b7abc30682c02e83960e7b3e63ed18011d274c4`. These observations have time-limited validity; they do not prove that a market-session entry/exit has occurred. The pre-existing unused Vercel server check remained red and was not misreported as passing.

## Implemented

The authenticated, read-only fresh-start status now includes a **recorded-ledger consistency** report for the newest100 current-strategy-version positions. A single bounded SQL statement selects at most101 positions, then uses existing `(position_id,revision)` unique indexes to join the entry event at revision0 and the latest revision. The extra row only detects sample truncation. It does not scan every intermediate tick/observation, request quotes, evaluate a strategy, write data or add a timer, subscription, dependency, table or migration.

Each record is labeled:

- `CONSISTENT`: the applicable recorded checks agree. An open record is entry-only, not a completed lifecycle.
- `INCOMPLETE`: required historical proof is missing or malformed. No quote, fill or profit is reconstructed.
- `INCONSISTENT`: recorded values conflict or violate the checked frozen-entry invariants.

Checks compare identity/status, frozen source/contract/lot/multiplier, entry latency and quote eligibility/depth, ask-plus-tick premium, immutable quantity/initial risk/stop/cost, reserved premium/risk and the approved0.25% planned-risk cap against the recorded entry request. Known event-policy warnings are not automatically defects; changing their frozen policy/class or losing that proof is disclosed.

Closed rows require terminal exit evidence, a matching full-size eligible bid, the documented reconnect epoch where applicable, at least250ms after the recorded exit trigger, bid-minus-tick exit price, coherent close times, frozen modeled fees and matching position/SQL net P&L. Pending exits stay pending with no realized P&L; the report does not invent an exit because the target/stop was touched.

The Paper Trades panel separates consistency counts, incomplete proof and inconsistent records, reports closed-versus-entry-only coverage, and exposes per-record event labels and issue codes. Empty and truncated samples are explicit. A status read does not alter trades, account counters, historical labels, source/calendar policy or AI/learning state.

## Limits

This is an audit of the first/latest **recorded** evidence. It does not prove all intermediate observations, duplicate terminal events at other revisions, completeness of first-quote capture, independent contract-unit qualification, fair pricing/scenario calibration, actual broker queue position/fills, actual bills or profitability. The fee comparison uses the frozen modeled fee policy, not a broker invoice. It is not a full admission/model or portfolio-wide loss/pause/exposure replay; the cap comparison uses the frozen entry request's capital. A self-consistent ledger is not proof that the original trading hypothesis has an edge.

Approved event-unverified research remains explicitly labeled and separate in the existing cohort results. Earlier missing event policy remains unrecorded, not retrospectively verified. MCX unit and stock issuer/action entry gates remain unchanged. No entry/exit/risk rule, strategy version, counter or old record is changed by this diagnostic phase.

## Verification

Synthetic corruption cases cover early/stale/wrong-source/insufficient-depth quotes, non-whole quantities, altered multipliers and frozen risk, premium/cap/stop changes, fee/P&L discrepancies, missing exits, reconnect epochs, pending exits, lost event provenance, malformed input and100-row truncation. The existing real PGlite/shared-feed admission→entry→exit test now runs the auditor against the actual durable record produced by those services, retaining the arrival-blackout refusal test. API checks still demonstrate read-only reporting and preserved counters/history. UI checks distinguish no evidence from successful checks and disclose the sample boundary.

Actual market-open paper lifecycle qualification remains pending. This phase's tests and code are not represented as observed production fills.

Final checks: full server suite1,957 passed with5 existing skips; full web suite179 passed; server/web production builds and final server typecheck passed. The lifecycle auditor is in the next-phase branch only; PR89's deployed event policy is reported separately above.
