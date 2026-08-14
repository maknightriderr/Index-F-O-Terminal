// ============================================================
// IN-SESSION PRICE HISTORY
// ============================================================
// A rolling per-symbol price buffer built entirely from prices the
// app is already polling (indices, F&O scanner) — no new API calls,
// no historical-candle requests. Starts empty each page load and
// fills in over the session, so Sparkline falls back to a simulated
// preview until there's enough real data to plot.
// ============================================================

const MAX_POINTS = 60;

const store = new Map<string, number[]>();

export function recordPrice(symbol: string, price: number): void {
  if (!price || price <= 0) return;
  const arr = store.get(symbol) ?? [];
  if (arr[arr.length - 1] === price) return;
  arr.push(price);
  if (arr.length > MAX_POINTS) arr.shift();
  store.set(symbol, arr);
}

export function getPriceHistory(symbol: string): number[] {
  return store.get(symbol) ?? [];
}
