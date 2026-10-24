# OB1 / OF1 entry confirmation experiments

Base: `b1282311809c5f1234e0fa35820bb77031b559a3` (deployed PR #58).
Definition: [definitions_entry_confirmation.json](definitions_entry_confirmation.json),
with [SHA-256](definitions_entry_confirmation.sha256). Engine EXP-4.0;
experiment ENTRY-CONFIRM-1.0. Exploratory, not evidence of profitability.

## Behavior

The current production paper-entry rules, prices, sizing, stops, targets,
arbitration and exits remain unchanged. Additive observation fields carry the
closed-bar evidence into the isolated experiment engine. Nothing in production
reads experiment results. The four new arms use `experiment_*` tables only;
they cannot mint production trades or submit broker orders.

| Arm | Entry condition | Comparator |
| --- | --- | --- |
| OB1C | Existing first-touch OB1, OB-2.0 | Control |
| OB1J | The same retest candle closes strictly above the block top for bullish, strictly below its bottom for bearish | OB1C |
| OF1C | Current aligned OF1-1.2 | Control, separate from old OF1R history |
| OF1G | At least one pressure measure (DELTA / IMBALANCE) and one response measure (ABSORPTION / directional POC movement / ACCEPTANCE) | OF1C |

The existing OF1 minimum-two-evidence rule still applies. The groups diversify
the evidence but are not statistically independent; all flow remains inferred.
The PR does not make the feed exchange-exact or improve the candle-close basis
estimate. Missing, wrong-version, invalid or direction/time-mismatched evidence
cannot open a new research position.

OB1J is a **same-bar filter**, not a delayed-entry strategy: it does not wait for
a subsequent candle. Equality at the block edge fails the extra rule. The
recorded entry delay is the position's timestamp minus the decision candle's
close; it does not claim to measure a hypothetical later confirmation fill.

## Comparable execution and coverage

The candidate universe is the enabled OB1/OF1 intraday 15-minute **paper-stage
routed stream**, after the existing router's session, geometry and cost checks.
It is not every raw detector signal. The research hook is fire-and-forget and
its results are never read back by production.

A source candidate is built once for the eligible arms using the existing
side-effect-free production contract builder. When both arms enter, they share
the option, quote, entry, initial stop, target, one-lot size and costs. Each arm
has its own slot, cooldowns and positions, then uses the same trailing and
trigger-family exits. Existing Indicator/A3R/OF1R definitions and historic
readers are preserved. New OF1C/G are not pooled with pre-alignment OF1R results.

Two ledgers remain separate:

- Official paper: existing mid-entry / target / observed-exit policy, estimated
  round-trip costs deducted.
- Quote-based simulation: executable ask entry and bid exit with existing
  freshness/depth requirements; fees deducted, spread represented in fills.
  NOT_OPENED, unresolved and pending records never masquerade as closed returns.

`OBSERVE` rows record each new arm's rule result before its slot, cooldown or
contract-build gates, including rejected candidates and held slots. The existing
TAKE/SKIP records explain actual execution. Observation writes retry on a later
recurrence if they fail; the unique database key makes normal repeats idempotent.
Concurrent builders recheck whether a candidate was taken before opening it.
Persisted open and recently closed positions restore deduplication after restart.
New-arm state writes use immutable snapshots in order, so a slow OPEN write cannot
overwrite a subsequent CLOSED state.

The Order Flow diagnostics panel and API show:

- Observed / passed / filtered / missing-evidence counts and position count.
- Closed, open/pending and unavailable outcomes for each ledger; net average R,
  total net R, closed-trade win rate and realised drawdown in R.
- Estimated cost R and recorded decision-to-entry delay, with null when absent.
- Filtered candidates matched to control positions: missed net winners, avoided
  net losers, flat returns, pending outcomes and candidates without a control
  position. No-control outcomes remain unknown, not losses.
- OF1 evidence combinations and their control outcomes, including sample sizes.

Returns include costs. Drawdown is realised closed-trade R, not mark-to-market
or account-equity drawdown. Comparisons are scoped to the requested instrument
and inclusive-since/exclusive-until observation/entry window; closure may occur
later. A very narrow boundary can exclude an observation while including its
subsequent entry, so use complete session windows for comparisons. Different
arm slots/cooldowns can produce different position streams; the rejected-control
comparison explicitly reports the portion with available outcomes.

## Executed validation — 24 October 2026

| Check | Result | Evidence |
| --- | --- | --- |
| Server suite | 1,704 passed; 5 existing skips | [server-tests.txt](entry-confirmation-evidence/server-tests.txt) |
| Web suite | 114 passed | [web-tests.txt](entry-confirmation-evidence/web-tests.txt) |
| Server / web typechecks | Passed | [server-typecheck.txt](entry-confirmation-evidence/server-typecheck.txt), [web-typecheck.txt](entry-confirmation-evidence/web-typecheck.txt) |
| Server dependency build | Passed | [server-build.txt](entry-confirmation-evidence/server-build.txt) |
| Production candidate parity | 918 scenarios, 203 candidate outputs, unchanged except additive research metadata | `entry-confirmation-parity.test.ts`, frozen baseline JSON |
| SQL compatibility and report arithmetic | Real migration 045 in PGlite; no migration required; old versions preserved/excluded | `entry-confirmation-report.test.ts` |
| Runtime behavior | Duplicate polls, concurrent builds, observation retry, ordered persistence, restart recovery, dedicated stop/drain | `entry-confirmation-engine.test.ts` |

The 37 added server tests and 3 UI tests include bullish/bearish and CE/PE,
strict edge equality, invalid/missing evidence, wrong direction/version,
same one-lot quantity and independent cost calculations. For entry 100, stop
80 and target 140, the official return after a 2% cost is
`(140 - 100 - 2) / 20 = 1.9R`. With ask entry 101 and fees 1 per unit,
the simulated limit-target result is `(140 - 101 - 1) / 20 = 1.9R`.
The SQL example independently verifies `(1.9 - 1.1) / 2 = 0.4R`, with one
pending outcome and one no-control candidate kept out of that average.

The parity oracle was generated by extracting the **old** routing file from the
base SHA, not by accepting current outputs. It uses frozen real OHLC for NIFTY,
BANKNIFTY and CRUDEOIL, with no flow and synthetic buy/sell footprints. It is a
regression comparison, not a historical OF profitability backtest. Its chain is
null (cost-unavailable path); quote, fee and one-lot execution arithmetic is
covered separately by the rule/engine tests. Baseline
generation passed after reducing the initial exhaustive run to sampled prefixes
(the first run exceeded its 30-second test timeout).

To reproduce the oracle, from the repository root:

```sh
git show b1282311809c5f1234e0fa35820bb77031b559a3:apps/server/src/services/order-flow-candidates.ts > apps/server/src/services/order-flow-candidates.baseline.ts
ENTRY_GENERATE_BASELINE=1 npm test --workspace=@fno/server -- src/services/__tests__/entry-confirmation-parity.test.ts
rm apps/server/src/services/order-flow-candidates.baseline.ts
npm test --workspace=@fno/server -- src/services/__tests__/entry-confirmation-parity.test.ts
```

Logs retain test results; trailing whitespace is normalized for clean diffs.
Passing local tests do not establish production activation, live data availability
or improved performance. No forward results have been collected for these arms.

## Activation, rollback and limits

New-arm entries default on when the existing experiment engine and new-entry
switch are enabled. Actual activation is stored on first engine start after
deployment. `ENTRY_CONFIRMATION_EXPERIMENTS=off` pauses only the four new arms'
entries/observations; existing positions continue to receive exits. Old experiment
arms and production paper trading continue normally. There is no auto-promotion.

No schema migration, destructive backfill or record deletion is needed. Historical
trade/configuration fields remain compatible; the dashboard's new field is
optional for older backend responses. Before reverting to a binary without the
four new arm readers, pause their entries and verify both ledgers are drained.
Use the existing `experiment-rollback-check` workflow with the running server's
entries paused; unresolved records need review rather than an invented close.

Runtime costs increase by up to four research slots per symbol and their writes.
Quotes/subscriptions are shared, and no new historical-data feed was added, but
OB1 control/variant contract builds and free research slots can add option-build
work. Observe resource use after deployment. Existing experiment-engine limits,
including non-transactional persistence on abrupt failure and fresh-trigger
deduplication across process restarts, remain; this is not an exactly-once or
multi-replica execution engine.

Controlled validation should check activation timestamps, observation coverage,
same-candidate pricing, restart/no-duplicate behavior and costed outcomes during
open sessions. Choose any promotion only after reviewing enough paired data and
coverage across sessions; this PR deliberately sets no automatic profitability
threshold and claims no expected improvement.
