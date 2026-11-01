# Exit monitoring resilience qualification

Started 1 November 2026 after PR92 merged as `ba9acceace56ebf81b85ba1fb776bd52cb5961e4`. Railway deployment `2964cbcd-bb5f-4f0c-ab52-48a696633932` succeeded. Live readiness returned HTTP200 with commit `ba9acce`, database/Redis/schema/broker authentication true. Its new operational log was observed with recovered/monitor/scanner true, entries unarmed and `WAITING_FOR_MARKET`/`OUTSIDE_VERIFIED_SESSION`. This is closed-market operational evidence, not a paper fill or complete market qualification.

## Defect fixed

The history context builder fetched1-minute history and then5-minute history sequentially. If shutdown occurred while the first request was pending, its completion could still start the second broker request. A stopped-worker check now runs between these awaits, preventing the second request and subsequent context work. The already-issued request is not claimed to be cancelled at the provider. Existing held-position exit rules, source gates, portfolio counters and strategy versions are unchanged.

## Resilience checks

- **Scanner stall:** a pending history request holds the scan open for20 seconds of simulated time. Existing monitor callbacks continue at least80 times, a second scanner history request is not started, stopping removes the worker's timers, and resolving the old request after stop does not start its second history request or re-arm entries.
- **Shared-feed/storage pressure:**250 exact synthetic subscriptions receive400 batches, totaling100,000 synthetic ticks over40 seconds of simulated market time. A deliberately stalled observation write keeps the per-position queue occupied. Its size reaches but does not exceed16; cached book histories remain bounded by100 observations per contract. A target touched for only one100ms observation is retained even after price reverses. Releasing storage replays retained evidence in order without duplicate timestamps and preserves the exit trigger plus the first eligible full-size bid at300ms after it.
- **Disconnect recovery:** a recovered pending exit cannot use a pre-disconnect cached book, a stale replay or insufficient bid depth. It remains pending with no invented price until a fresh full-size book in the new monitor epoch arrives.

These checks use the real shared-feed class, monitor and pure position reducer, with synthetic observations and an injected in-memory storage acknowledgement/stall. The separate existing PGlite adapter entry-to-exit integration remains the database-backed check. The pressure scenario is not represented as a database throughput benchmark, production broker recording, network reconnect measurement or actual execution. Worker test state is reset between cases so stale discovery timestamps cannot satisfy another case's readiness wait.

## Limits and next evidence

This closes specific mechanical coverage gaps; it does not establish sustained production CPU/RSS, event-loop latency percentiles, source entitlements, exchange-open headroom or profitability. No heavy load test, synthetic trade or database fixture is run against production. No wall-clock performance threshold is inferred from a remote test run.

Actual market-session readiness/entry/exit evidence, stock issuer/action availability and independent current Angel MCX depth-unit qualification remain required where unavailable. Known blackouts and all unchanged risk/depth/monitor gates continue to apply. Missing complete macro coverage is still only the explicitly labeled approved paper exception. There is no new timer, dependency, broker connection, live-order path, historical reconstruction or automatic strategy promotion.

Final validation: server1,968 passed with5 existing skips; server production build passed. Focused monitor/worker checks passed16 tests. PR92's Railway and Vercel web deployments both succeeded; the separate unused Vercel server check remains failed. The shutdown fix and these expanded tests belong to the next-phase branch, not PR92's deployed binary.
