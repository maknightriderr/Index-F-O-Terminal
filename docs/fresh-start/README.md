# Fresh-start implementation — NEW-INTRADAY-1.0

The reviewed master prompt and Phase 1–2 report are preserved beside this file. The user approved implementation on 30 October 2026. The numeric pack remains a research hypothesis. All new strategies and markets are disabled, capital is unset, and there is no live-order integration or activation API.

## Implemented

| Requirement | Implementation and verification |
| --- | --- |
| R-01, R-03, R-19 | Legacy entry veto before candidate arbitration and at the durable mint boundary; experiment entry veto after held-position processing. Held-plan monitoring and legacy history remain in their existing paths. Historical characterization tests explicitly exempt retirement; separate real-policy tests exercise refusal and held exits. |
| R-04, R-08, R-09 | Pure four-strategy evaluator, closed-bar availability, 5m setup/15m trend, Wilder ATR14, EMA20/50, comparable-slot RVOL, closed-1m VWAP proxy, confirmed swings, nearest known objective. Mirrored bullish/bearish fixtures exist for every strategy. |
| R-06-SRC, R-08-EVT | Pure source-conflict/epoch guard and scheduled-event clearance. These require verified data; no source is silently promoted and unknown events do not mean clear. |
| R-12-EXP | 0DTE excluded; approved index/stock session-to-expiry windows. BSE and MCX refuse paper entry pending product qualification. |
| R-12, R-13 | Bounded mandatory-gate contract selector, 250ms arrival, post-arrival exchange timestamp, two-second quote limit, full displayed depth, ask plus one tick and bid minus one tick. Both unchanged-IV and stressed scenario values are required. No midpoint fills or spread double subtraction. |
| R-14, R-15 | Structural/premium stop spaces, immutable initial R, optional disabled baseline trailing, no-progress/maximum hold and forced session cutoff. Missing eligible exit quote persists EXIT_PENDING across restart. Gap losses can exceed planned R. |
| R-16 | Whole-lot sizing, per-trade risk/premium caps, conservative account marks, daily loss/loss-streak pause, parent/underlying/group constraints. PostgreSQL transaction and singleton portfolio lock serialize spending across replicas/account days; account capital and session cannot mutate mid-cohort. Full-size entry is atomic, so no outstanding unfilled entry reservation is fabricated. |
| R-17, R-18 | Version-isolated filled/closed/pending/net-P&L statistics, descriptive Wilson interval, reproducible day-block net-R bootstrap, frozen chronological boundaries, inspected-holdout refusal, explicit sample/equity/evidence gates. No automatic promotion. |
| R-19 AI | Closed new-cohort positions enter a separate durable explanation queue automatically through the existing review timer. Shared provider cooldown and daily budget apply. Lease fencing and automatic retries; no risk/config/learning writes. AI text is treated as explanation, never executable rules. |
| R-20 | Bounded deadline-aware candidate/build queues, no new services/broker connections, one boot recovery read and status polling at 30s. Status aggregates all fills in SQL with bounded detail lists. |
| R-21 | Read-only authenticated `/api/fresh-start/status` and a separate Paper Trades section. Disabled/blocked status, all four validation rows, empty P&L as unavailable, candidate decisions and automatic review text are explicit. GET does not evaluate strategies or enter/close trades. |
| R-22 | Migration idempotence, duplicate delivery, atomic rollback, concurrent account requests, executable-mark requirements, pending-exit recovery, retired-engine draining and no fabricated fills tested. |

## Real capability work still blocked

This is the disabled execution/research core and status integration. It is **not an activated or fully integrated production scanner**. `FreshQualifiedAdapter` deliberately has no production implementation yet. Existing shared feeds cannot be promoted to that interface by setting environment flags. No scanner evaluation is attached to the production reference stream until these facts are verified:

- Authenticated exact-contract instrument mapping, primary source, timestamp semantics, book quantity units, account entitlements and allowed broker capacity.
- Verified exchange session/expiry/account-day calendars, current costs, event coverage and correct product-specific pricing/reference basis. The core accepts injected verified scenarios; it does not pretend a new pricing model is already qualified.
- A frozen point-in-time dataset with fixed-contract observed bid/ask coverage. Existing rolling option OHLC and synthetic unit fixtures cannot establish quote-backed profitability.
- Portfolio/legacy inventory and risk-group mapping, capital configuration, complete position watch coverage, feed-loss/restart and sustained resource tests.
- Explicit paper activation approval after historical/holdout/forward validation. There is no live trading scope.

