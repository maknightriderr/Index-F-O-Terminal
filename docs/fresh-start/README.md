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

## Phase 3 — production paper adapter (31 October 2026)

This phase supersedes the earlier statements that the production adapter is absent and the compiled engine cannot activate. `NEW-INTRADAY-1.1` configures the four approved strategies for **forward paper collection**, initially NIFTY/BANKNIFTY only. Effective entries still require recovered inventory, a running exit monitor and current per-candidate operational qualification. This is not a claim of historical validation or profitability, and no live-order route is added.

- The worker reuses the shared Angel socket with exact segment/token identities. Shortlists rotate within five strikes/two expiries, with held option/reference interests preserved first. Confirmation histories seed without retrospective fills; only a newly observed current closed bar can produce a new entry. One-minute bars are fetched before the final five-minute confirmation receipt; revised data receives a new availability time.
- Three to five same-expiry CE/PE pairs fit European put-call parity, yielding an observed forward and discount. Black-76 scenarios use the verified signal-to-forward relationship, a 15-minute-or-earlier horizon, unchanged IV / minus two percentage-point IV assumptions, and the current absolute half-spread hypothesis. Calibration failures and unavailable quotes block entries. This is a paper pricing hypothesis, not a promised future premium.
- The user-selected **INR20 per executed order** is a frozen estimate. Quantity-level fees apply the two flat order charges once, statutory turnover charges, GST, entry/exit ticks and full executable depth. No lot fits the INR1,250 planned-risk cap means no trade. Initial R and fee assumptions remain attached to the fill; realized net P&L uses actual paper exit premium and held quantity.
- Selection precedes arrival. Only the selected candidate waits for its first observed ask after at least 250ms; an unselected candidate cannot hold arbitration until its quote deadline. Final admission rechecks the portfolio under the existing transactional lock. Exits run independently of entry activation, retain pending transitions through storage failures, and require a later eligible full-size bid. Reconnects invalidate old quote caches; entry provenance remains immutable.
- Migration048 stores immutable evaluation input/result tapes and adapter decision evidence. The status panel separates configured engine, effective entry readiness, exit monitoring, capital, unvalidated results and current blockers. Deleted PostgreSQL history is not reconstructed or used as a new validation cohort.

### Optional scheduled-event provider

The adapter makes no event-provider calls by default. Configure all three only after authorizing credentials and confirming the account's complete applicable high-impact scheduled-event coverage:

```
FRESH_EVENT_PROVIDER=TRADING_ECONOMICS
FRESH_EVENT_API_KEY=<secret configured outside git>
FRESH_EVENT_COVERAGE_CONFIRMED=true
```

The provider request has a bounded response, no redirects, a 10-second timeout and a one-minute refresh/retry interval. Timezone-less release times are parsed as provider-documented UTC. Estimated high-impact times block the entire affected IST session. Missing coverage, stale responses, 429s, invalid/duplicate records or potentially truncated pages block new entries; raw response/error URLs and credentials are not exposed. Stock options remain blocked until issuer-results/sector coverage is implemented. News text does not establish scheduled-event coverage.

Sources: https://docs.tradingeconomics.com/economic_calendar/country/ and https://docs.tradingeconomics.com/economic_calendar/schema/; https://nsearchives.nseindia.com/content/circulars/FA73061.pdf; https://www.angelone.in/exchange-transaction-charges; https://www.nseclearing.in/clearing-settlement/equity-derivatives/settlement-mechanism.

Keep the monitor and fresh tables on rollback until all held/pending positions are reconciled. Disable new entries to stop collection; never revive retired strategies or delete open risk. All engineering here occurs in the connected remote workspace; the user's local machine is untouched. Live-session source coverage, actual provider entitlements, sustained load, broker-bill reconciliation and a genuine independent forward sample must still be verified after deployment. Synthetic/PGlite tests prove mechanics only.

## Phase 4 — requested market scope and contract units

The requested scope remains **NSE index options, BSE index options, NSE F&O stock options, and CRUDEOIL/GOLD/SILVER/NATURALGAS MCX options**. It is no longer represented as only NIFTY/BANKNIFTY in the status projection. `NEW-INTRADAY-1.2` separates the corrected tick/quantity mechanics from previous cohorts; existing fills retain their frozen contract evidence and original R. This phase does not approve unverified BSE/MCX expiry/risk parameters or activate live orders.

Implemented:

