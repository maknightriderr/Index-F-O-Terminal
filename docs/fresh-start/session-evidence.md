# Recorded market-session evidence

Started 1 November 2026 after PR90 merged as `325c1b44c6557f5d55919c954299fc1b53719f5c`. Railway deployment `fa3bf142-603f-46e9-a66e-ea0aebd4deed` succeeded. The live readiness endpoint returned HTTP200, commit `325c1b4`, with database, Redis, schema and broker authentication healthy. Vercel web succeeded; the previously unused Vercel server project remains a separate failed check.

## Scope

The authenticated status response and Paper Trades panel report session evidence automatically from the same bounded, newest100 current-version ledger records used by the consistency auditor. The existing query now selects the stored session date. No extra database query, polling timer, socket, dependency, migration or writes are introduced.

All four requested market categories remain visible, including markets with no recorded evidence. Unknown/missing frozen market metadata is explicitly unclassified rather than assigned to NSE. Detail rows separate market, strategy, immutable event policy and event evidence class. Missing historical policy labels remain unrecorded.

Each cohort reports entry-only, pending and closed positions, incomplete or inconsistent ledger evidence, session timing not proven, and consistent closed records within the recorded exchange session. A counted session close requires:

- The first/latest recorded ledger checks to be consistent, including recorded entry/exit quotes, costs and P&L arithmetic.
- A real calendar date in a supported calendar year, with an exchange trading session. Row, frozen candidate and entry-request session dates must agree.
- Entry within that session and terminal exit at or after entry and no later than session close. NSE/BSE/MCX calendars use IST, including MCX partial holidays and seasonal close times.

A delayed exit after session close remains recorded and managed normally. It cannot contribute to the within-session count; this report does not modify it or invent a close. A pending exit remains pending. Distinct date lists are per cohort, not a claim of statistically independent samples. The101st selected record only detects truncation; older sessions are explicitly outside the sample.

## Qualification boundaries

This is coverage of **recorded** evidence, not strategy promotion, independent unit verification, full tape capture, pricing/scenario calibration, actual broker execution, actual bills, statistical validation or profitability. An internally consistent record can still come from an unprofitable hypothesis. Existing aggregate performance and event-cohort P&L retain their own scopes; this bounded session table does not replace them.

Today is Sunday; synthetic tests are not represented as production market-session fills. Actual observed session evidence remains pending where no qualifying records exist.

MCX remains blocked by unverified Angel socket-depth quantity units. Broker order quantity, premium quotation exposure and depth quantity basis must be established separately for each applicable product/schema. Generic master lot-size documentation, numeric socket field layouts, divisible quantities or a different broker's observed units cannot qualify Angel depth. No `quantityVerified` flag or unit conversion is changed here. Required next evidence is a current broker-specific definition or independently corroborated exact-contract depth observation, with schema/product/time provenance; the evidence must reconcile book units to broker lot quantity without deriving the answer from the same feed.

BSE and MCX expiry hypotheses have already been approved in later phases; the older Phase9 document describes the approval state at its own historical checkpoint. Missing macro coverage remains allowed only under the approved, labeled paper-research policy. Known blackouts, issuer/action coverage, data quality, risk, depth and exits remain enforced. No account counters, strategy version or deleted history are changed.

## Verification

Tests cover empty and entry-only evidence, separate markets/strategies/event policies/classes, repeated dates, missing labels, unknown markets, malformed/nontrading/unsupported dates, timing outside the session, corrupt P&L, missing proof, read-only input and100-record truncation. The real PGlite/shared-feed adapter entry-to-exit test checks the session report against the actual durable ledger record it produces; its known-event arrival blackout refusal remains enforced. UI checks cover missing evidence, pending exits, event labels, excluded metadata, sample limits and older API compatibility.

Final checks: server1,961 passed with5 existing skips; web182 passed; shared/server/web production builds and server typecheck passed. This next-phase implementation is prepared separately from the already deployed PR90.
