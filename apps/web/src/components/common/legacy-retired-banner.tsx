'use client';

import React from 'react';

/** Legacy engines' setups still render for history, but they can no longer create paper trades. */
export function LegacyRetiredBanner() {
  return (
    <div
      role="note"
      className="rounded-lg border border-amber-500/40 light:border-amber-600/40 bg-amber-500/10 light:bg-amber-50 px-3 py-2 text-xs text-amber-200 light:text-amber-900"
    >
      <span className="font-semibold">Legacy engines retired.</span>{' '}
      Old Indicator, S1, A2–F3, OB1, OF1 and experiment arms no longer create paper trades. Their setups below are
      shown for history, and a <span className="font-mono">RISK_OFF</span> refusal here means &ldquo;retired&rdquo;, not a market
      condition. New paper trades come only from the fresh-start section under Paper trades.
    </div>
  );
}
