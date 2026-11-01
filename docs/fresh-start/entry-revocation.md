# Entry activation rechecks during transactions

Next-phase review after PR93 merge,1 November2026. This concerns new paper risk during a worker shutdown or entry-readiness withdrawal; it does not change the strategy hypotheses or held-position exit rules.

## Reproduced defect

`FreshPaperStore.enter` checked its activation callback before beginning a transaction, then awaited portfolio/account locks and several reads/writes. Activation withdrawn during those waits was not checked again. Real PGlite regression cases revoked the callback after portfolio-lock acquisition, candidate insertion and entry-event insertion. All three initially returned a fill instead of refusing it.

## Fix

Entry activation is checked again immediately after the portfolio lock and after staging the entry event, before returning the transaction callback for commit. A private typed exception aborts the transaction; only that exception becomes `PAPER_DISABLED` after rollback. Other storage failures continue to propagate. A refusal at these checkpoints leaves no partial new account, candidate, parent reservation, position or entry event. A later authorized retry can enter normally.

Each production worker's store also requires that specific worker instance to remain unstopped, in addition to the existing global readiness/approval check. Replacement workers can re-arm shared readiness without authorizing the old worker's outstanding entry work.

Existing filled positions are never deleted or retroactively cancelled. Exit observation/recovery remains independent of the entry switch. Account counters, historical records, strategy versions, units/events/quotes, risk amounts and fee policies are unchanged. No new table, timer, service, dependency or broker call is added.

## Boundary

These are local permission checks at explicit transaction boundaries, not a distributed revocation lease or cancellation of a commit already in progress. Revocation after the final check cannot retroactively undo a completed/committing fill; recovery and held-position monitoring remain required. This patch does not claim to solve database-lock quote aging, complete event coverage, independent MCX depth units, market-session validation or profitability.

## Verification

The regression cases exercise the real PGlite transaction and assert rollback across all five affected tables, then prove an authorized retry works. Worker coverage verifies that shared readiness re-arming cannot revive an old stopped worker. Existing tests retain duplicate-delivery handling, storage-error rollback, portfolio serialization, cross-session exposure, disabled-entry exit fills and the executable adapter entry-to-exit path.

Final checks: server1,972 passed with5 existing skips; focused store/worker/adapter24 passed; server production build passed. PR93 deployment `5123c067-5102-4cfe-9b85-6b609e60ba5e` reached Railway SUCCESS; Vercel web succeeded. Live readiness returned HTTP200 at `da7ba2e` with database/Redis/schema/broker authentication true, and the operational log showed recovered monitoring/scanning with entries blocked outside session. The unused Vercel server check remains failed. This transaction fix is prepared separately from that production release.
