'use client';

import React from 'react';
import { PageBody, PageHeader } from '@/components/ui/card';
import { useMarketStore } from '@/stores';

/** What an old bookmark to a retired legacy page shows: the engines are off, and where the new work lives. */
export function RetiredPage({ title }: { title: string }) {
  const go = useMarketStore((s) => s.setActiveTab);
  return (
    <PageBody>
      <PageHeader title={title} subtitle="This page belonged to the retired legacy engines (Old Indicator, S1, A2–F3, OB1, OF1 and experiment arms). They no longer create setups or paper trades, so the page is no longer shown." />
      <div className="cc-panel flex flex-wrap items-center gap-3 px-4 py-4">
        <p className="m-0 flex-1 text-sm text-[var(--text-secondary)]">New setups and paper trades come only from the fresh-start strategies.</p>
        <button type="button" className="cc-chip" onClick={() => go('dashboard')}>Command Center</button>
        <button type="button" className="cc-chip" onClick={() => go('strategy-lab')}>Strategy Lab</button>
        <button type="button" className="cc-chip" onClick={() => go('paper-trades')}>Paper Trades</button>
      </div>
    </PageBody>
  );
}
