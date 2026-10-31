# Next phase: operational activation qualification

31 October 2026. BSE and MCX parameter hypotheses have been accepted in the user's replies to the concrete proposals. Engineering paths exist for the requested NSE index/stock, BSE index and four MCX commodity option scopes. This is not evidence that production entries are occurring or that any strategy is profitable.

## Verified starting point

- The corrected shared normal CDF and exact-future MCX model passed independent benchmarks in PR #84.
- BSE policy: 1–10 trading sessions, no 0DTE, maximum 1% spread.
- MCX policy: 3–15 trading sessions, exclude final two sessions/expiry day, maximum 1.5% spread.
- Existing risk, observed quote/latency, immutable held evidence and automatic exit/review paths remain required.
- A direct production service-config read found no macro/event/calendar/EIA variable names on the service. No secret values were requested or printed.

## Input needed: macro-calendar access

The implemented macro adapter requires these variables on the existing Railway production backend service:

| Variable | Meaning |
|---|---|
| `FRESH_EVENT_PROVIDER` | `TRADING_ECONOMICS` |
| `FRESH_EVENT_API_KEY` | Existing entitled API credential, supplied through Railway's secure variables UI |
| `FRESH_EVENT_COVERAGE_CONFIRMED` | `true` only after the plan's required India/global high-impact calendar coverage is verified |

Do not put the credential in chat, source control or logs. Do not set the confirmation flag merely to clear a blocker. No new subscription purchase is authorized by this handoff. If the user has no suitable provider access, establish a separately reviewed public-source coverage policy rather than silently reducing coverage. The previously inspected free replacements were incomplete/stale or had unsuitable automation terms.

After configuration, the runtime must observe and durably persist fresh covered snapshots before clearing event gates. An empty/truncated/error response is not proof of coverage. NSE stock issuer/action coverage remains a separate public-exchange dependency.

## Input needed: MCX broker depth-unit evidence

[SmartAPI instrument/response documentation](https://smartapi.angelone.in/docs/ResponseStructure) defines lot size and depth quantity generically. The broker's [Crude quantity support thread](https://smartapi.angelone.in/smartapi/forum/topic/806/quantity-is-not-a-multiple-of-lot-size/5?lang=en-GB) advises referring to its instrument dump for order quantity. These establish the importance of the raw master quantity; they do not conclusively specify how each current MCX option's socket depth quantity maps to it.

Obtain contract/product-specific broker documentation or independently corroborated evidence for the current quote schema. Identify the exact product, effective dates, raw master lot quantity, book quantity basis and premium quote multiplier. Gold's broker quantity and premium multiplier differ. A large book, an integral lot multiple or agreement between two fields from the same feed is insufficient to promote `quantityVerified`.

Once evidence exists, qualify only matching exact instrument metadata and reject changed/unknown units. Until then raw MCX master metadata remains unverified, regardless of approved parameter hypotheses.

## Commodity event coverage remains separate

The implemented event adapter still returns `BLOCKED_COMMODITY_EVENT_COVERAGE`. Configuring the index macro key does not establish commodity coverage. Define and verify the required energy/metal scheduled-event sources, publication timing, uncertainty behavior and coverage before replacing that veto. Do not use stock issuer calendars or macro importance alone as a substitute for commodity-specific events.

## Completion evidence

Capture a current authenticated readiness report, fresh durable calendar IDs/coverage, exact source epochs/books and verified quantity metadata during an actual applicable exchange session. Let existing gates decide whether an eligible paper candidate can fill. Do not manufacture trades to demonstrate activation or reset account counters. Closed-market health is deployment evidence only. Paper fills must remain newly observed; deleted PostgreSQL history is not reconstructed.

The immediate external question is whether the user already has suitable Trading Economics economic-calendar access. No additional local installation, paid purchase, live order or external support message is required or authorized by this document.
