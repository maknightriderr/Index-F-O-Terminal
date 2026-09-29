# Momentum-break backtest

In-sample 2025-09-29 → 2026-06-02; out-of-sample 2026-06-03 → 2026-09-28 (chronological ⅔ / ⅓ of the NIFTY session calendar).
Cost 0.1R per trade deducted. Go-live bar (pre-registered): OOS ≥ 30 trades, avg net R ≥ +0.1, PF ≥ 1.2. Allowed symbols: ≥ 10 OOS trades and OOS avg net R ≥ 0.

## Data

| Symbol | Bars | First bar | Last bar | Sessions | Volume coverage | Thin sessions masked | Roll dates (masked) |
|---|---:|---|---|---:|---:|---:|---|
| NIFTY | 6133 | 2025-09-29T03:45:00.000Z | 2026-09-28T09:45:00.000Z | 246 | 99.9% | 1 | — |
| BANKNIFTY | 6131 | 2025-09-29T03:45:00.000Z | 2026-09-28T09:45:00.000Z | 246 | 100.0% | 1 | — |
| SENSEX | 6133 | 2025-09-29T03:45:00.000Z | 2026-09-28T09:45:00.000Z | 246 | 99.7% | 1 | — |
| CRUDEOIL | 14631 | 2025-09-29T03:30:00.000Z | 2026-09-28T17:45:00.000Z | 257 | 100.0% | 11 | 2025-10-22 (gap 103, 5.9 ATR); 2025-10-23 (not masked, 0.6 ATR); 2025-11-20 (not masked, 0.9 ATR); 2025-12-19 (not masked, 0.9 ATR); 2026-01-02 (not masked, 2.4 ATR); 2026-01-19 (not masked, 0.4 ATR); 2026-02-17 (not masked, 1.4 ATR); 2026-03-20 (not masked, 0.5 ATR); 2026-04-21 (gap -226, 3.9 ATR); 2026-06-19 (not masked, 0.1 ATR); 2026-07-08 (not masked, 2.8 ATR); 2026-07-21 (not masked, 1 ATR); 2026-08-20 (gap -196, 5.9 ATR); 2026-09-22 (gap -236, 5.1 ATR) |
| GOLD | 13830 | 2025-09-29T03:30:00.000Z | 2026-09-28T17:45:00.000Z | 256 | 99.9% | 27 | 2025-10-06 (gap 1437, 5.2 ATR); 2025-12-08 (gap 1399, 6.4 ATR); 2026-01-02 (gap 1309, 9.4 ATR); 2026-02-06 (not masked, 1.3 ATR); 2026-03-23 (gap -4667, 6.8 ATR); 2026-04-06 (not masked, 2.7 ATR); 2026-06-08 (gap 1626, 3.9 ATR); 2026-08-06 (gap 2629, 8.8 ATR) |

Excluded: FINNIFTY (no snapshot fetched — not backtested).

## In-sample, per variant (pooled across symbols)

| | Trades | Win % | Avg net R | Total net R | PF | Max DD (R) |
|---|---:|---:|---:|---:|---:|---:|
| R1.2-V1.5 | 673 | 27.0% | -0.073 | -49.093 | 0.91 | 99.48 |
| R1.2-V2.0 | 464 | 28.4% | -0.038 | -17.651 | 0.95 | 69.01 |
| R1.5-V1.5 | 433 | 27.7% | -0.034 | -14.886 | 0.95 | 57.80 |
| R1.5-V2.0 | 300 | 26.7% | -0.096 | -28.896 | 0.88 | 65.06 |

<details><summary>R1.2-V1.5 in-sample by symbol</summary>

| | Trades | Win % | Avg net R | Total net R | PF | Max DD (R) |
|---|---:|---:|---:|---:|---:|---:|
| BANKNIFTY | 89 | 33.7% | +0.012 | +1.104 | 1.02 | 17.92 |
| CRUDEOIL | 246 | 28.0% | -0.037 | -9.017 | 0.95 | 43.24 |
| GOLD | 198 | 22.2% | -0.122 | -24.085 | 0.85 | 61.28 |
| NIFTY | 72 | 31.9% | -0.003 | -0.235 | 0.99 | 12.26 |
| SENSEX | 68 | 23.5% | -0.248 | -16.860 | 0.67 | 19.75 |

