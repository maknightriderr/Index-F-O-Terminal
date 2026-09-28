// ============================================================
// PATH GRADING (pure)
// ============================================================
// The bar loop that used to live inline in missed-winner-audit.ts's
// gradeDecision, extracted so the momentum-break backtest grades trades with
// exactly the same rule. gradeDecision now calls gradeThesis, whose output is
// byte-identical to the old inline code (grade-path.test.ts holds that).
//
// The rule: walk the bars after entry; track the best and worst excursion;
// the first bar that reaches the stop or the target settles it. Within one
// bar there is no way to know which side printed first, so a bar that spans
// both is scored as the STOP — the conservative reading.
// ============================================================

export interface GradeBar {
  high: number;
  low: number;
  close: number;
}

export interface GradePathResult {
  hitStop: boolean;
  hitTarget: boolean;
  /** An optional close-based exit fired first (e.g. the broken level was reclaimed). */
  invalidated: boolean;
  /** 0-based index into `bars` of the bar that settled the trade; null when nothing did (ran to the last bar). */
  exitIndex: number | null;
  /** Stop, target, the invalidating close, or the last bar's close. */
  exitPrice: number | null;
  /** In stop distances: -1 at the stop, target distance ÷ stop distance at the target, else the final move. */
  settledR: number;
  /** Best/worst excursion in price points. */
  mfe: number;
  mae: number;
  /** 1-based bar counts; null when never reached. */
  barsToMfe: number | null;
  barsToTarget: number | null;
}

export interface GradePathOptions {
  /** Checked on each bar's close after the stop/target test: true exits at that close. */
  invalidateOnClose?: (bar: GradeBar, index: number) => boolean;
}

export function gradePath(
  bars: readonly GradeBar[],
  direction: 1 | -1,
  entry: number,
  stopLevel: number,
  targetLevel: number,
  options: GradePathOptions = {}
): GradePathResult {
  let mfe = 0;
  let mae = 0;
  let hitTarget = false;
  let hitStop = false;
  let invalidated = false;
  let exitIndex: number | null = null;
  let exitPrice: number | null = null;
  let barsToMfe: number | null = null;
  let barsToTarget: number | null = null;
  let barIndex = 0;

  for (const c of bars) {
    barIndex++;
    const favourable = direction > 0 ? c.high - entry : entry - c.low;
    const adverse = direction > 0 ? entry - c.low : c.high - entry;
    if (favourable > mfe) { mfe = favourable; barsToMfe = barIndex; }
    if (adverse > mae) mae = adverse;

    const stopped = direction > 0 ? c.low <= stopLevel : c.high >= stopLevel;
    const targeted = direction > 0 ? c.high >= targetLevel : c.low <= targetLevel;
    if (stopped) { hitStop = true; exitIndex = barIndex - 1; exitPrice = stopLevel; break; }
    if (targeted) { hitTarget = true; barsToTarget = barIndex; exitIndex = barIndex - 1; exitPrice = targetLevel; break; }
    if (options.invalidateOnClose?.(c, barIndex - 1)) { invalidated = true; exitIndex = barIndex - 1; exitPrice = c.close; break; }
  }

  const risk = Math.abs(entry - stopLevel);
  let settledR: number;
  if (hitStop) settledR = -1;
  else if (hitTarget) settledR = risk > 0 ? Math.abs(targetLevel - entry) / risk : 0;
  else {
    const last = invalidated && exitIndex != null ? bars[exitIndex] : bars[bars.length - 1];
    if (!invalidated && last) exitPrice = last.close;
    const finalMove = last ? (direction > 0 ? last.close - entry : entry - last.close) : 0;
    settledR = risk > 0 ? finalMove / risk : 0;
  }

  return { hitStop, hitTarget, invalidated, exitIndex, exitPrice, settledR, mfe, mae, barsToMfe, barsToTarget };
}

export interface ThesisGrade {
  hitStop: boolean;
  hitTarget: boolean;
  settledR: number;
  mfeAtr: number;
  maeAtr: number;
  mfeR: number;
  barsToMfe: number | null;
  barsToTarget: number | null;
}

/**
 * gradeDecision's numeric grading, pure. Levels are entry ± ATR multiples on
 * the underlying; R is settled against the stop distance. Kept on the exact
 * arithmetic the audit always used (target R as targetAtr/stopAtr, the final
 * move over stopAtr·atr) so every graded row is unchanged.
 */
export function gradeThesis(args: {
  entry: number;
  atr: number;
  direction: 1 | -1;
  stopAtr: number;
  targetAtr: number;
  candles: readonly GradeBar[];
}): ThesisGrade {
  const { entry, atr, direction, stopAtr, targetAtr, candles } = args;
  const stopLevel = entry - direction * stopAtr * atr;
  const targetLevel = entry + direction * targetAtr * atr;
  const path = gradePath(candles, direction, entry, stopLevel, targetLevel);

  const riskPoints = stopAtr * atr;
  let settledR: number;
  if (path.hitStop) settledR = -1;
  else if (path.hitTarget) settledR = targetAtr / stopAtr;
  else {
    // Neither level was reached inside the horizon. The thesis went as far
    // as it went; score it at its final mark rather than pretending it was
    // flat, because "did not resolve" is itself an outcome.
    const last = candles[candles.length - 1];
    const finalMove = direction > 0 ? last.close - entry : entry - last.close;
    settledR = riskPoints > 0 ? finalMove / riskPoints : 0;
  }

  return {
    hitStop: path.hitStop,
    hitTarget: path.hitTarget,
    settledR,
    mfeAtr: path.mfe / atr,
    maeAtr: path.mae / atr,
    mfeR: riskPoints > 0 ? path.mfe / riskPoints : 0,
    barsToMfe: path.barsToMfe,
    barsToTarget: path.barsToTarget,
  };
}
