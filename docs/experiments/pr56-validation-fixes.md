# PR #56 independent-review follow-up

Base: `1a673dca26b8f2b0aaff24bb5f0ddcae8879ea4f` (merged PR #56). This patch addresses the four review findings together. It does not rewrite historical trades, change OF1 acceptance rules, tune profitability, or deploy anything.

## Changes and exact references

- **Premium risk:** [`buildNakedLong` and `validNakedLongGeometry`](../../packages/analytics/src/trade-setup/index.ts) reject nonfinite prices/moves, malformed depth, invalid positive-integer lot sizes, invalid tick sizes, and a caller stop outside `(0, 0.45]`. A required stop beyond the ceiling is refused rather than silently tightened to admit the contract. Both stop-cap branches now use the unconditional 45% ceiling. Final recorded levels must satisfy `0 < stop < entry < target`; the cap permits only half a cent of the existing two-decimal rounding error. No change to the 2% capital-risk or 5% premium-budget defaults.
- **Expiry fallback:** [`buildStructureContract`, `structureChainGeometry`, `resolveStructureSetup`](../../apps/server/src/services/market-bias.ts) recalculate distances and check the sequence on each chain's spot before selection, including the next expiry. Target projection, structural stop, comparison risk, final `fillSpot`, `remainingRToT1`, classification detail, shadow models and refusal snapshots use the selected geometry. The original decision entry/stop/T1 stay recorded and unchanged. S1 keeps its confirming-close reference.
- **Missing/invalid spot:** [`structureEntrySpot`](../../apps/server/src/services/market-bias.ts) never substitutes a historical close for a trigger's invalid live spot. [`structureSequenceRefusal`](../../apps/server/src/services/structure-live.ts) rejects missing/nonfinite/nonpositive geometry and exact stop/T1 boundaries. [`buildOptionChain`](../../apps/server/src/services/option-chain.ts) rejects nonfinite underlying prices.
- **Final guard:** [`preMintCheck`](../../apps/server/src/services/slot-arbitration.ts) validates premium geometry, lot size, identity, quote timestamp, expiry match and finite two-sided prices. Each production deferred entry carries its selected chain; experiment candidates stamp the selected expiry before checking it. This closes the previous fallback-expiry quote-check bypass.
- **V2 rollback:** [`experimentEntriesEnabled` / `onIndicatorPoll`](../../apps/server/src/services/experiment-engine.ts) add `EXPERIMENT_NEW_ENTRIES=off`. Existing quote, invalidation and session monitoring remain active. The flag is rechecked after asynchronous builds. V2 1.0 and 1.1 readers stay present. [`experiment-rollback-check.ts`](../../apps/server/src/cli/experiment-rollback-check.ts) provides a read-only downgrade-readiness snapshot and fails closed on unverified state. An old binary cannot be made to recognize a new version retroactively; use the drain procedure below.

New provenance: `FAMILIES-1.2`, `OPTION-2.1`. No schema migration or historical level recalculation. Existing configuration works with the new switch absent (entries default on).

## Executed evidence

Local verification, 23 October 2026. These are actual executed results, not a coding-agent success claim:

| Check | Result | Evidence |
|---|---|---|
| Server suite: `npm test --workspace=@fno/server -- --maxWorkers=2 --minWorkers=1` | **1,627 passed, 5 skipped; 101 files passed, 2 skipped; exit 0** | [Full output](pr56-validation-evidence/server-tests.log) |
| Server typecheck | PASS, exit 0 | [Output](pr56-validation-evidence/server-typecheck.log) |
| Web typecheck after shared refusal-code addition | PASS, exit 0 | [Output](pr56-validation-evidence/web-typecheck.log) |
| Shared and analytics builds | PASS (`npm run build --workspace=@fno/shared`, then analytics) | Executed before server checks; compiled packages used by the suite |
| Independent before/after stop reproduction, real old/new builders | CE and PE: before entry 100 / stop **-50** / target 130, available; after refused | [Output](pr56-validation-evidence/before-after-premium-stop.log) |
| Rollback CLI without required database/pause settings | Refuses with exit **2**, without a DB connection | [Output](pr56-validation-evidence/rollback-precondition.log) |
| Replay compared field-by-field against PR #56 | Executed indicator trade unchanged; only unsafe watch contracts rejected/re-ranked | [Exact diff](pr56-validation-evidence/replay-field-diff.json) |

The suite adds **117 tests**: 99 geometry/contract cases, 11 downgrade-readiness cases, and 7 entry-drain/restart tests. Relevant test sources:

- [`pr56-validation-gaps.test.ts`](../../apps/server/src/services/__tests__/pr56-validation-gaps.test.ts): real contract builder and real F&O selection/fallback; external broker/cache/database boundaries mocked. Bullish CE and bearish PE; invalid data and boundaries; independent arithmetic; S1 preservation.
- [`experiment-engine.test.ts`](../../apps/server/src/services/__tests__/experiment-engine.test.ts): default/on/off, pause during an asynchronous build, target and invalidation exits while paused, reload of persisted V2 1.0/1.1 state.
- [`experiment-rollback.test.ts`](../../apps/server/src/services/__tests__/experiment-rollback.test.ts): official OPEN, simulated OPEN/EXIT_PENDING, unknown/missing status, fully settled states, legacy reader compatibility.
- [`full-replay.test.ts`](../../apps/server/src/services/__tests__/full-replay.test.ts): real decision path, recorded/replayed I/O and specific watch refusal assertions. Its fingerprint change was investigated against an isolated base checkout, not blindly accepted.
- Existing **316 golden tests**, **23 OF1 tests**, **25 experiment-arm tests**, arbitration and replay tests all pass. The existing cheap-OTM fixture requires `0.36 × 40 / 30 = 48%` premium risk: it is now explicitly expected to refuse, while the valid ATM contract remains selected.

Independent arithmetic example: final underlying spot 110, stop 70 and T1 140 give risk distance 40, reward distance 30, remaining R = 0.75. At delta 0.5 and premium 100, requested premium risk is 20, stop 80. With gamma 0.002 and theta -1, target = `round2(100 + 0.5×30 + 0.5×0.002×30² − holdHours/6.25)`. The bearish case mirrors the underlying levels and still buys a PE, so premium stop remains **below** entry. At the exact 45% ceiling, 75-quantity lots on default capital 500,000 yield `min(floor(10,000/(45×75)), floor(25,000/(100×75))) = 2` lots.

The five skipped tests require absent historical datasets: two event-engine cases, one momentum-harness case, research-no-lookahead, and sweep-close-lookahead. They were also skipped in the pre-change run (1,510 passed / 5 skipped). They are **not** counted as passes.

## Review status after this patch

| Requirement | Status | Basis / limit |
|---|---|---|
| 1. Original defect exists | PASS | Actual old/new builder reproduction and prior review's fallback/invalid-spot failures. |
| 2. Root cause addressed | PASS | Caller cap cannot be bypassed; each selected chain supplies geometry; invalid live spots fail closed. |
| 3. Formulas correct | PASS | Independent delta/gamma/theta, remaining-R and position-budget calculations above; existing golden suite passes. |
| 4. Long/short, CE/PE | PASS | Both underlying directions tested. This builder opens naked **long premium** CE/PE only; opening short-option positions is not applicable. Historical spread exit code is untouched. |
| 5. Edge cases | PARTIAL | Missing/invalid prices, geometry, lot/tick inputs, timestamps and boundaries tested. Real broker tick/lot metadata and order-grid execution were not exercised. Existing paper model's two-decimal thresholds remain; this is not a broker order-routing change. |
| 6. Unrelated strategy behavior | PASS | Golden suite, OF1/V2 tests, base-vs-patch replay diff. Intentional changes are refusal of unsafe contracts and final-expiry geometry/quote validation. |
| 7. Unit/integration/regression tests | PASS | 117 added tests plus complete existing suite; integration uses actual application functions with external boundaries mocked. |
| 8. Executed results available | PASS | Logs committed alongside this report. Five dataset-dependent tests remain skipped. |
| 9. Duplicate trades, exits, oversizing | PARTIAL | Existing arbitration/de-duplication tests and new drain/exit tests pass; sizing budgets independently checked. Multi-process production/broker behavior is not claimed verified. |
| 10. Dashboard/backend/database consistency | PARTIAL | Selected fill fields/classification/refusal snapshots use one geometry, and replay is checked. No live database reconciliation or rendered-dashboard smoke test performed. |
| 11. Backward compatibility | PASS | Additive default-on entry switch; no migration; unchanged historical records; persisted V2 1.0/1.1 reload and exits tested. |
| 12. Rollback | PARTIAL | Drain switch, readiness predicate and failing CLI preconditions tested. Actual production drain/downgrade has not been executed. |

A. **Overall verdict: APPROVE WITH CONDITIONS** for a controlled paper-validation rollout of this patch, after PR review and the deployment checks below. This is not approval to trade live capital.

B. **Confirmed remaining defects:** none confirmed in the four corrected paths by these checks. Existing historical records with negative stops/missing close prices were not rewritten; this patch prevents new invalid entries and does not certify or repair historical ledger data.

C. **Missing tests:** five historical-data cases; real broker feed/expiry rollover; live DB/dashboard reconciliation; actual downgrade drill.

D. **Potential regressions:** fewer entries because previously accepted oversized/invalid contracts now refuse; changed fallback strike/ranking/target when spot has moved; older consumers must tolerate the new refusal code. No profitability improvement is claimed.

E. **Required additional work:** supply the historical datasets, perform the controlled deployment smoke/reconciliation checks, and verify the drain procedure against the deployment's database. No further source defect is confirmed by the current suite.

F. **Controlled paper-trading readiness:** conditionally ready for reviewed deployment and observation. No merge, deploy, market session, or live-capital validation was performed here.

## Controlled paper validation and rollback

1. Review the single PR, retain the previous image/commit and a backup, and deploy through the normal controlled paper environment. Verify `FAMILIES-1.2` / `OPTION-2.1` on new decisions. Do not mix old and new version samples in performance comparisons.
2. Check an accepted CE and PE plus a refused over-limit stop. Confirm database/API/UI premium levels and quantity match; compare decision-close entry separately from actual `fillSpot` and `remainingRToT1`. Observe a next-expiry fallback using its own spot/expiry/quote and a boundary-crossing refusal. Watch duplicate IDs and exit completeness, including simulated EXIT_PENDING positions.
3. If rollback is needed, **keep this version running** and set `EXPERIMENT_NEW_ENTRIES=off` on the running server. Keep `EXPERIMENT_ARMS=on`: turning the whole engine off also stops its exits. Recheck after any restart that both V2 versions are loaded and monitored.
4. Wait until both experiment ledgers settle. Do not fabricate fills or manually relabel versions to clear a blocker. With the same database configured, run:

   ```sh
   EXPERIMENT_NEW_ENTRIES=off npm run experiment-rollback-check --workspace=@fno/server
   ```

   `DATABASE_URL` must already be supplied by the deployment's secret configuration. The command never sets the running server's environment. Exit 0 means all returned records are fully settled (official CLOSED and simulation CLOSED/NOT_OPENED); exit 1 means blockers; exit 2 means verification failed. The read-only snapshot is not an atomic deployment lock: keep entries paused and recheck immediately before switching.
5. Only after a clean check may a binary predating V2 1.1 be used. Set `EXPERIMENT_ARMS=off` on that old binary to prevent it restarting the older entry experiment; the new pause variable is unknown to old binaries. Retain the database and historical version labels. For normal rollback to PR #56, note that PR #56 itself retains V2 1.0/1.1 readers but reintroduces the reviewed geometry defects. Follow the existing production-position drain/release procedure as well; this experiment checker does **not** certify production or broker positions.
