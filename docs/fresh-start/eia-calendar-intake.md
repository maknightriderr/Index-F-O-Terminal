# Next phase: official EIA schedule intake

Started 31 October 2026 from deployed main `dca31ef` (PR #84). No newer fresh-start PR was awaiting merge when work began; unrelated open PRs were left untouched.

## Implemented

The existing worker now refreshes EIA schedules automatically only when the MCX session is open and scoped MCX instruments exist. It adds no timer, broker connection, paid API or local tooling dependency. Three canonical calendar/report reads occur at most once per five minutes, with bounded same-host report-delivery redirects, request deadlines and response sizes. The contact-bearing user agent identifies the public repository. Failures are sanitized into stable timeout/HTTP/parse/persistence codes.

- Petroleum: the [official WPSR JSON calendar](https://www.eia.gov/petroleum/supply/weekly/includes/wpsr-calendar.json), linked by the [current report](https://www.eia.gov/petroleum/supply/weekly/), supplies explicit release dates and times. No Wednesday recurrence is fabricated.
- Natural Gas: the [current report](https://ir.eia.gov/ngs/ngs.html) supplies its actual last/next release dates; the [official schedule](https://ir.eia.gov/ngs/schedule.html) supplies the Thursday default and holiday exceptions. Unsupported years, unannounced non-Thursday dates and changed markup fail closed.
- Eastern timestamps use the IANA America/New_York zone and roundtrip validation, including rejection of ambiguous/nonexistent wall times. Epoch timestamps render correctly in IST.
- Each product snapshot is hashed and saved in the existing `fresh_calendar_snapshots` table before it becomes available to decisions. Availability cannot precede the completed durable write or survive expiry/clock rollback. Snapshots expire after ten minutes. Returned evidence is copied so inspection cannot mutate source state.
- Candidate evidence/read-only source status include source identity, observed snapshot IDs and release times. During ±15 minutes of an observed release, the corresponding product adds `EIA_PETROLEUM_BLACKOUT` or `EIA_NATURAL_GAS_BLACKOUT`.

## Scope and data quality

This is **single-report schedule evidence**, not complete commodity-event coverage. `completeCommodityCoverage` remains false and `BLOCKED_COMMODITY_EVENT_COVERAGE` remains mandatory even when an EIA schedule is observed or no EIA blackout is present. Gold/Silver are not assigned these energy schedules. Macro, OPEC/other applicable scheduled events and independently verified broker depth units remain separate dependencies.

The inspected petroleum JSON contained 110 rows and historical supplemental/nonlinear relationships. The parser checks every row's shape, date and time, but qualifies only a bounded ±14-day current window and checks that window's release chain. Old rows are not silently relabeled as validated historical data: excluded-row counts and relationship warnings are retained alongside the full payload hash. The current sample had four window rows, 106 excluded rows and five out-of-window relationship warnings. A malformed/current missing or conflicting row rejects observation.

## Actual-source checks and limits

Published samples fetched on 31 October 2026 passed the actual parsers:

| Report | Published date | Resolved time in IST |
|---|---|---|
| Petroleum | 28 October 2026 | 20:00 |
| Petroleum | 4 November 2026 | 21:00 |
| Petroleum holiday shift | 12 November 2026 | 22:30 |
| Natural Gas | 29 October 2026 | 20:00 |
| Natural Gas next release | 5 November 2026 | 21:00 |

These demonstrate explicit dates/holiday handling and the US daylight-saving transition. They are not production connectivity or trade evidence. Remote default Axios transport timed out; a diagnostic using the configured HTTPS proxy's CONNECT transport successfully fetched the 110-row petroleum JSON. Production connectivity remains unverified. Production routing was not changed to work around the workspace transport behavior; the adapter invalidates failed observations and exposes safe failure codes.

EIA's [automated retrieval policy](https://www.eia.gov/about/privacy_security_policy.php) was inspected. Only public canonical hosts and the documented same-host gas delivery redirect are used; signed delivery query strings are never persisted or logged. No account registration or subscription purchase occurred.

## Verification

Tests cover DST/IST and holiday timestamps, impossible/ambiguous dates, source markup/JSON corruption, current-chain gaps/duplicates, warning-bearing exclusion of old rows, no historical lookahead, refresh coalescing/backoff, safe redirects, persistence failures/delays/clock rollback, stale evidence, source immutability, MCX-only refresh, durable source storage, exact product blackouts and continued incomplete-coverage refusal. Next steps remain source coverage and broker-unit qualification, not manufactured fills or reconstruction of deleted records.

Validation: full server suite 1,906 passed with 5 existing skips; final focused EIA/worker/store checks 29 passed; server/web builds and final server typecheck passed. No new dependencies were installed. Public-source parser probes and workspace transport results are recorded separately above so they are not confused with production qualification.
