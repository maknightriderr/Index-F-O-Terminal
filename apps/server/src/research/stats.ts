// Small, pure statistics helpers used across the diagnosis report.

/** 95% Wilson score interval for a binomial proportion. */
export function wilson95(successes: number, n: number): { lo: number; hi: number; p: number } {
  if (n === 0) return { lo: 0, hi: 0, p: 0 };
  const z = 1.959963985;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (center - margin) / denom), hi: Math.min(1, (center + margin) / denom), p };
}

export function phi(a: number, b: number, c: number, d: number): number {
  // 2x2 contingency: a=both true, b=x true y false, c=x false y true, d=both false
  const n = a + b + c + d;
  if (n === 0) return 0;
  const num = a * d - b * c;
  const denom = Math.sqrt((a + b) * (c + d) * (a + c) * (b + d));
  return denom > 0 ? num / denom : 0;
}

export function round(n: number, dp = 3): number {
  const m = 10 ** dp;
  return Math.round(n * m) / m;
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}
