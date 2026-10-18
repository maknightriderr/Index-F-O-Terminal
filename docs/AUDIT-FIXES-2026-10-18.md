# Audit fixes (2026-10-18)

Follow-up to the end-to-end audit of 18 Oct (Part A, A1–A13). One commit per finding. Part B (strategy
experiments B1–B4) is not in this change set: those are experiments, not fixes, and each needs its own approval.

**Before deploying:** set `TERMINAL_PASSWORD` on the Railway backend service. Without it the API is locked (every
protected route answers 503) — by design.

## 1. The Old Indicator

It keeps trading on every supported stock and index. No direction, vote, confidence, gate, stop, target or slot
rule changed. What does reach its trades:

| Change | Effect on its trades |
|---|---|
| COST-3.0 (COST-1) | Each trade's estimated cost uses its exchange's dated charges: NSE +0.037, BSE +0.030, MCX −0.048 points of premium against the old flat 0.2%. On production since 5 Oct, 0 of 558 non-GOLD trades sit within 0.04 points of a cost threshold, so none would flip. |
| GOLD lot multiplier (COST-1) | GOLD's cost was overstated by ~1.7 points of premium (lot size 1 instead of 100). GOLD will pass the cost checks more often: 54 of its 59 `COST_TOO_HIGH` refusals since 5 Oct were caused by it. Separate commit, revertable on its own. |
| SILVER, NATURALGAS evaluated (COV-1) | More symbols, so more trades. |
| Boot hold (REL-1) | After a restart *during* a session, scanners and decision timers start 5 minutes later. |
| Closed-market guard (OPS-1) | With every exchange closed, no evaluation runs (it could only refuse `MARKET_CLOSED`). |

Regression evidence: the strategy regression fingerprint (triggers, structure, router, gates) and the 316 golden
trade-setup snapshots are unchanged. The end-to-end full-replay fingerprint changed once, deliberately, for COST-3.0:
diffed field by field, only `estimatedCostPct` (1.79 → 1.82), the F&O record's `costPct` and the reason text moved —
the same trade, strike, stop and target.

## 2. Findings

| ID | Fix | Notes |
|---|---|---|
| SEC-1 | Every `/api` route and `/ws` need a session from `POST /api/session` (`TERMINAL_PASSWORD`, constant-time; HS256 JWT, 7 days, keyed on `JWT_SECRET` + the password). Public: `GET /api/health` (status only without a session), `/api/health/memory`, `/api/health/ready`, `/api/session`. Fails closed in production. `/api/auth/login` and `/logout` removed. Web: sign-in gate, sign-out. | |
| SEC-2 | `GET /api/market/bias/:symbol` (ran the decision engine) removed; a test keeps every GET handler away from engine writers. | |
| LIFE-1 | The lost-trade sweep covers every mode: superseded rows (not just the newest on a slot), options past expiry (an expired option's slot is released). A row whose plan recorded a close gets that close instead of a void. | `e41a6899` was already voided by the boot rule; left voided (un-voiding adds a loss: your call). |
| REC-1 | Nightly plan-vs-trade reconciliation (01:00–07:00 IST); a new disagreement alerts once; report at `GET /api/diagnostics/reconciliation`. Read-only. | Correction: `8c7d3ec0` was already voided on 9 Oct with your approval, so the audit's "understated the cohort" was wrong. No data migration. Today: 597 of 599 plans agree, 2 voided, 0 mismatches. |
| DATA-1 | Exchange quote times (`exchFeedTime`/`exchTradeTime`) on option legs and decisions; unclamped exchange age; `STALE_QUOTE` gate-diagnostic on every TAKE, **shadow only**. | ENFORCE deliberately not built: a refusal gate is a strategy change and waits for the shadow evidence. |
| REL-1 | Open trades subscribed at boot from their slots; monitor checks in the interactive lane; 5-min boot hold for scanners in session; `GET /api/health/ready` as Railway's health check. | Readiness does not wait for the broker feed: one Angel One session per login, so two containers waiting on their own feeds would log each other out. |
| OBS-1 | `opsMonitor`: open trade without ticks, feed down, contract silent, engine not computing an expected symbol, open trade past expiry, record mismatch → `/api/health` DEGRADED + one Telegram alert per incident + a resolved note. | Engine liveness uses the engine's last computation, not decision records (gaps up to 110 min are normal). |
| COV-1 | `BACKGROUND_BIAS_SYMBOLS` default adds SILVER and NATURALGAS; bar archive too. | MIDCPNIFTY is not in the intended universe. |
| REPL-1 | `DECISION_TAPE=TAKE` (default): tapes for every trade-minting poll + 1 in 20 others; `config_registry` (042) names the commit and settings of a refused replay. | ~50 MB/day at 2-day retention. Recording costs CPU/memory on every poll: `DECISION_TAPE=OFF` if `/api/health/memory` shows it. |
| COST-1 | COST-3.0 dated per-exchange charges (sources in `packages/shared/src/constants/index.ts`); GOLD/GOLDM lot multipliers. | STT on an option sale is 0.15% since 1 Apr 2026 (Finance Act 2026). |
| ARB-1 | A priced candidate always ranks before an unpriced one (parent arbitration and the slot). | 0 of 128 slot selections since 5 Oct had a mixed pool. |
| UI-1 | TOKEN_REJECTED shown; quotes and ticks labelled with the exchange's time ("Last close" when closed); floored percentages with their denominator. | "Signal Diagnostics opens empty" could not be reproduced (the default window is all history). |
| DOC-1 | `effectiveFlags` in the stamp (RICH_IV_RR, LOCATION_GATE: INERT); `NO_TARGET` event; COST-3.0 vs COSTREC-1.1; a gate-chain drift test. | |
| REC-2 | Untracked expiries counted apart on Paper Trades; the 0-row reopen repair removed. | |
| OPS-1 | 043: four unused `oi_snapshots` indexes dropped (91 MB); raw OI older than `OI_RETENTION_DAYS` (60) archived losslessly, then deleted; no evaluation while every exchange is closed. | The audit's "no retention" was wrong (400 days existed) but would not have prevented the volume (3.1 GB free, ~36 MB per session) filling by about January. 60 days chosen over the audit's example of 90 to stay well inside the volume. |

## 3. After deploying

- Sign in on the web; `/api/health/ready` answers 200; System Health shows the trade-watch checks.
- `/api/diagnostics/reconciliation` shows a report after 01:00 IST the next night.
- Decision snapshots gain `option.exchangeTimestamp` (confirms Angel One sends `exchFeedTime`), and TAKEs get a
  `STALE_QUOTE` row.
- SILVER and NATURALGAS appear in decision snapshots during the MCX session.
- `GET /api/health/memory` the day after, for the tape recording's cost.
