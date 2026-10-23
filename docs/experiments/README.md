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

## Strategy corrections (2026-10-23)

**IND-V2-INVALIDATION-1.1** supersedes 1.0, which is kept in `RETIRED_ARMS`. Positions opened under 1.0 finish under 1.0.

- **The change:** a *losing* structural-invalidation exit now blocks the same signal (same symbol and direction) for the existing 60-minute same-side cooldown.
- **Why:** 1.0 re-entered the same move in the same poll it had just invalidated. On 23 Oct that happened 6 times, all at 0 minutes.
- **What stays as it was:** the exchange-wide settle, the day-confidence rule and the direction lock still read stop-losses only, as in production. Entry and every other exit are unchanged.
- **Downside:** on 23 Oct the trades it would have blocked netted +0.32R (first-order, ignoring knock-on). One session; unvalidated.

**FAMILIES-1.1** (production trigger families: A3, A6, OF1, …) is a software defect fix; no trading rule changes.

- **The fix:** the option stop, target move and entry-validity check are measured from the live spot the option is bought at, not the decision bar's close. S1 is unchanged.

## R0 is a control, not production

R0 replicates the Old Indicator's rules inside the engine. It omits production's TRIGGER_REVERSAL: in production, an opposite claimed S1 fill or momentum trigger closes a held Old Indicator trade.

That omission applies to R0, A, B, C and V2 alike. Arm-vs-R0 is therefore a like-for-like comparison inside the engine, never an exact production comparison.

## Corrections

- **EXP-3.0's `arbitration_losses`.** The comparison relied on the recorded `arbitrationRole`. That is null for OF1, because order-flow candidates carry no router arbitration. EXP-3.1 replaces it with a join to production's trades on the candidate id.
- **"All nine far-target A3 trades lost" (said 23 Oct) was wrong.** The diagnosis doc and the chat summary said it; the frozen hypotheses file never did. Of the 9 A3 option trades with rToT1 ≥ 1.5:
  - none reached target;
  - net −2.90R;
  - **7 lost and 2 won, both at session end:** KPITTECH `f234cd97` +1.27R and NAM-INDIA `e0174aef` +0.10R.