</details>

<details><summary>R1.2-V2.0 in-sample by symbol</summary>

| | Trades | Win % | Avg net R | Total net R | PF | Max DD (R) |
|---|---:|---:|---:|---:|---:|---:|
| BANKNIFTY | 60 | 35.0% | +0.074 | +4.422 | 1.11 | 12.96 |
| CRUDEOIL | 164 | 27.4% | -0.082 | -13.369 | 0.90 | 35.12 |
| GOLD | 139 | 25.9% | -0.044 | -6.149 | 0.94 | 34.87 |
| NIFTY | 49 | 32.7% | +0.110 | +5.368 | 1.16 | 9.77 |
| SENSEX | 52 | 26.9% | -0.152 | -7.923 | 0.79 | 15.40 |

</details>

<details><summary>R1.5-V1.5 in-sample by symbol</summary>

| | Trades | Win % | Avg net R | Total net R | PF | Max DD (R) |
|---|---:|---:|---:|---:|---:|---:|
| BANKNIFTY | 51 | 23.5% | -0.252 | -12.864 | 0.68 | 22.60 |
| CRUDEOIL | 172 | 30.2% | +0.068 | +11.692 | 1.09 | 28.84 |
| GOLD | 129 | 24.8% | -0.064 | -8.247 | 0.92 | 34.20 |
| NIFTY | 45 | 31.1% | -0.044 | -1.990 | 0.94 | 11.00 |
| SENSEX | 36 | 27.8% | -0.097 | -3.477 | 0.86 | 8.18 |

</details>

<details><summary>R1.5-V2.0 in-sample by symbol</summary>

| | Trades | Win % | Avg net R | Total net R | PF | Max DD (R) |
|---|---:|---:|---:|---:|---:|---:|
| BANKNIFTY | 33 | 21.2% | -0.329 | -10.871 | 0.59 | 20.81 |
| CRUDEOIL | 120 | 27.5% | -0.107 | -12.883 | 0.86 | 28.14 |
| GOLD | 86 | 25.6% | -0.012 | -0.997 | 0.98 | 22.56 |
| NIFTY | 31 | 29.0% | -0.049 | -1.531 | 0.93 | 11.31 |
| SENSEX | 30 | 30.0% | -0.087 | -2.614 | 0.87 | 7.41 |

</details>

**Chosen on in-sample average net R: R1.5-V1.5** (RANGE_MULT 1.5, VOL_MULT 1.5).

## Out-of-sample — R1.5-V1.5, run once

| | Trades | Win % | Avg net R | Total net R | PF | Max DD (R) |
|---|---:|---:|---:|---:|---:|---:|
| **All symbols** | 194 | 24.7% | -0.134 | -25.921 | 0.83 | 35.27 |
| BANKNIFTY | 20 | 20.0% | -0.406 | -8.125 | 0.52 | 12.37 |
| CRUDEOIL | 71 | 31.0% | +0.050 | +3.542 | 1.07 | 10.91 |
| GOLD | 63 | 17.5% | -0.221 | -13.948 | 0.75 | 14.97 |
| NIFTY | 19 | 31.6% | -0.061 | -1.157 | 0.92 | 6.31 |
| SENSEX | 21 | 23.8% | -0.297 | -6.233 | 0.62 | 11.67 |

### By level type

| | Trades | Win % | Avg net R | Total net R | PF | Max DD (R) |
|---|---:|---:|---:|---:|---:|---:|
| DAY_HIGH | 11 | 45.5% | +1.068 | +11.750 | 2.78 | 2.20 |
| DAY_LOW | 18 | 27.8% | -0.220 | -3.954 | 0.72 | 6.21 |
| OPENING_RANGE_HIGH | 15 | 20.0% | -0.315 | -4.723 | 0.63 | 9.52 |
| OPENING_RANGE_LOW | 24 | 33.3% | +0.231 | +5.554 | 1.32 | 10.14 |
| PIVOT_R1 | 6 | 33.3% | -0.108 | -0.646 | 0.85 | 4.40 |
| PIVOT_S1 | 11 | 9.1% | -0.728 | -8.007 | 0.24 | 8.01 |
| PREV_DAY_HIGH | 15 | 20.0% | -0.319 | -4.791 | 0.63 | 6.03 |
| PREV_DAY_LOW | 12 | 25.0% | -0.184 | -2.205 | 0.76 | 4.68 |
| SWING_HIGH | 24 | 25.0% | +0.072 | +1.727 | 1.09 | 6.41 |
| SWING_LOW | 30 | 26.7% | -0.139 | -4.173 | 0.82 | 8.73 |
| VWAP | 28 | 14.3% | -0.588 | -16.453 | 0.35 | 20.34 |

