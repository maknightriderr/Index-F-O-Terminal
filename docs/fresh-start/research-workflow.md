# Research preparation and repeatable validation workflow

Implemented under the1 November2026 request to complete pending plan tasks. Trading stays under the previously approved NEW-INTRADAY-1.3 paper policy. This document distinguishes completed preparation from data-dependent validation.

## Data inventory

The authenticated Fresh Start status now includes research readiness, shown in Paper Trades. A read-only transaction reads allowlisted table metadata and existence probes; it never reads P&L or holdout outcomes. Statement timeouts are1.5 seconds; cached/coalesced reads occur no more than once per15 minutes per process. Errors return unavailable rather than an empty/qualified dataset. Estimates are catalog estimates, can be stale or incomplete for hypertables, and are not exact counts or date coverage.

The seven sources are classified as signal bars, price observations, legacy execution diagnostics, recorded signal context, forward paper ledger or forward paper results. Presence is never promoted to a fixed-contract historical option-execution dataset. The inventory establishes what is retained; coverage, exact instruments, timestamps, depth units, historical universe and cost/calendar provenance still require dataset-specific qualification.

Boot registers the research protocol and samples inventory after position recovery, asynchronously. It does not delay monitoring or arm entries. Existing calendar preflight now also probes the stock issuer source once using its existing request/cadence guard, and records only safe source status/count metadata. It cannot turn an HTTP denial into verified coverage.

## Predeclared prospective protocol

`FRESH-PROSPECTIVE-2026-11-V1` fixes the existing parameter pack and source-tree reference before collection:

| Period | IST window |
| --- | --- |
| Capture/development |2 November2026 through30 November2026 |
| Validation |1 December2026 through31 December2026 |
| Prospective holdout |1 January2027 through30 June2027 |

These are research periods, not an entry-policy change or a guarantee that enough trades/sessions will occur. Historical testing can use a separately qualified dataset/protocol; this prospective plan does not fabricate missing historical quotes. Future exchange calendars/fees still require verification for their applicable dates.

One existing parameter pack per strategy is the experiment budget. Any new variant requires a separately predeclared future protocol; tuning on this holdout cannot restore its untouched status. Strategies, markets, direction,5-minute setup timeframe, event policy and event evidence classes are kept in separate cohorts. The existing200-trade/60-session holdout, positive95% day-block net-R lower bound,1.2 profit-factor,5% drawdown,100-forward-trade/30-session criteria remain research gates, not performance promises. A70% win rate remains an aspiration.

Protocol body/digest is registered once before capture starts. Database triggers reject updates/deletes; a deployment arriving too late cannot retrospectively register this protocol. The protocol date/criteria metadata never drives trading entries, sizing, exits, AI changes or learning.

## Bounded remote commands

Use the existing remote runtime and authorized database context; no local installation is needed:

```bash
npm run research:fresh --workspace=@fno/server -- protocol
npm run research:fresh --workspace=@fno/server -- inventory
npm run research:fresh --workspace=@fno/server -- register
npm run research:fresh --workspace=@fno/server -- export-contexts FROM_ISO TO_ISO NEW_CONTEXTS.json
npm run research:fresh --workspace=@fno/server -- replay NEW_CONTEXTS.json NEW_REPLAY_REPORT.json
npm run research:fresh --workspace=@fno/server -- report QUALIFIED_BUNDLE.json NEW_VALIDATION_REPORT.json
```

Dates need explicit UTC/offsets. Export/replay/report refuse during an NSE/BSE/MCX session. Exports are read-only, current-version, half-open time windows limited to100 records and10MB. Empty/oversized windows return explicit errors; narrow the window rather than silently dropping records. No trade outcomes are included in signal exports. Output creation is exclusive and private; existing files are never overwritten. No command requests paid data, broker quotes, historical downloads or live orders.

Signal replay validates version, input bounds, session date, chronological order and unique IDs, reruns the pure evaluator on stored decision time and compares accepted/refused decisions. It reports mismatches and hashes the tape. This is SIGNAL_REPLAY_ONLY, not a historical option execution backtest or P&L result.

## Outcome report and inspection record

A JSON bundle must declare schema `FRESH_RESEARCH_BUNDLE_V1`, exact protocol digest, one complete cohort, execution evidence class, parameter-freeze time, prior-inspection state, dataset capability assertions, trades, forward trades, equity path and unresolved count. Each trade carries its cohort, version, session, entry/exit time, measured net P&L and original risk. Schema bounds, duplicate/mixed/version/session/future-time checks run before inspection. Forward observations cannot overlap the holdout. An immature/empty holdout is refused.

Before computing/returning holdout statistics the runner durably claims `(protocol,cohort,dataset digest)`. It then records period counts, wins/losses/flat, supplied net P&L, net-R expectancy, session counts and validation blockers. One dataset can be consumed per cohort; a changed dataset cannot masquerade as a new untouched sample. Identical retries return the stored report; incomplete/failed inspections remain consumed. Database triggers forbid changing receipt identity/digest/time, deleting receipts or editing a completed report.

Dataset flags supplied in JSON are declarations, not independent qualification. Visible paper-dashboard outcomes are not blinded: the report always discloses `HOLDOUT_BLINDNESS_NOT_ENFORCED` and does not authorize formal validation or promotion. Previously viewed outcomes stay inspected. Controlled independently qualified data/blindness evidence is still necessary for a stronger claim. Database owners remain capable of privileged DDL/TRUNCATE; these controls protect the application workflow, not against an administrator rewriting storage.

## Migration, tests and rollback

Migration050 adds only protocol/inspection metadata tables and guards. The boot splitter now understands single/double/dollar quotes, escaped strings and nested comments so trigger bodies survive statement splitting. Regression tests execute the real migrations twice and retain earlier tables/tests.

Rollback must preserve050 metadata and inspection receipts. Disabling research commands/views does not require changing entry activation, held monitors, risk counters, existing history or legacy exit plans. Never delete a consumed holdout receipt to permit retuning. If research schema is unavailable, readiness is unavailable and outcome reports refuse; no trading gate is bypassed.

## Still requires real evidence

Actual market-session entry/exit records, sufficient samples, historical fixed-contract quote/universe coverage, independent Angel MCX depth units, current issuer/action coverage where the source is unavailable, representative market-open resource measurements, controlled holdout evidence and the independent final assessment cannot be manufactured by this implementation. Preparation is implemented; these conditions remain unverified until measured.

Final local verification: server2,001 passed with5 existing skips; web184 passed; server/shared/web builds passed. Migration/registry/readonly inventory, durable inspection and retry/failure guards, real PGlite context export-to-replay, SQL parser and UI disclosure tests passed. CLI protocol output and a clearly synthetic refused-context replay passed; attempting to overwrite its report was refused. No historical execution study or production fill is claimed by these tests.
