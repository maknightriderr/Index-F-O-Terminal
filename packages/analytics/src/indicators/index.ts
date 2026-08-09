// ============================================================
// TECHNICAL INDICATORS
// ============================================================
// Pure mathematical implementations of common technical
// analysis indicators. No IO, no side effects.
// ============================================================

// --- Moving Averages ---

/**
 * Simple Moving Average.
 */
export function sma(data: number[], period: number): number[] {
  if (data.length < period) return [];
  const result: number[] = [];

  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  result.push(sum / period);

  for (let i = period; i < data.length; i++) {
    sum += data[i] - data[i - period];
    result.push(sum / period);
  }

  return result;
}

/**
 * Exponential Moving Average.
 */
export function ema(data: number[], period: number): number[] {
  if (data.length < period) return [];

  const multiplier = 2 / (period + 1);
  const result: number[] = [];

  // Start with SMA for the first value
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  result.push(sum / period);

  for (let i = period; i < data.length; i++) {
    const prev = result[result.length - 1];
    result.push((data[i] - prev) * multiplier + prev);
  }

  return result;
}

// --- RSI ---

/**
 * Relative Strength Index (Wilder's method).
 */
export function rsi(closePrices: number[], period: number = 14): number[] {
  if (closePrices.length < period + 1) return [];

  const result: number[] = [];
  const gains: number[] = [];
  const losses: number[] = [];

  // Calculate price changes
  for (let i = 1; i < closePrices.length; i++) {
    const change = closePrices[i] - closePrices[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }

  // First average gain/loss
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  if (avgLoss === 0) {
    result.push(100);
  } else {
    const rs = avgGain / avgLoss;
    result.push(100 - 100 / (1 + rs));
  }

  // Subsequent values using Wilder's smoothing
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;

    if (avgLoss === 0) {
      result.push(100);
    } else {
      const rs = avgGain / avgLoss;
      result.push(100 - 100 / (1 + rs));
    }
  }

  return result;
}

// --- MACD ---

export interface MACDResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

/**
 * Moving Average Convergence Divergence.
 */
export function macd(
  closePrices: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): MACDResult {
  const fastEMA = ema(closePrices, fastPeriod);
  const slowEMA = ema(closePrices, slowPeriod);

  // Align arrays
  const offset = slowPeriod - fastPeriod;
  const macdLine: number[] = [];

  for (let i = 0; i < slowEMA.length; i++) {
    macdLine.push(fastEMA[i + offset] - slowEMA[i]);
  }

  const signalLine = ema(macdLine, signalPeriod);
  const signalOffset = macdLine.length - signalLine.length;
  const histogram: number[] = [];

  for (let i = 0; i < signalLine.length; i++) {
    histogram.push(macdLine[i + signalOffset] - signalLine[i]);
  }

  return {
    macd: macdLine,
    signal: signalLine,
    histogram,
  };
}

// --- ATR ---

/**
 * Average True Range.
 */
export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 14
): number[] {
  if (highs.length < period + 1) return [];

  const trueRanges: number[] = [];

  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);
  }

  // First ATR is simple average
  const result: number[] = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trueRanges[i];
  result.push(sum / period);

  // Subsequent values use Wilder's smoothing
  for (let i = period; i < trueRanges.length; i++) {
    const prev = result[result.length - 1];
    result.push((prev * (period - 1) + trueRanges[i]) / period);
  }

  return result;
}

// --- ADX ---

export interface ADXResult {
  adx: number[];
  plusDI: number[];
  minusDI: number[];
}

/**
 * Average Directional Index.
 */
export function adx(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 14
): ADXResult {
  if (highs.length < period * 2) return { adx: [], plusDI: [], minusDI: [] };

  const trueRanges: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);

    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];

    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder's smoothing for TR, +DM, -DM
  const smooth = (arr: number[], p: number): number[] => {
    const result: number[] = [];
    let sum = arr.slice(0, p).reduce((a, b) => a + b, 0);
    result.push(sum);
    for (let i = p; i < arr.length; i++) {
      sum = sum - sum / p + arr[i];
      result.push(sum);
    }
    return result;
  };

  const smoothTR = smooth(trueRanges, period);
  const smoothPlusDM = smooth(plusDMs, period);
  const smoothMinusDM = smooth(minusDMs, period);

  const plusDIArr: number[] = [];
  const minusDIArr: number[] = [];
  const dxArr: number[] = [];

  for (let i = 0; i < smoothTR.length; i++) {
    const pdi = smoothTR[i] > 0 ? (smoothPlusDM[i] / smoothTR[i]) * 100 : 0;
    const mdi = smoothTR[i] > 0 ? (smoothMinusDM[i] / smoothTR[i]) * 100 : 0;
    plusDIArr.push(pdi);
    minusDIArr.push(mdi);

    const diSum = pdi + mdi;
    dxArr.push(diSum > 0 ? (Math.abs(pdi - mdi) / diSum) * 100 : 0);
  }

  // ADX is smoothed DX
  const adxArr: number[] = [];
  if (dxArr.length >= period) {
    let sum = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    adxArr.push(sum);
    for (let i = period; i < dxArr.length; i++) {
      sum = (sum * (period - 1) + dxArr[i]) / period;
      adxArr.push(sum);
    }
  }

  return {
    adx: adxArr,
    plusDI: plusDIArr,
    minusDI: minusDIArr,
  };
}

