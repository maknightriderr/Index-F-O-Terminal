> Approval update, 31 October 2026: after the concrete policy was presented, the user replied "merge, deploy and start next phase". This accepts the proposed BSE 1–10-session/no-0DTE/1% spread paper hypothesis. The approval gate now returns true. Event/data/fee/risk checks remain mandatory; this is not a claim that trades are currently occurring. The original proposal and validation record follow for audit.

# Phase 10: BSE index paper path and reviewable policy

Started 31 October 2026 after PR #82 (main `b787d63`). Engineering path implemented and tested; production policy approval remains **PROPOSED_NOT_APPROVED**. `freshBsePaperPolicyApproved()` deliberately returns false. There is no environment-variable shortcut to silently approve the proposal.

## Concrete proposal requiring approval

| Parameter | Proposed value |
|---|---|
| Products | BSE SENSEX, BANKEX, SENSEX50 index options only |
| Policy identifier | `BSE_INDEX_1_10_PAPER_V1` |
| Expiry eligibility | 1–10 verified BSE trading sessions |
| Expiry-day entries | Excluded (0DTE off) |
| Maximum relative bid/ask spread | 1% of midpoint, same as the existing index baseline |
| Strategy/risk/model hypotheses | Existing four deterministic strategies and shared risk/net-payoff rules; European forward-parity pricing; no new win-rate claim |
| Correlated exposure | Existing `NSE_INDEX_CORRELATED` group, shared with NSE indices |
| Execution | Observed ask/bid paper simulation only; no live execution |

The existing [approved specification](approved-spec.md) says: “enabling BSE/MCX requires their separate capability-specific calendar, model and parameter approval.” Its original BSE scope is discovery-only pending qualification. Implementing this path or merging the PR is not recorded as approval of these new parameter hypotheses. Approval must be explicit before a follow-up enables the gate. Missing macro coverage still blocks entry after approval.

## Implemented path

The production adapter uses the reference's exact exchange for master filtering, option quote identifiers, parity pairs, expiry sessions and expiry close. It refuses wrong BSE signal/spot segments, unsupported products, absent policy approval, stale inputs and all existing event, account, quantity, depth, fee and legacy-risk failures. It freezes the exact policy identifier in the admitted contract. Price/volume signal remains the exact BSE index future, with the matched BSE cash-index pricing reference; NSE token numbers are not interchangeable.

Pure paper admission accepts BSE only with the explicit versioned policy marker and all existing capability checks. It uses the proposed index expiry/spread bounds. Missing/unknown markers still refuse BSE; the marker cannot admit MCX or bypass data/event gates. Held-position exit monitoring remains independent of approval for new entries.

The official [BSE equity-derivatives interface](https://www.bseindia.com/markets/MarketInfo/DownloadAttach.aspx?attachedId=e29aaba3-ce0b-437b-b2d6-29992a9f11b3&id=20220812-47) identifies CE/PE as European and supplies actual last-trading dates. This implementation reads current master dates and verified exchange calendars; it does not invent recurring weekday expiry dates or import India INX's separate USD contract specifications.

## Validation and limits

Full server suite: 1,885 passed, 5 existing skips. Analytics: 52 passed. Shared/analytics/server build passed.

The BSE integration test mocks policy approval and macro clearance, then exercises the real shared-feed adapter, parity fit, dated BSE fees, sizing, durable PG-compatible entry, frozen policy/evidence, structural exit trigger and later executable-bid exit. It also tests denial without approval and denial of an NSE signal mislabeled as BSE. Pure tests check both expiry boundaries, no 0DTE, tighter index spread, missing policy, event/metadata vetoes and continued MCX rejection. Existing default discovery tests retain the BSE policy blocker.

Synthetic test quotes prove engineering behavior, not observed BSE liquidity, exchange fills, strategy profitability or complete production readiness. Current macro access/coverage remains an external dependency. MCX exact broker-depth quantities, commodity events, product-policy approval and execution integration remain separate work. No production data, credentials, risk parameters, legacy exits or deleted history were changed by this phase.
