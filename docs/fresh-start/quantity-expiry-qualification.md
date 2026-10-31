# Phase 9: verified quantity conversion and strict expiry calendars

Started 31 October 2026 after PR #81 (main `6a60756`).

The shared sizing adapter now separates broker lot quantity from premium exposure. It returns broker `lotQuantity`, premium `multiplier`, and `premiumUnitsPerLot` only when the existing metadata explicitly verifies both quantity and tick units. It rejects inconsistent premium metadata, invalid integer lots/ticks and non-unit NSE/BSE multipliers. Raw MCX master data remains unverified.

The production adapter and executable-book checks use this same conversion. Book size is compared against broker quantity; P&L and fees use broker quantity × premium multiplier. Sizing terms freeze into contract evidence. For a hypothetical independently verified Gold contract, broker quantity 1 and premium exposure 100 yield multiplier 100; this does not authorize assigning that verification flag to the current master. Fractional ratios are also represented, rather than rounded into invented quantities.

Expiry-session qualification now rejects impossible dates that JavaScript would otherwise normalize, nontrading session/expiry dates, and unknown calendar years even for same-day inputs. MCX evening-open holidays remain valid MCX trading days; they do not inherit the NSE holiday result. A verified same-day expiry still counts as zero and remains subject to the existing no-0DTE admission guard.

## Evidence boundary

[SmartAPI instrument documentation](https://smartapi.angelone.in/docs) defines lot size as quantity per lot. [Market-data response documentation](https://smartapi.angelone.in/docs/ResponseStructure) describes quantity in depth. These generic descriptions alone do not establish the contract-specific MCX relationship between socket depth quantities, raw master quantity and premium quote units. No consistent-looking book, public physical contract size or large depth silently promotes `quantityVerified`.

Current MCX qualification therefore remains blocked pending broker-specific documentation or independently verified observed depth semantics. BSE/MCX expiry bucket parameters also remain unapproved, and the production adapter and pure paper engine retain their market vetoes. This phase corrects the conversion/calendar foundations; it does not claim broader paper activation or completed parameter approval.

Validation: full server suite 1,884 passed with 5 existing skips; final focused regression 22 passed; shared/analytics/server build passed. Seven new tests cover distinct and fractional multipliers, independent fee arithmetic, unchanged raw MCX vetoes, bad metadata/depth quantities, normalized invalid dates, same-day unknown calendar years and partial MCX holidays. Existing production adapter entry/exit integration passes.

No live execution, production configuration, database records, deleted trade history or legacy exit rules were changed.
