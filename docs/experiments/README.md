# Paper experiments: frozen definitions and reports

These are the paper experiments (no broker execution).

- **Experiment definitions and hypotheses** are frozen. Each is checked against its `.sha256`, and every report refuses to run if the file has changed.
- **To change an experiment**, add a new version file and new arm versions in code. Never edit a frozen file.
- **Superseded arm versions** keep their activation rows. Positions opened under them finish under their own rules.
- **Production data** (CSV exports) stays outside the repo. The reports take export paths as arguments.

| File | Version | Arms | Activated (IST, `experiment_arms`) | Commit | sha256 |
|---|---|---|---|---|---|
| `definitions.json` | EXP-1.0 | Baseline-trade filtering study, not independent arms | frozen activation 2026-10-26 09:00 | n/a | `8356a74c…` |
| `definitions_exp2.json` | EXP-2.0 | R0, A, B, C, V2 (Old Indicator) | 2026-10-23 10:50:41 | d80c0c3 | `edef0d10…` |
| `definitions_exp3.json` | EXP-3.0 | A3R `A3-R0-1.0`, OF1R `OF1-R0-1.0` | 2026-10-23 15:20:07 | 133b82e | `10a1dc3f…` |
| `definitions_exp3_1.json` | EXP-3.1 | A3R `A3-R0-1.1`, OF1R `OF1-R0-1.1` | written at first start after deploy | (this PR) | see `.sha256` |
| `hypotheses_a3_of1.json` | A3-OF1-HYP-1.0 | Pre-registered A3 / OF1 hypotheses | frozen 2026-10-23 15:00 | n/a | `d0afcd03…` |

## Reports

| Report | Covers | Run with |
|---|---|---|
| `experiment_report.py` | EXP-1.0 | `python experiment_report.py <trades.csv> [<observations.csv>]` |
| `exp2_report.py` | EXP-2.0 | `python exp2_report.py <positions.csv> [<arms.csv>]` |
| `exp3_report.py` | EXP-3.0 and 3.1, each version apart | `python exp3_report.py --positions … [--arms …] [--decisions …] [--trades …] [--of1 …]` |

## Reading the reports

- **Session minimums** in the hypotheses are review checkpoints, not proof of profitability.
- **Below a checkpoint**, a result is reported as inconclusive, with its counts.
- **Unvalued positions** (open, pending, unresolved or not opened) are counted and never given a return.

## Ledger fixes

These are software fixes; no frozen definition or trading rule changes. Rows written before a fix keep their values. Positions carry `simVersion` (absent = SIM-1.0), and ledger rows carry `ledger_version`, so the two are reported apart.

**SIM-1.1 / LEDGER-1.1 (2026-10-23)**

- **MCX book sizes are in lots.** The frozen rule asks for "size ≥ 1 lot", but 1.0 compared the MCX book (in lots) with the quantity (in units), so all 40 MCX simulated entries on 23 Oct were NOT_OPENED SIZE_INSUFFICIENT.
  - *Evidence:* every NSE/BSE size (420/420) is a multiple of the lot; every MCX one (80/80) is below one lot.
  - *Fix:* `book-units.ts` converts MCX sizes to units, in the experiment simulation and in the paper execution ledger alike.
- **Session-end fills use the last two-sided quote.** The frozen rule says a quote from the final 10 minutes may fill, but 1.0 looked only at the last quote, usually a book-less tick.
  - *Fix:* 1.1 also tries the last two-sided quote from that window.
- **Block reasons are kept.** The reasons a pending exit could not fill are counted (`sim.pendingBlocks`) instead of overwritten.
- **Opens are stamped at their entry quote.** A position is stamped, and its entry fill judged, no earlier than its own entry quote's receipt.
  - The poll clock starts before the contract build: a median 17 s, up to 98 s, earlier.
  - That made 3 positions on 23 Oct appear to overlap their slot (MOTILALOFS in R0, A and V2). It also let a bar closing in that gap count as "after entry".

## Strategy corrections (2026-10-23, PR #56)

Each correction has its own version boundary. Rows written before it keep their version and values.

### FAMILIES-1.1: trigger trades (A3, A6, OF1, …)

A correctness fix to the trade geometry. No trigger rule changes.