- Discover today's option-bearing underlyings from the shared master, require unique signal/pricing references and retain explicit unmapped counts. NSE stocks use their exact `-EQ` cash token and known sector risk group; index references retain the existing correlated-index risk-group ID across versions. BSE references use BSE segments; an indicative MCX future is never advertised as a verified option/future link.
- Analyze a bounded 20-reference window (up to 6 NSE indices, 7 stocks, 3 BSE indices, 4 MCX commodities), rotating every 30 minutes. Exchange openings refresh that window immediately. Expensive history is limited to four references/two requests each per cycle and 40 cached histories. At most eight option slices, each five strikes/two expiries/both sides, plus reference and held-position dependencies share the existing consumer budget. The discovered universe is not a claim that every stock has been analyzed or ranked. History gaps are caught up from the last stored bar; cold history seeds never create retroactive fills. History work rotates fairly even when earlier symbols fail, and slow discovery does not hold up recovered exit monitoring. Each worker owns a distinct subscription consumer, so a stopped in-flight worker cannot unsubscribe its replacement.
- Use the actual exchange session for contexts, expiry-session counting, 15-minute aggregation and restored exit monitoring. MCX continues after NSE/BSE cash close and honors the existing verified-year calendar, partial holidays and DST close. Unsupported years remain blocked. Held BSE/MCX watches survive new-discovery subscription pressure.
- Normalize Angel JSON-master ticks from paise to rupees, with no invented default on invalid metadata. Preserve raw broker lot quantity separately from legacy premium P&L units (notably GOLD/GOLDM). Equity quantity semantics must be verified for an executable book; MCX quantity semantics stay unverified. The same master is refreshed across an IST date boundary rather than reusing yesterday's universe for up to 24 hours.
- Expose market-by-market discovered/selected/reference/book/eligible counts and blockers in a read-only status projection and dashboard table. Unfetched universe counts show unavailable. A verified index macro feed does not automatically qualify stocks or commodity-specific releases; a blocker in an unqualified market does not become a universal veto on otherwise qualified NSE index candidates.

Still required before entries in the additional markets:

| Market | Remaining activation requirements |
|---|---|
| NSE indices | Authorized complete macro-event coverage; actual current executable books, per-contract parity/payoff and account checks. NIFTYFPI retains a separate fee-policy blocker. |
| NSE F&O stocks | Issuer-results and corporate-action coverage, verified sector mapping, individual liquidity and the same transactional entry checks. Existing generic corporate-action arrays are not treated as proof of complete results coverage. |
| BSE indices | Verified product/model/fee and separately approved expiry/risk policy; current broker/reference/book and macro-event coverage. NSE expiry buckets are not silently inherited. |
| MCX options | Exact option-expiry → futures-contract link, quote/book quantity semantics and premium multiplier, product model/fees, approved expiry/risk policy, commodity release coverage. No nearest-future guess, index-calendar substitution or forced expiry fill. |

The event provider credentials/coverage confirmation are still absent from the last verified production configuration. No paid data source is purchased or automatically enabled. This phase's scope discovery and synthetic tests do not establish historical F&O membership, complete news/event coverage, a live-session load result or profitable strategies.

Source verification on 31 October 2026: the public Angel master returned raw option ticks of 5 (NIFTY/SENSEX/NATURALGAS), 10 (CRUDEOIL), and 50 (GOLD/SILVER), with GOLD raw lot quantity1; the price-unit correction is covered by deterministic tests. Instrument documentation: https://smartapi.angelone.in/docs and public master https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json. MCX product/reference requirements: https://www.mcxindia.com/products/energy/crude-oil and https://www.mcxindia.com/faq/market-operations. Broker product-specific charges: https://www.angelone.in/exchange-transaction-charges. NSE issuer-calendar availability: https://www.nseindia.com/companies-listing/corporate-filings-event-calendar (not yet qualified as complete programmatic coverage).

## Phase 5 — dynamic issuer coverage and durable event evidence

`NEW-INTRADAY-1.3` replaces the permanent stock issuer/corporate-action blockers with actual source checks. It does not remove mandatory event coverage, change strategy triggers/risk or approve BSE/MCX entry parameters.