// --- Supertrend ---

export interface SupertrendResult {
  supertrend: number[];
  direction: ('UP' | 'DOWN')[];
}

/**
 * Supertrend indicator.
 */
export function supertrend(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 10,
  multiplier: number = 3
): SupertrendResult {
  const atrValues = atr(highs, lows, closes, period);
  if (atrValues.length === 0) return { supertrend: [], direction: [] };

  // Align with ATR (ATR starts from index `period`)
  const startIdx = highs.length - atrValues.length;
  const result: number[] = [];
  const directions: ('UP' | 'DOWN')[] = [];

  let upperBand = 0;
  let lowerBand = 0;
  let prevUpperBand = 0;
  let prevLowerBand = 0;
  let prevSupertrend = 0;
  let prevDirection: 'UP' | 'DOWN' = 'UP';

  for (let i = 0; i < atrValues.length; i++) {
    const idx = startIdx + i;
    const hl2 = (highs[idx] + lows[idx]) / 2;

    const basicUpperBand = hl2 + multiplier * atrValues[i];
    const basicLowerBand = hl2 - multiplier * atrValues[i];

    if (i === 0) {
      upperBand = basicUpperBand;
      lowerBand = basicLowerBand;
      prevSupertrend = closes[idx] > upperBand ? lowerBand : upperBand;
      prevDirection = closes[idx] > upperBand ? 'UP' : 'DOWN';
    } else {
      upperBand = basicUpperBand < prevUpperBand || closes[idx - 1 + startIdx] > prevUpperBand
        ? basicUpperBand
        : prevUpperBand;

      lowerBand = basicLowerBand > prevLowerBand || closes[idx - 1 + startIdx] < prevLowerBand
        ? basicLowerBand
        : prevLowerBand;

      if (prevDirection === 'UP') {
        if (closes[idx] < lowerBand) {
          prevDirection = 'DOWN';
          prevSupertrend = upperBand;
        } else {
          prevSupertrend = lowerBand;
        }
      } else {
        if (closes[idx] > upperBand) {
          prevDirection = 'UP';
          prevSupertrend = lowerBand;
        } else {
          prevSupertrend = upperBand;
        }
      }
    }

    prevUpperBand = upperBand;
    prevLowerBand = lowerBand;

    result.push(prevSupertrend);
    directions.push(prevDirection);
  }

  return { supertrend: result, direction: directions };
}

// --- Bollinger Bands ---

export interface BollingerBandsResult {
  upper: number[];
  middle: number[];
  lower: number[];
  bandwidth: number[];
}

/**
 * Bollinger Bands.
 */
export function bollingerBands(
  closePrices: number[],
  period: number = 20,
  stdDevMultiplier: number = 2
): BollingerBandsResult {
  const middle = sma(closePrices, period);
  const upper: number[] = [];
  const lower: number[] = [];
  const bandwidth: number[] = [];

  for (let i = 0; i < middle.length; i++) {
    const slice = closePrices.slice(i, i + period);
    const mean = middle[i];
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
    const stdDev = Math.sqrt(variance);

    upper.push(mean + stdDevMultiplier * stdDev);
    lower.push(mean - stdDevMultiplier * stdDev);
    bandwidth.push(mean > 0 ? ((upper[i] - lower[i]) / mean) * 100 : 0);
  }

  return { upper, middle, lower, bandwidth };
}

// --- VWAP ---

/**
 * Volume Weighted Average Price.
 */
export function vwap(
  highs: number[],
  lows: number[],
  closes: number[],
  volumes: number[]
): number[] {
  const result: number[] = [];
  let cumulativeTPV = 0;
  let cumulativeVolume = 0;

  for (let i = 0; i < closes.length; i++) {
    const typicalPrice = (highs[i] + lows[i] + closes[i]) / 3;
    cumulativeTPV += typicalPrice * volumes[i];
    cumulativeVolume += volumes[i];

    result.push(cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : closes[i]);
  }

  return result;
}

// --- Pivot Points ---

export interface PivotPoints {
  pp: number;
  r1: number;
  r2: number;
  r3: number;
  s1: number;
  s2: number;
  s3: number;
}

/**
 * Classic Pivot Points.
 */
export function pivotPoints(high: number, low: number, close: number): PivotPoints {
  const pp = (high + low + close) / 3;
  return {
    pp,
    r1: 2 * pp - low,
    r2: pp + (high - low),
    r3: high + 2 * (pp - low),
    s1: 2 * pp - high,
    s2: pp - (high - low),
    s3: low - 2 * (high - pp),
  };
}