- **The fix:** the option stop distance, target move and entry-validity check are measured from the live spot the option is bought at, to the setup's own unmoved stop and T1. S1 is unchanged.
- **Timing:** the spot and the option quote come from the same chain build (spot cached ≤ 5 s, chain ≤ 10 s).
- **Recorded:** `entry` stays the setup's decision close; `fillSpot` is the live spot; `remainingRToT1` is the R left at entry.
- **Established on 9–23 Oct:**
  - 14 of 53 A3/OF1 trades drifted ≥ 0.25R between the decision close and the entry;
  - 0 of 53 were entered with live price already past the stop or T1, so the validity check would have refused none of them.
- **Unknown:** the historical profitability impact. The changed premium targets and stops, and any new UNREALISTIC_TARGET refusals, cannot be replayed without option quotes.

### OF1-1.1: ACCEPTANCE requires the bar to have traded at the level

A semantic correction.

- **The intended meaning** (ARCHITECTURE.md §6e, of1.ts) is location + a close *back* beyond the level + flow. Acceptance means volume accepted on the reversal side of a level the bar interacted with.
- **What 1.0 did:** a bar that only came within the 0.25-ATR location tolerance never traded at the level, so its volume was above the level by construction. 1.0 counted that as ACCEPTANCE: 113 of 117 such near-tests.
- **What 1.1 does:**
  - ACCEPTANCE is measurable only when the bar traded at or through the level.
  - A near-test stays a valid location, recorded as `levelInteraction: NEAR_TEST` and described as a hold, never a reclaim.
  - The flow is labelled `flowBasis: INFERRED`: the trade side is inferred from trade prices, never observed.
- **Affected opportunities:** 31 of 266 recorded candidates no longer qualify; none of the 28 OF1 trades.
- **Potential downside:** those 31 graded +0.47R (candidate-level 90% CI +0.08 to +0.87, 24 graded, 5 exchange-sessions), against −0.16R for the rest. The correction may remove the best-graded subgroup. That is not a reason to keep an incorrect confirmation, and it is not evidence either way about a correctly named near-test rule.

### IND-V2-INVALIDATION-1.1: an invalidation retires its setup

- **The change:** after a structural invalidation exit, an entry leaning on the *same* structural level, in the same direction, is refused (INVALIDATED_SETUP). It re-arms when a closed 15m bar closes back on the trade side of that level.
- **What is not changed:** no cooldown; R0/A/B/C untouched. 1.0 is kept in `RETIRED_ARMS`, and its positions finish under it.
- **Identity:** the Old Indicator has no setup lifecycle of its own. Its candidate id is shared by every entry on a symbol, direction and day, so the setup's identity is the level it leans on: kind + price, with VWAP matched by kind.
- **Limitations:**
  - VWAP setups cannot be told apart from each other within a session.
  - Re-arming uses the level's price at invalidation.
  - After a restart, a retired setup waits for the next closed bar.
- **On 23 Oct:** 1 re-entry leaned on its just-broken level (NATURALGAS 260: invalidated 11:17, re-entered 11:56, +0.32R). Whether a closed bar reclaimed 260 in between is not in the stored data (the 23 Oct bar archive is written after the session), so whether 1.1 would have blocked it is undetermined. The other 5 same-poll re-entries leaned on a new level and are not blocked.

## R0 is a control, not production

R0 replicates the Old Indicator's rules inside the engine. It omits production's TRIGGER_REVERSAL: in production, an opposite claimed S1 fill or momentum trigger closes a held Old Indicator trade.

That omission applies to R0, A, B, C and V2 alike. Arm-vs-R0 is therefore a like-for-like comparison inside the engine, never an exact production comparison.

## Corrections

- **EXP-3.0's `arbitration_losses`.** The comparison relied on the recorded `arbitrationRole`. That is null for OF1, because order-flow candidates carry no router arbitration. EXP-3.1 replaces it with a join to production's trades on the candidate id.
- **"All nine far-target A3 trades lost" (said 23 Oct) was wrong.** The diagnosis doc and the chat summary said it; the frozen hypotheses file never did. Of the 9 A3 option trades with rToT1 ≥ 1.5:
  - none reached target;
  - net −2.90R;
  - **7 lost and 2 won, both at session end:** KPITTECH `f234cd97` +1.27R and NAM-INDIA `e0174aef` +0.10R.
