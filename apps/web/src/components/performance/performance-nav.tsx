'use client';

import React from 'react';
import { useMarketStore } from '@/stores';
import { PERFORMANCE_PAGES, pageMeta, type PageId } from '@/lib/nav';
import { TabStrip, Disclosure } from '@/components/ui/controls';

/** The tab strip every Performance page carries, so Backtesting, Loss Attribution, Signal Diagnostics and Measurement read as one area. */
export function PerformanceNav() {
  const activeTab = useMarketStore((s) => s.activeTab);
  const setActiveTab = useMarketStore((s) => s.setActiveTab);
  const tabs = PERFORMANCE_PAGES.map((id) => ({ id, label: pageMeta(id)?.label ?? id, title: pageMeta(id)?.description }));
  return (
    <nav aria-label="Performance area" className="px-4 pt-4 md:px-6">
      <TabStrip<PageId> value={(PERFORMANCE_PAGES.includes(activeTab as PageId) ? activeTab : 'backtesting') as PageId} tabs={tabs} onChange={(id) => setActiveTab(id)} label="Performance views" />
    </nav>
  );
}

/**
 * What each figure means. Several of them describe the SAME trades with different denominators or different sources, and
 * they are not interchangeable. This is shown wherever they sit near each other.
 */
export function MetricDefinitions() {
  return (
    <Disclosure summary="What do these rates mean? (they are not interchangeable)">
      <p>
        <strong>Closed-trade win rate</strong>: wins ÷ (wins + losses). Expired trades are left out, so this looks best and is the least complete figure.
      </p>
      <p>
        <strong>All-trade win rate</strong>: wins ÷ (wins + losses + expired). Expired trades count as not winning. This is the honest rate for what actually happened.
      </p>
      <p>
        <strong>Target-hit rate</strong>: the share of closed trades (excluding expired) whose exit was the target. It says nothing about money after costs.
      </p>
      <p>
        <strong>Profitability rate</strong>: the share of trades that ended with a positive result after the estimated cost. A trade can hit its target and still lose after costs.
      </p>
      <p>
        <strong>Shadow outcomes</strong>: what a rule or family would have done, measured on recorded data. They are never trades and are never added to the paper-trade figures.
      </p>
      <p>
        <strong>Net R</strong> subtracts an <em>estimated</em> cost (a model, not an actual fill). It covers only trades that have a cost recorded, so compare it with the gross R of the same trades, not with a gross figure over a different set.
      </p>
      <p>A group with fewer than 30 closed trades is a sample, not evidence: do not read it as a profitable or an unprofitable strategy.</p>
    </Disclosure>
  );
}
