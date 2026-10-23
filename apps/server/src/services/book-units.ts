// Pure: no imports (shared by the paper execution ledger and the experiment arms).
/**
 * Units one book quantity stands for. MCX quotes its book in LOTS, NSE / BSE in units. Observed on 23 Oct: every NSE /
 * BSE chain size (420 of 420) is a whole multiple of the lot size; every MCX one (80 of 80) is below one lot and not a
 * multiple (GOLD 1-4 against a 100 lot, NATURALGAS 168-427 against 1250), which only lots can be.
 */
export function bookUnit(exchange: string | null | undefined, lotSize: number | null | undefined): number {
  return exchange === 'MCX' && lotSize != null && lotSize > 0 ? lotSize : 1;
}
