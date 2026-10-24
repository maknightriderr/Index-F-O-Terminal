# OB reaction chronology and OF1 price alignment

Base: `804c0c7a11e683db15f5360a4933eb8b04e406f0` (PR #57).

## Result

Two independently reproduced defects are corrected. OB1 entry rules stay
OB-2.0; reaction measurements are OB-2.1. OF1 is now OF1-1.2, with a new paper
logic stamp. No profitability improvement is claimed.

### OB reaction

The old `held` calculation used the best move across eight bars even after
the block failed. The corrected calculation considers achievement only through
the mitigation close. A 1-ATR high/low on the mitigation candle precedes that
close and counts; a later recovery does not. Failure on the first-touch close
cannot become held later. MFE/MAE still describe the full eight-bar observation
window; they are not stop-limited trading returns.

OB detection, first-touch signals, entry geometry, parent identity and source
version stay OB-2.0. New measurement rows use OB-2.1 under the existing
versioned unique key; old rows are not overwritten. The dashboard selects
OB-2.1 reactions so the same block is not counted twice across versions.

### OF price reference

NSE strategy candles and levels stay in **spot** space. The footprint remains
raw futures data in storage. Each aligned read uses:

`basis(bar) = matching futures candle close - matching spot candle close`

`aligned price = raw futures price - basis(bar)`

Volume, delta and imbalance counts are unchanged. Price levels, POC and value
area translate together before acceptance, absorption and profile-level reads.
This is explicitly `BAR_CLOSE_BASIS_ESTIMATE`, not tick-exact alignment; basis
variation within the candle remains an approximation for forward validation.

MCX stays in futures price space with `SAME_CONTRACT` proof and zero translation.
The join verifies exchange, underlying and expiry across providers, then the
exact Dhan instrument on each footprint. Missing, stale, duplicate, invalid or
unclosed candles, missing contract identity and rollover mismatches are
unavailable. Double alignment is refused. No current quote or previous candle
substitutes for a missing basis.

On rollover, the store drops the mixed partial bar and preserves identities on
older closed bars. Database reloads retain the existing instrument field.
Unidentifiable historical rows stay readable but cannot be used as aligned flow.

Paper and shadow require alignment and use the same taped input boundary. A
dedicated completed-bar cache cannot truncate other engines' history. No flow
means no extra instrument/history request. NSE history is an additional cached
broker dependency; rate limits or missing history can reduce OF1 candidates.
MCX alignment does not fetch another candle series.

Alignment evidence is stored with shadow candidates and decision tapes. The
dashboard exposes last-evaluated alignment status separately from feed connectivity,
labels the estimate, and selects OF1-1.2 summaries. Old paper trades and prior
versions remain stored. Existing exits, sizing, selection and arbitration code
are unchanged; corrected OF1 candidates can legitimately change slot winners.

## Executed validation (24 October 2026)

| Check | Actual result | Evidence |
|---|---|---|
| Server full suite | 1,667 passed; 5 pre-existing historical-data skips | [server-tests.txt](ob-of-validation-evidence/server-tests.txt) |
| Web full suite | 111 passed | [web-tests.txt](ob-of-validation-evidence/web-tests.txt) |
| Server/web typechecks | Passed | [server-typecheck.txt](ob-of-validation-evidence/server-typecheck.txt), [typechecks.txt](ob-of-validation-evidence/typechecks.txt) |
| Railway-equivalent server dependency build | 3 packages successful | [server-build.txt](ob-of-validation-evidence/server-build.txt) |
| Independent original/modified calculation comparison | Both reproduced defects corrected, bullish and bearish | [before-after.json](ob-of-validation-evidence/before-after.json) |
| Frozen real OHLC comparison | 306 prefixes, 20 OB signals, zero signal changes | Same comparison JSON |
| Database compatibility/aggregation | Old rows preserved; new rows and filtered totals correct in PGlite | `ob-of-measurement-versions.test.ts` in full suite |
| Live production/historical OF performance replay | Not run; no profitability conclusion | Requires recorded paired data and open-session validation |

Console logs have trailing whitespace normalized only.

The first full-suite run passed 1,664 tests but failed one old logic-version
expectation. That expectation was updated for the intentional OF1 stamp change;
two more service-boundary tests were added and the final suite passed. The initial
log is retained as [server-tests-first-run.txt](ob-of-validation-evidence/server-tests-first-run.txt).

New regression coverage includes bullish/bearish failure/recovery ordering,
same-candle close semantics, eight-bar expiry, positive/negative basis, the false
acceptance reproducer, invalid/unavailable data, rollover, database reload, MCX
identity mapping, genuine confirmations, immutability, recorded-input replay,
version-separated SQL aggregation and dashboard compatibility.

Run the independent comparison from the project root:

```sh
node --import tsx docs/experiments/compare-ob-of.mjs /path/to/base-worktree
```

The base worktree must be the base commit above. The script records source hashes
and fails if expectations or OB signal parity differ. It does not simulate
historical OF profitability. Old tapes without alignment inputs report divergence
rather than use current data.

## Rollback and controlled validation

No schema migration or destructive backfill is needed. Reverting the PR restores
the previous reader/writer versions; old rows remain present. `OF1_TRADING=false`
stops new OF1 paper entries while keeping shadow measurement, and
`ORDER_BLOCK_MODE=SHADOW` stops OB1 paper entries if needed. These switches do not
liquidate existing records. Existing open trades keep the original exit machinery.

For controlled paper validation, first verify source commit and readiness, then
check matching NSE candle/contract availability, MCX contract identity, alignment
metadata, new-version dashboard cohorts and duplicate prevention during an open
session. Evaluate signal changes and net outcomes separately from correctness.
