# Official BLS schedule intake

This phase starts from deployed PR #86 (`08bbefc`) and adds selected US macro-release schedules without a paid provider or account signup. The existing Trading Economics authority and its credential/coverage requirements remain in place. BLS never becomes a complete macro-calendar fallback, never confirms commodity completeness, and does not qualify MCX depth units.

## Source and scope

The [BLS subscription instructions](https://www.bls.gov/help/hlpical.htm) explicitly publish `https://www.bls.gov/schedule/news_release/bls.ics` for automatic calendar subscriptions. BLS says it contains **most**, rather than every, upcoming national-office release. The [copyright policy](https://www.bls.gov/bls/linksite.htm) permits reuse of its public-domain material with source attribution. The UI attributes the Bureau of Labor Statistics; no emblem is used.

The parser recognizes eight explicit titles: Consumer Price Index, Employment Situation, Producer Price Index, Job Openings and Labor Turnover Survey, Import/Export Prices, Real Earnings, Employment Cost Index, and Productivity and Costs. This is `SELECTED_BLS_RELEASES_ONLY`, not all high-impact US/India/global events. There is no invented release recurrence, impact rating or economic-result interpretation.

## Mechanics

- Reuse the existing worker's nonblocking startup preflight and open-session refresh. A single canonical request has a 10-second deadline, one-megabyte limit, no redirects, a contact-bearing user agent, five-minute retry cadence and in-flight coalescing. No broker subscriptions, timers, credentials or dependencies are added.
- Parse the actual explicit-date BLS iCalendar subset, unfold lines, validate origin/version/component structure and every event's identity, date and time. Duplicate IDs/properties/releases, cancellations, recurrence instances, recurrence rules in releases, floating/all-day/unsupported-zone timestamps and unsupported scheduling semantics refuse observation. VTIMEZONE recurrence metadata is inert; timestamps use the IANA America/New_York roundtrip, including ambiguous/nonexistent-time refusal.
- Retain selected releases within 45 days either side of receipt. CPI, Employment Situation, PPI and JOLTS each need a past and future release in that window. This rejects obviously stale/incomplete current files without claiming complete event coverage. Quarterly families need not fabricate an event within a monthly window. Excluded-row counts and a hash of the complete source payload preserve the limited scope.
- Store the immutable snapshot in existing migration049 storage before exposing evidence. Ten-minute validity starts at request time; failed, late or clock-reversed persistence refuses observation. Failure invalidates old success; status never contains raw provider errors or request details. Evidence is copied and availability cannot precede the completed write.
- A fresh observed selected release adds the existing inclusive ±15-minute event veto across index, stock and commodity candidates. This is an additional veto only: no public-calendar success removes missing provider/issuer/commodity coverage gates, and source disagreement cannot turn a blackout into clear. Missing supplemental BLS observations do not override a separately qualified authoritative provider.
- The authenticated read-only status includes source identity, safe failure code, validity times, snapshot ID, next published release and `completeMacroCoverage:false`. The Paper Trades panel exposes BLS and EIA observations with explicit partial-coverage text and IST dates. Expired/future-receipt snapshots cannot display a current next-release date.

## Actual-source probe

On 31 October 2026, the public BLS endpoint returned HTTP200 and 80,672 bytes. The actual parser accepted all 313 explicit rows and retained 20 selected events in the bounded window; 293 were excluded by title/window. SHA-256: `92a350111ace106deaab5584e4084366bd367b594a0d0bad116008d82d63e501`.

Observed next dates included JOLTS on November3 at20:30IST, Productivity on November5 at19:00IST, Employment Situation on November6 at19:00IST, and CPI/Real Earnings on November10 at19:00IST. These are the fetched snapshot's publication dates, not permanent hardcoded schedules or a historical trading dataset. Production connectivity for this new BLS adapter must be verified from the deployed startup preflight separately.

## Remaining activation dependencies

Complete applicable India/RBI and other macro coverage, applicable commodity event coverage beyond EIA/BLS, and independently verified exact MCX broker book quantities remain unresolved. No account counters, deleted historical records, strategy parameters, legacy exits or live-order scope change in this phase. Passing mechanical tests does not demonstrate profitability.

## Validation

Server build/typecheck and web production build passed. Full server suite:1,920 passed with5 existing skips; full web suite:170 passed. New checks cover actual date conversion across DST, line folding, unknown/cancelled/recurring schedules, missing monthly bracketing, bounded/coalesced requests, delayed/failed/clock-reversed persistence, stale/future evidence, immutable copies, additional-veto arbitration, missing-authority refusal, partial-coverage UI and IST dates. The actual published-file parser probe is separate from these synthetic regression fixtures and from production qualification.