- An automatic public NSE adapter queries the explicit-range event calendar and board-meetings endpoints for yesterday through tomorrow, plus corporate actions for a 45-day lookback through tomorrow. It uses a normal public-site session, fixed official HTTPS hosts, no redirects, a 15-second timeout per endpoint and bounded responses. It does not solve challenges or treat a rejected/empty HTML response as data. No API key or paid provider is required for this NSE source.
- Every returned row is validated, including actual calendar dates, issuer symbol, purpose and requested date range. Responses at the hard row cap, malformed rows, empty market-wide evidence, transport failures and persistence failures invalidate coverage rather than being silently filtered away. Duplicated meeting announcements are combined; a reschedule cannot silently erase a previously announced date. Financial-result days, uncertain meeting purpose, corporate-action ex-dates and unresolved adjustment history are separate refusal reasons. Split/bonus/rights/reorganization history is blocked until adjusted history can be established.
- Coverage is as-of observed exchange announcements, not a guarantee that every future or unexpected event is known. Validity is bounded from the earliest request, availability starts only after the final response and durable snapshot write, and stale/future/missing-issuer/session-mismatched evidence blocks entries. Refresh is approximately three minutes (earlier if needed to retain expiry headroom); failures retry after a one-minute cooldown. One source-wide request per endpoint replaces per-stock requests.
- Stock entry requires BOTH a clear issuer/action snapshot AND the existing explicitly authorized, confirmed macro calendar. Index entries do not depend on issuer-source availability. Commodity-specific events remain unqualified; an index macro source is never silently promoted into an inventory/release calendar.
- Refresh is asynchronous relative to scanning and independent of held-risk monitoring. A slow NSE request does not hold index history/scanning; MCX-only evenings do not trigger NSE or index-macro requests. No requests are made by the source panel's read-only GET or outside the applicable worker session. New entries stay blocked until the required snapshots are actually available.
- Idempotent migration049 records source snapshots before they can qualify a decision. Context/candidate tapes, adapter refusals and actual paper-entry contract evidence retain the applicable snapshot IDs/coverage times; later calendar updates do not rewrite the original fill. Source status, safe failure codes and last-observation times are shown separately in the UI. Neither credentials nor public-session cookies are exposed or persisted in these snapshots.

Verification on 31 October 2026: explicit public NSE responses obtained in this workspace contained **179 event rows, 385 meeting rows and 327 corporate-action rows**. The actual full responses passed the strict parser (174 financial-result issuer/dates, three uncertain issuer/dates, 327 action issuer/dates). These are a transport/schema sample, not trading results. The direct Node/Axios network probe timed out in this workspace, while the separate standard-library HTTP sample succeeded; live deployment transport/freshness therefore remains unverified. The adapter correctly reported `SOURCE_TIMEOUT` and kept entries blocked. Synthetic tests and the public schema sample do not establish live-session feed qualification.

Remaining after this phase:

- The last verified Railway configuration still lacks an authorized macro-provider key and coverage confirmation. Do not set the confirmation flag merely to force activation; the provider entitlement must cover the applicable calendar. Never paste keys into source code or chat.
- Observe successful durable NSE snapshots and per-stock exclusions in the deployed runtime. A source failure remains a data blocker with automatic retry, not a request for manual trade review.
- Complete BSE product/model/fee/expiry-policy verification and MCX exact underlying link/quantity/product/commodity-event verification. Their discovery-only entry vetoes remain intact.
- Actual exchange-open paper fills/exits, independent forward samples, load and profitability validation remain outstanding. No deleted trade history is recreated, no old strategy is reactivated and no live order path is introduced.

Primary sources: https://www.nseindia.com/companies-listing/corporate-filings-event-calendar; https://www.nseindia.com/companies-listing/corporate-filings-board-meetings; https://www.nseindia.com/companies-listing/corporate-filings-actions; https://docs.tradingeconomics.com/economic_calendar/country/; https://docs.tradingeconomics.com/economic_calendar/schema/.

### Phase 6 — exact MCX energy references (partial; activation remains blocked)

Crude Oil and Natural Gas discovery now resolves each option expiry to exactly one MCX future using the published two-business-day expiry rule. Signal history, pricing reference and the option slice use that same future. An absent/ambiguous match is excluded rather than replaced with a nearest future. Universe counts retain these instruments and readiness preserves the actual mapping refusal. Option slices cannot mix a later future's options into the selected reference.

The resolver counts an evening-open MCX holiday as a business day, excludes fully closed dates, and refuses unknown calendar years. It validates the applicable option tick and explicitly limits March 2026 energy specifications to option expiries before January 2027; the already published January 2027 specifications require requalification. Tests cover holidays, weekends, duplicate futures, foreign exchange/product matches, wrong ticks, rollover and cross-month slices.

Primary specifications verified on 31 October 2026:

