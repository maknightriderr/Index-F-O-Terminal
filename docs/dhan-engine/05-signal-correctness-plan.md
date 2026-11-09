# Signal correctness and paper validation

Baseline: deployed commit `8a34b90`. The 9 November review found no paper fills in the checked summaries, one Gamma candidate rejected by pricing, and no completed Setup E signals. Confirmed software defects and experimental strategy variants are tracked separately.

| Phase | Work | Acceptance |
| --- | --- | --- |
| 1. Input identity | Keep missing OI distinct from zero. Qualify snapshots by expiry, strike and decision time. Reject footprint gaps inside an active setup. Correct absorption row selection and label the detector version. | Both sides pass valid controls and reject missing legs, crossed expiries, future scans and gaps. |
| 2. Paper admission | Keep Gamma confirmation and fill distinct. Enforce its selected strike list. Retry on new eligible observations within the original entry window. Fit parity inside observed quote bands while preserving freshness and exact-future constraints. | Feasible synthetic books qualify, inconsistent books refuse, retries cannot duplicate a fill. |
| 3. Comparison | Compare current Gamma with a frozen range and fresh close, and first-close with one-hold confirmation. Compare Setup E before and after the detector correction on the same recorded inputs. | Report bullish and bearish cohorts separately, with eligibility, confirmation, pricing and fill counts. Treat results without executable option books as signal studies. |
| 4. Remaining strategies | Qualify Setup B history and breadth coverage. Compare Stock in Play pullback and base, Index Breadth generic and OI-wall breaks, MCX trigger-bar and window flow, and one Dhan A–D filter at a time. Keep the seven existing shadow strategies as controls. | Measure early failures, missed winners, entry delay, net R and drawdown against the same parent moves and sessions. |

Release correctness fixes independently of changes to strategy thresholds. Use recorded event and receipt times, freeze reference levels before triggers, and keep quote, cost, size and exit assumptions identical within each comparison. Do not infer trader intent from flow or quotes. Use 30 closed trades and 20 sessions as an initial review point, then test on untouched sessions before making a strategy decision.

The Gamma shadow records the first eligible watch per side in a running process. It compares the first one-minute close with the next contiguous one-minute close holding the level, on the same frozen five-minute range. It uses the scanner's observed candle availability, which may be delayed by polling. Its output is signal evidence. Historical Setup E comparison requires the original contiguous footprint inputs and is a separate replay step.
