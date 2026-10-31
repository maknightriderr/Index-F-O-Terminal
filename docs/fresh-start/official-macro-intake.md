# Official macro schedule qualification — 1 November 2026

This work starts from deployed PR87 (`98ffa59`). It adds actual official India/US schedule observations without purchasing provider access or asserting complete event coverage.

## Implemented source scope

| Source | Evidence qualified | Explicit limitation |
|---|---|---|
| RBI [MPC meeting notice](https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=62422) | The six published 2026–27 meeting ranges, retained as 18 date-only meeting days | The annual notice does not establish exact decision times, unscheduled meetings, amendments or every RBI event. No 10:00am or final-day release time is invented. The pinned notice is not extrapolated into a new fiscal year. |
| BEA [machine-readable schedule](https://apps.bea.gov/API/signup/release_dates.json), linked by its [calendar subscription page](https://www.bea.gov/news/schedule/icalendar) | Explicit UTC dates for GDP and Personal Income and Outlays, which includes PCE | Selected BEA reports only; not complete US/global/India macro coverage or actual economic results. |

Both are supplemental known-event evidence. The existing Trading Economics authority, credential and coverage confirmation requirements remain mandatory. Successful source reads never grant complete macro or commodity coverage. Known date-only MPC meeting days add `RBI_MEETING_TIME_UNCERTAIN`; this preserves the existing conservative uncertain-time behavior without pretending a meeting-day list supplies an exact announcement time. Timed BEA releases add the existing inclusive ±15-minute scheduled-event veto. These source vetoes cannot override a conflicting authoritative blackout or clear missing coverage.

## Availability and provenance

The existing nonblocking public-calendar startup/open-session refresh calls two fixed canonical URLs, with two independent concurrent source outcomes. Each request has a 10-second deadline, one-megabyte cap, no redirect, contact-bearing user agent and five-minute coalesced cadence. There are no new timers, dependencies, subscriptions, broker connections or order routes.

Every successful snapshot is hashed and committed through migration049 before evidence becomes available. Ten-minute validity starts at request time. Late/failed/clock-reversed persistence, failed subsequent requests, expiry and future receipt invalidate eligibility. Evidence is copied. Safe source-specific failure codes never contain raw errors, credentials, response bodies or signed URLs.

RBI parsing finds the actual nested leaf table, validates its exact fiscal-year identity, six ordered three-day ranges and real dates. Comments/scripts cannot supply a phantom schedule. All 18 days retain `at:null` and `precision:DATE_ONLY`. The annual-plan range is deliberately limited and does not claim amendment surveillance.

BEA parsing validates all release-date arrays, including unselected reports. Identical source duplicates are deduplicated and counted, not silently relabeled as extra releases. GDP and Personal Income/Outlays must each bracket receipt within a bounded ±45-day window. `file_last_updated` is a timezone-less publisher string: it is retained verbatim and never assigned a UTC availability timestamp. Receipt and durable qualification determine actual availability.

The authenticated status and existing Paper Trades public-calendar table show each independent source, failure code, snapshot ID and next observed date. Date-only events explicitly say time not published; no midnight instant is displayed. `completeMacroCoverage` remains false.

## Actual-source probes

Fetched official samples passed the real parsers on this work session:

- RBI: HTTP200, 112,437 bytes, six meeting ranges/18 date-only days. Payload SHA256 `0f26265b3d7db72a5d08560d763ea923716427006eea45ce648cccff30e92cc3`.
- BEA: HTTP200, 12,096 bytes, 206 release-date assertions with ten identical duplicates across the full feed; six selected current-window events. Snapshot payload hash (normalized JSON) `3a21dfb4c57b8beed48fd58b3abd2a1763dfb09d77627bf7b56f704942244766`.

These are parser/transport observations, not production connectivity, full historical coverage or trading results. Production qualification requires separate deployment evidence.

## Remaining facts and external dependencies

- MoSPI's [release calendar](https://www.mospi.gov.in/release-calendar) is rendered from the public `release-calender/fetch-all-release-calender-Web` API identified in its published frontend. Two bounded requests using that exact UI schema for October/November2026 returned HTTP502. A blank rendered calendar cannot be treated as zero events. The annual PDF and published changes need their own reliable intake/qualification; no recurrence dates or schema were fabricated.
- The Federal Reserve calendar is publicly documented, but a direct runtime-workspace probe returned HTTP403. No alternate identity, proxy or static-calendar fallback was introduced.
- BLS returned HTTP403 in the last verified Railway startup. That is a separate unresolved source-access dependency, despite a successful workspace sample.
- Complete India/RBI, applicable US/global macro and commodity-specific event coverage still needs an entitled verified provider or an explicitly reviewed complete public-source policy. No Trading Economics credential is manufactured and no coverage flag is switched merely to arm entries.
- The current official SmartAPI documentation describes master lot size and book quantity generically, but does not independently establish product-specific MCX socket quantity semantics. MCX `quantityVerified` stays false; no same-feed agreement or lot-multiple plausibility is promoted to proof.
- Real market-open end-to-end paper qualification and profitability evidence remain pending. No fabricated fills, historical reconstruction, portfolio/counter reset or live order is used to demonstrate progress.

## Validation and current configuration

Full server suite:1,932 passed with5 existing skips. Full web suite:171 passed. Server/web production builds, final server typecheck and whitespace checks passed. Tests cover real date validity, fiscal-year mismatch, nested-table/comment/script handling, missing/duplicate/reordered meetings, date-only uncertainty, BEA DST/UTC conversion, publisher metadata, duplicate/excluded counts, independent source failures, bounded/coalesced refresh, availability after durable write, clock rollback/expiry, evidence copies, continued mandatory coverage vetoes, weekend recovery and UI date-only labeling.

A fresh read of the production service's variable **names only** found no `FRESH_EVENT`, macro or calendar configuration, including staged changes. No credential values were requested. Complete-provider access remains an actual missing input; partial public-source successes cannot legitimately replace it.