### By decision hour (IST)

| | Trades | Win % | Avg net R | Total net R | PF | Max DD (R) |
|---|---:|---:|---:|---:|---:|---:|
| 10:00 | 19 | 15.8% | -0.454 | -8.623 | 0.50 | 11.69 |
| 11:00 | 15 | 26.7% | +0.266 | +3.985 | 1.36 | 6.21 |
| 12:00 | 22 | 18.2% | -0.475 | -10.448 | 0.45 | 15.78 |
| 13:00 | 25 | 32.0% | -0.029 | -0.731 | 0.96 | 8.80 |
| 14:00 | 19 | 36.8% | +0.152 | +2.888 | 1.22 | 3.52 |
| 15:00 | 7 | 28.6% | +0.204 | +1.429 | 1.26 | 3.30 |
| 16:00 | 12 | 41.7% | +0.566 | +6.797 | 1.88 | 4.40 |
| 17:00 | 10 | 20.0% | +0.357 | +3.569 | 1.41 | 4.40 |
| 18:00 | 23 | 26.1% | -0.176 | -4.050 | 0.78 | 7.33 |
| 19:00 | 15 | 13.3% | -0.553 | -8.288 | 0.41 | 8.29 |
| 20:00 | 13 | 15.4% | -0.592 | -7.694 | 0.30 | 7.69 |
| 21:00 | 12 | 25.0% | -0.213 | -2.555 | 0.72 | 9.08 |
| 22:00 | 2 | 0.0% | -1.100 | -2.200 | 0.00 | 2.20 |

### By direction

| | Trades | Win % | Avg net R | Total net R | PF | Max DD (R) |
|---|---:|---:|---:|---:|---:|---:|
| BEARISH | 94 | 22.3% | -0.297 | -27.911 | 0.64 | 32.20 |
| BULLISH | 100 | 27.0% | +0.020 | +1.990 | 1.03 | 17.95 |

### By exit

| | Trades | Win % | Avg net R | Total net R | PF | Max DD (R) |
|---|---:|---:|---:|---:|---:|---:|
| LEVEL_RECLAIMED | 17 | 0.0% | -0.895 | -15.212 | 0.00 | 15.21 |
| SESSION_END | 9 | 77.8% | +1.758 | +15.823 | 31.14 | 0.28 |
| STOP | 127 | 0.0% | -1.100 | -139.700 | 0.00 | 139.70 |
| TARGET | 41 | 100.0% | +2.760 | +113.168 | ∞ | 0.00 |

## Go-live decision

Out-of-sample: trades 194 ≥ 30; avg net R -0.134 < +0.1; PF 0.83 < 1.2.

**FAIL.** The out-of-sample result does not meet the pre-registered bar. MOMENTUM_BREAK ships default OFF.

## Named case — 28 Sep 2026 CRUDEOIL, 21:00–22:00 IST

Masked session: no. Variant R1.5-V1.5.

| Bar (IST) | O | H | L | C | Vol | Range ×ATR | Vol ×median | Close loc | Result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 21:00–21:15 | 9181 | 9207 | 9166 | 9197 | 663 | 0.77 | 0.47 | 0.24 | NO_LEVEL_BROKEN |
| 21:15–21:30 | 9192 | 9200 | 9142 | 9145 | 791 | 1.11 | 0.65 | 0.05 | NO_LEVEL_BROKEN |
| 21:30–21:45 | 9145 | 9156 | 9082 | 9100 | 2028 | 1.40 | 1.72 | 0.24 | RANGE_TOO_SMALL |
| 21:45–22:00 | 9100 | 9118 | 8851 | 8879 | 10440 | 4.93 | 10.47 | 0.10 | CHASING |

It would NOT have fired in this window.
