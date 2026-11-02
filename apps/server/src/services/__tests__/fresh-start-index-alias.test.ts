import { describe, expect, it } from 'vitest';
import { KNOWN_INDEX_TOKENS } from '@fno/shared';
import { FRESH_INDEX_TOKEN_ALIASES } from '../fresh-start/markets.js';

describe('fresh-start index spot aliases (2 Nov: BLOCKED_EXACT_PRICING_REFERENCE)', () => {
  it('maps every aliased option name to a known index token', () => {
    for (const [name, key] of Object.entries(FRESH_INDEX_TOKEN_ALIASES)) expect(KNOWN_INDEX_TOKENS[key], name).toBeTruthy();
    expect(FRESH_INDEX_TOKEN_ALIASES.NIFTYNXT50).toBe('NIFTYNEXT50');
  });
});
