// ============================================================
// LOCATION QUALITY & ROOM TO RUN
// ============================================================
// Two questions the engine never asked before entering:
//
//   1. Is this a good PLACE to enter? A bullish break with a heavy call wall
//      two points overhead is not the same trade as one with clear air above,
//      even when the direction read is identical.
//   2. Is there ROOM for the target? If the nearest obstacle is 0.8 ATR away
//      and the target needs 1.8 ATR, the trade cannot pay even if the
//      direction is right.
//
// Pure functions: levels in, score and reasons out. The engine already
// computes the levels themselves (OI walls, pivots, VWAP, day and previous-day
// extremes) — this only judges where price sits among them.
//
// SHADOW ONLY for now. Both readings are recorded on every setup and refusal
// so their predictive value can be measured on live trades before either is
// allowed to block anything. The room-to-run cap that already exists (the
// target is trimmed to the nearest strong wall or pivot) stays in force.
// ============================================================

import type { BiasDirection } from '@fno/shared';

export interface StructuralLevel {
  price: number;
  /** Where it came from, for the explanation line. */
  kind: 'OI_WALL' | 'PIVOT' | 'VWAP' | 'DAY_HIGH' | 'DAY_LOW' | 'PREV_DAY_HIGH' | 'PREV_DAY_LOW' | 'OPENING_RANGE_HIGH' | 'OPENING_RANGE_LOW';
  /** 0-100 where known (OI wall strength). Undefined for price levels, which are treated as moderate. */
  strengthPct?: number;
}

export interface LocationInput {
  spot: number;
  direction: BiasDirection;
  atrPoints: number | null;
  levels: StructuralLevel[];
}

export interface LocationAssessment {
  /** 0-100. High means clear room ahead and support behind; low means entering into a wall. */
  score: number;
  /** Nearest obstacle in the trade's direction. */
  nearestAhead: StructuralLevel | null;
  aheadAtr: number | null;
  /** Nearest level behind the entry — what the trade can lean on. */
  nearestBehind: StructuralLevel | null;
  behindAtr: number | null;
  reasons: string[];
}

export interface RoomAssessment {
  /** Space to the first obstacle, in ATR. Null when nothing is known. */
  availableAtr: number | null;
  /** What the target needs, in ATR. */
  requiredAtr: number | null;
  sufficient: boolean | null;
  reason: string;
}

/** Below this the entry is effectively touching the obstacle. */
export const CRAMPED_AHEAD_ATR = 0.75;
/** At or above this there is genuine room to run. */
export const CLEAR_AHEAD_ATR = 2;
/** Room has to exceed the required move by this much to count as sufficient. */
export const ROOM_MARGIN = 1.15;

const describe = (kind: StructuralLevel['kind']) =>
  ({
    OI_WALL: 'OI wall', PIVOT: 'pivot', VWAP: 'VWAP', DAY_HIGH: "the day's high", DAY_LOW: "the day's low",
    PREV_DAY_HIGH: "yesterday's high", PREV_DAY_LOW: "yesterday's low", OPENING_RANGE_HIGH: 'the opening-range high', OPENING_RANGE_LOW: 'the opening-range low',
  })[kind];

export function assessLocation(input: LocationInput): LocationAssessment {
  const { spot, direction, atrPoints, levels } = input;
  const reasons: string[] = [];
  if (direction === 'NEUTRAL' || !(spot > 0)) {
    return { score: 50, nearestAhead: null, aheadAtr: null, nearestBehind: null, behindAtr: null, reasons: ['No direction to judge location against.'] };
  }
  const bullish = direction === 'BULLISH';
  const ahead = levels.filter((l) => (bullish ? l.price > spot : l.price < spot)).sort((a, b) => Math.abs(a.price - spot) - Math.abs(b.price - spot));
  const behind = levels.filter((l) => (bullish ? l.price < spot : l.price > spot)).sort((a, b) => Math.abs(a.price - spot) - Math.abs(b.price - spot));
  const nearestAhead = ahead[0] ?? null;
  const nearestBehind = behind[0] ?? null;
  const atr = atrPoints && atrPoints > 0 ? atrPoints : null;
  const aheadAtr = nearestAhead && atr ? Math.abs(nearestAhead.price - spot) / atr : null;
  const behindAtr = nearestBehind && atr ? Math.abs(spot - nearestBehind.price) / atr : null;

  let score = 50;
  if (aheadAtr == null) {
    reasons.push('No level ahead within the chain or pivot set — treating room as unknown.');
  } else if (aheadAtr < CRAMPED_AHEAD_ATR) {
    score -= 30;
    reasons.push(`Entering ${aheadAtr.toFixed(2)} ATR under ${describe(nearestAhead!.kind)} at ${nearestAhead!.price.toFixed(0)} — almost no room before the first obstacle.`);
  } else if (aheadAtr >= CLEAR_AHEAD_ATR) {
    score += 25;
    reasons.push(`Clear air: ${aheadAtr.toFixed(2)} ATR to ${describe(nearestAhead!.kind)} at ${nearestAhead!.price.toFixed(0)}.`);
  } else {
    score += 5;
    reasons.push(`${aheadAtr.toFixed(2)} ATR to ${describe(nearestAhead!.kind)} at ${nearestAhead!.price.toFixed(0)} — workable but not open.`);
  }

  if (behindAtr != null && behindAtr < 0.5) {
    score += 15;
    reasons.push(`${describe(nearestBehind!.kind)} sits ${behindAtr.toFixed(2)} ATR behind — close support to lean on and to place an invalidation against.`);
  } else if (behindAtr != null && behindAtr > 3) {
    score -= 10;
    reasons.push(`Nothing behind for ${behindAtr.toFixed(2)} ATR — no structure to define where this trade is wrong.`);
  }

  // A strong wall immediately ahead is the worst case: it is what "entering
  // into resistance" means.
  if (nearestAhead?.kind === 'OI_WALL' && (nearestAhead.strengthPct ?? 0) >= 70 && (aheadAtr ?? 99) < 1) {
    score -= 15;
    reasons.push(`That obstacle is a ${nearestAhead.strengthPct}%-strength OI wall, the kind price tends to stall at rather than cut through.`);
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), nearestAhead, aheadAtr, nearestBehind, behindAtr, reasons };
}

/** Does the space ahead cover the move the target needs? */
export function assessRoom(availableAtr: number | null, requiredAtr: number | null): RoomAssessment {
  if (availableAtr == null || requiredAtr == null || !(requiredAtr > 0)) {
    return { availableAtr, requiredAtr, sufficient: null, reason: 'Room cannot be judged — no ATR or no level ahead to measure to.' };
  }
  const sufficient = availableAtr >= requiredAtr * ROOM_MARGIN;
  return {
    availableAtr,
    requiredAtr,
    sufficient,
    reason: sufficient
      ? `${availableAtr.toFixed(2)} ATR of room against ${requiredAtr.toFixed(2)} ATR needed for the target.`
      : `Only ${availableAtr.toFixed(2)} ATR of room before the first obstacle, but the target needs ${requiredAtr.toFixed(2)} ATR — the move has nowhere to go.`,
  };
}
