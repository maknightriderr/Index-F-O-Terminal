# Phase 8: product-specific paper fee estimates

Started 31 October 2026 after PR #80 (main `37c8eed`). This phase adds a dated fee selector and auditable component breakdown. It does not activate BSE/MCX entries or verify broker depth/order quantity semantics.

The primary broker tariff inspected on 31 October 2026 is [Angel One's published schedule](https://www.angelone.in/exchange-transaction-charges). The existing NSE policy also retains its [NSE circular](https://nsearchives.nseindia.com/content/circulars/FA73061.pdf) provenance. All numbers below are **percentages**, converted to fractions in code.

| Option product | Exchange charge, each side | Sell-side tax | Buy-side stamp |
|---|---|---|---|
| NSE standard index/stock options | 0.03553% including IPFT | STT 0.15% | 0.003% |
| BSE SENSEX/BANKEX | 0.0325% | STT 0.15% | 0.003% |
| BSE SENSEX50 | 0.005% | STT 0.15% | 0.003% |
| MCX CRUDEOIL/NATURALGAS/GOLD/SILVER | 0.0418% | CTT 0.05% | 0.003% |

The approved paper brokerage remains ₹20 per executed order, once on entry and once on exit, independent of lot count. SEBI charges are ₹10/crore on premium turnover; GST is 18% of brokerage, exchange and SEBI charges. STT/CTT and stamp are excluded from that GST base. All turnover uses option premium and the independently supplied premium quantity/multiplier, without strike/notional substitution or spread double-counting.

BSE/MCX policies are usable as estimates only from their observation date through 31 December 2026; the selector does not backdate unverified tariff coverage. NSE retains its existing policy and April 2026 STT boundary. Unknown products, NIFTYFPI's exemption, non-option instruments, invalid dates and later years return no qualified policy. FOCIT, minis, agricultural products and BSE stock options are not silently assigned these tariffs.

Discovery now adds an explicit product-fee blocker when selection fails. The NSE production adapter uses the selector and freezes tariff provenance plus a flat-premium round-trip breakdown in the contract's entry evidence. Existing position policies and exits remain frozen. BSE/MCX product-policy and commodity-event vetoes remain intact; a fee estimate cannot enable a trade.

The shared pure calculation exposes brokerage, buy/sell turnover, exchange, SEBI, stamp, sell tax, GST and total. The existing total-cost function delegates to that same calculation; sizing, net payoff and net breakeven remain consistent. Values are unrounded paper estimates, not an actual contract note, tax filing calculation, exercise/devolvement charge or proof of profitability.

Independent arithmetic checks use entry ₹100, exit ₹110, premium quantity 100 and multiplier 1: NSE ₹72.829114; BSE SENSEX ₹72.07828; BSE SENSEX50 ₹65.26378; MCX ₹63.38282. Tests also cover multi-lot flat brokerage, Gold-style premium multipliers without quantity qualification, tax/GST bases, zero sell premium, net breakeven/risk locks, policy date boundaries and unsupported products.

Remaining activation dependencies: macro access/confirmed coverage, commodity events, broker-specific MCX quantity verification, approved BSE/MCX expiry buckets, and adapter/analytics integration. This change does not reconstruct deleted trade history, mutate production account state or introduce live execution.

Validation: full server suite 1,877 passed with 5 existing skips; analytics 48 passed; analytics/shared/server build passed. The production-adapter integration test verifies frozen NSE policy and component provenance alongside actual-quantity net exit P&L.
