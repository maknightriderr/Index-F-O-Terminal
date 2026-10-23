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

## Corrections

- **EXP-3.0's `arbitration_losses`.** The comparison relied on the recorded `arbitrationRole`. That is null for OF1, because order-flow candidates carry no router arbitration. EXP-3.1 replaces it with a join to production's trades on the candidate id.
- **"All nine far-target A3 trades lost" (said 23 Oct) was wrong.** The diagnosis doc and the chat summary said it; the frozen hypotheses file never did. Of the 9 A3 option trades with rToT1 ≥ 1.5:
  - none reached target;
  - net −2.90R;
  - **7 lost and 2 won, both at session end:** KPITTECH `f234cd97` +1.27R and NAM-INDIA `e0174aef` +0.10R.
