# Phase 7: exact bullion contract references

Started 31 October 2026, after PR #79 (main `110fc29`). This phase qualifies contract references only. It does not activate BSE/MCX paper entries or qualify fees, quantity units, event coverage or a strategy edge.

Gold uses the exact annexure in the current July 2026 option specification. Its July–November expiry dates map to the explicitly published underlying future months. November 27 options map to the December future; the older November 25 date is rejected. The master must contain exactly one valid MCX GOLD future in that month. No calendar extrapolation, symbol-suffix parsing or nearest-future fallback is allowed. December 2026 option specifications require separate qualification.

Silver combines two applicable official specifications: February 2026 options expire three business days before the first tender day; September 2026 futures have three trading days in the tender period, including expiry. Derive tender start two business days before future expiry, then option expiry three business days before tender start. Applying the older five-day tender period produces the wrong date. Older futures, December option specifications, March 2027 future specifications and unknown holiday-calendar years are excluded.

All four requested commodities now require exact linkage before discovery exposes a signal/pricing reference. Missing/ambiguous links retain universe membership and explicit refusal codes, without an indicative nearest-future substitution. Slices remain bound to the selected future. The MCX depth-unit and product/expiry-policy vetoes remain, along with commodity-event clearance and the adapter/analytics unsupported-market guards.

## Primary source evidence

The following current MCX documents were fetched directly and inspected on 31 October 2026. SHA-256 records identify the observed bytes; PDFs are not redistributed in the repository.

| Document | SHA-256 |
|---|---|
| [Gold option July 2026 onwards](https://www.mcxindia.com/docs/default-source/options/gold-option-july-2026-contract-onwards8d88befa-a326-4ac6-8de1-4bfec750135e.pdf) | `841881b288e45bdf08c0a6b929444662fda9885f100df4bd4681c3347e17822d` |
| [Silver option February 2026 onwards](https://www.mcxindia.com/docs/default-source/options/silver-(30-kilograms)-options-february-2026-contract-onwards.pdf) | `18ebe7c0969604bdd98ee561b398e34aa275c2d4e7752b1b8a83fc43632765da` |
| [Silver future September 2026 onwards](https://www.mcxindia.com/docs/default-source/about-us/silver-september-2026-contract-onwards.pdf) | `09f48875eecc2c973a756e9432ea337a6676c547550d8d6e0876d0b5534bada9` |

A guessed January circular path returned HTML rather than a PDF and was discarded. Neither an HTTP 200 nor an older third-party circular establishes current contract rules.

## Validation

The public Angel master probe contained 147,460 total records and 9,059 records for the four scoped MCX products. On the 31 October discovery date, every product resolved with no unmapped reference:

| Product | Option expiry | Exact future token | Future expiry | Tender start |
|---|---|---|---|---|
| CRUDEOIL | 17 Nov 2026 | 573422 | 19 Nov 2026 | Not used |
| NATURALGAS | 20 Nov 2026 | 574319 | 24 Nov 2026 | Not used |
| GOLD | 27 Nov 2026 | 495213 | 4 Dec 2026 | Published calendar used |
| SILVER | 27 Nov 2026 | 495214 | 4 Dec 2026 | 2 Dec 2026 |

Each slice contained ten contracts for its linked expiry. This is current-master/reference evidence, not an observed executable book or paper fill. Tests cover conflicting historical dates, monthly/bimonthly Gold mapping, Silver tender-policy changes, version boundaries, duplicate/wrong-month references, exchange/tick/date checks, slice binding and preserved entry vetoes.

Still required for broader paper activation: macro provider access and confirmed coverage, commodity-specific scheduled-event coverage, documented MCX broker depth quantities, BSE/MCX costs and approved product expiry policy, followed by adapter/analytics integration. No production secret flags, databases, deleted history, risk controls or live execution were changed.