The qualified adapter must reuse the shared subscriptions, cap discovery at 20 underlyings and selected option work at five strikes/two expiries, reserve active-position watches first, persist evaluation input tapes, enforce source/event qualification, and record losing arbitration candidates as well as refusals. Its `build` must wait until arrival and use the first eligible observed ask; it must not label a later favorable quote as the first. These integration steps cannot be certified from the unauthenticated data currently available.

The runtime recovers positions independently of entry activation. With persisted risk and no qualified monitor adapter, recovery reports `BLOCKED_OPEN_POSITION_MONITOR_ADAPTER` rather than announcing successful monitoring. Account-day IDs must use the verified exchange-account calendar; a process restart never resets an account. Residual positions from another account day remain in the portfolio's mark/risk checks.

## Validation limits

Tests use explicit synthetic market/contract fixtures and an embedded real PostgreSQL engine (PGlite). Passing these tests demonstrates mechanics, not trading edge. No historical win rate, expected profit, data entitlement or production load result is claimed. The UI always labels this cohort unvalidated. Its descriptive per-trade interval does not replace session-block confidence or an untouched holdout. Provider 429s remain external rate limits; the queue defers them rather than promising they cannot occur.

## Rollback and operations

Keep new activation disabled. Do not remove legacy exit monitors, turn off the complete experiment engine, delete legacy rows, or enable old strategies as a rollback shortcut. Do not drop fresh tables with held/pending risk. A rollback must retain the fresh monitor/state reducer until its portfolio is reconciled flat; the previous binary cannot monitor fresh positions. This version cannot activate new risk, so production remains in drain mode after deployment.

Run builds for `@fno/server` and `@fno/web`, and tests for server, web and analytics. No dependency installation is required. Migration `047_fresh_start_paper.sql` is idempotent and is included in the existing schema bootstrap; schema failure blocks fresh capability.

## Phase 2 — activation request, 31 October 2026

The user requested active forward paper trading and explicitly selected **INR 500,000 virtual capital**. That closes the activation-permission and capital-configuration requirements, with INR 1,250 planned risk per trade under the approved pack. It does not constitute a profitability result or erase mandatory operational checks. `activationApproved`/`activationRequested` are true; effective `enabled` remains false until the complete production adapter and required data are qualified. The UI distinguishes that blocked request from an unapproved request.

This phase adds:

- The missing SmartAPI Snap Quote best-five decoder at the documented binary offsets, with packet-header exchange-segment provenance. LTP/partial/unsafe/crossed books cannot masquerade as an executable book.
- A bounded shared-socket book bridge with exact segment/token identity, exchange-time freshness, post-arrival first-book selection, independent connection epochs, recovery invalidation and owned subscription cleanup. There is no fallback to an LTP or to another provider for entries.
- An automatic market-session qualification observer for the exact NIFTY/BANKNIFTY futures and a bounded five-strike/two-expiry option sample. It uses the existing shared socket, respects its documented 1,000-subscription limit with headroom and stays idle outside verified regular sessions. A successful subscription request is not treated as proof of observed data or complete paper readiness. Stocks and full-universe discovery are not yet qualified.
- Reconciliation for the user's reported PostgreSQL history deletion: retired Redis positions with demonstrably missing original signal rows are atomically moved to a separate 30-day quarantine. Surviving PostgreSQL positions are preserved. A database outage leaves all slots intact. Unknown/unlinked slots are flagged, not declared flat. Retired slots are never backfilled as new historical trades. No database records, risk counters or whole Redis namespace are blindly deleted/reset.

The complete production strategy-context/contract/model adapter, verified scheduled-event coverage, pricing/fee qualification, live-session observed-depth verification and actual portfolio inventory/load verification remain blockers. The qualification observer does not place paper trades or promote strategies. Deleting prior PostgreSQL records cannot establish an empty Redis portfolio, a validated new strategy or a usable historical sample; old performance is not reconstructed from deleted data.

Protocol sources checked 31 October 2026:
- https://smartapi.angelone.in/docs — WebSocket Streaming 2.0 / Best Five Data, exchange timestamp, segment header and 1,000 subscriptions per socket.
- https://nsearchives.nseindia.com/content/circulars/FAOP71777.pdf — 2026 regular F&O holidays. Special sessions and uncovered calendar years remain excluded.
