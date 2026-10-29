import { expect, it } from 'vitest';
import { trailingNote } from '../setup-trailing';
const state = { state: 'BREAKEVEN', breakevenAtR: 1, breakevenPremium: 427.9, lockAtR: 2, lockPremium: 492.08 };
it('does not advertise an unreachable next lock before the CRUDEOIL target', () => {
  expect(trailingNote(427.9, 363.72, 509.56, state)).toBe('SL at entry before costs. Target is reached before the next trailing step.');
});
it('distinguishes the trigger premium from the locked stop', () => {
  expect(trailingNote(427.9, 363.72, 600, state)).toContain('at premium ₹556.26, SL locks to ₹492.08');
});
it('does not advertise breakeven when the target arrives first', () => {
  expect(trailingNote(427.9, 363.72, 480, { ...state, state: 'INITIAL' })).toBe('Target is reached before the breakeven trailing step.');
});