- [Crude Oil, March 2026 onwards](https://www.mcxindia.com/docs/default-source/products/contract-specification/crude-oil-options/crudeoil-(100-barrels)-options-march-2026-contract-onwards4f4aed50-0f8d-46a4-8f1b-efba7c9b9479.pdf): European options, Black 76, two business days before underlying future expiry, premium tick ₹0.10.
- [Natural Gas, March 2026 onwards](https://www.mcxindia.com/docs/default-source/products/contract-specification/natural-gas-option/natural-gas-(1250-mmbtu)-options-march-2026-contract-onwards.pdf): same expiry relationship and model, premium tick ₹0.05.
- [Gold, July 2026 onwards](https://www.mcxindia.com/docs/default-source/options/gold-option-july-2026-contract-onwards8d88befa-a326-4ac6-8de1-4bfec750135e.pdf): expiry is specified by the launch calendar. Do not infer it from the nearest future.
- [Silver, February 2026 onwards](https://www.mcxindia.com/docs/default-source/options/silver-(30-kilograms)-options-february-2026-contract-onwards.pdf): expiry is three business days before the first business day of the underlying future's tender period. The instrument master's future expiry does not supply that tender date.

This is contract-reference qualification, not permission to trade MCX. Broker depth quantity units, commodity event coverage, product-specific costs and approved expiry buckets remain mandatory. Both the production adapter and pure paper engine continue rejecting unsupported BSE/MCX entries. Bullion retains its explicit exact-link blocker; BSE retains its product/expiry-policy blocker.

Next phase dependencies and acceptance:

| Dependency | Required evidence before activation |
|---|---|
| Macro calendar | Trading Economics key in Railway secret variables and independently confirmed India/global high-impact coverage. Existing `FRESH_EVENT_*` flags must not be asserted merely to clear a blocker. |
| Free-calendar replacement | Complete required coverage plus fresh source evidence and permitted automated use. FinanceCalendar's inspected status was stale/degraded with no India central-bank records; Xoomar was US-only; PipAtlas terms excluded automated signal use. None qualifies as a drop-in replacement. |
| Gold/Silver exact linkage | Official current launch/tender calendar keyed to option expiry and exact underlying future. No nearest-month fallback. |
| MCX execution units | Broker-documented or observed contract-specific depth/order-quantity semantics, separate from premium P&L multipliers. |
| BSE/MCX activation | Verified product-specific costs/calendar/model and explicit expiry policy; then adapter/engine integration and rejection-path tests. |
| Forward validation | Real newly observed paper fills with costs and independent sessions. Deleted historical records are not reconstructed. |

No provider was purchased, no API key fabricated, no local tooling installed, and no production data or risk configuration changed for this phase. NSE public-session transport returned HTTP 200 in a remote Node/Axios probe; this is connectivity evidence, not production issuer-coverage qualification.

Validation: full server suite 1,861 passed / 5 existing skips; analytics 48 passed; server and web builds passed. A current public Angel master probe (147,460 rows; 1,656 selected energy rows, held only in scratch) resolved CRUDEOIL option 17 Nov 2026 → future token 573422 expiring 19 Nov, and NATURALGAS option 20 Nov → future token 574319 expiring 24 Nov. Each diagnostic slice contained 10 contracts for its single linked expiry. This verifies reference mapping against the observed master, not executable books or fills.

### Phase 7 — bullion qualification

See [the bullion qualification evidence](bullion-qualification.md) for current Gold launch-calendar and Silver tender-period mappings, source hashes, current-master verification and remaining activation dependencies. This supersedes Phase 6's pending bullion-link research; it does not remove other MCX or BSE entry vetoes.

### Phase 8 — product fee estimates

See [product-specific fee policies](product-fees.md) for dated BSE/MCX tariff selection, premium-turnover component calculations, frozen entry evidence and remaining activation gates. The NSE production path uses the selector while preserving its existing policy and held exits.

### Phase 9 — quantity conversion and expiry validation

See [quantity and expiry qualification](quantity-expiry-qualification.md) for shared verified sizing terms, book/risk conversion, strict exchange-calendar checks and the explicit remaining MCX unit and BSE/MCX expiry-policy dependencies.

### Phase 10 — gated BSE index paper path

See [the BSE paper policy proposal](bse-paper-policy.md) for the implemented and tested adapter/admission path, proposed 1–10-session/no-0DTE policy, explicit approval gate and remaining event-data dependency. Production BSE entry approval remains false.
