'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useLiveIndices } from '@/lib/use-live-indices';
import { useAllIndices } from '@/lib/use-all-indices';
import { useFnoScanner } from '@/lib/use-fno-scanner';
import { useMarketBias } from '@/lib/use-market-bias';
import { useInstitutionalFlow } from '@/lib/use-institutional-flow';
import { useFiiDii } from '@/lib/use-fii-dii';
import { useFiiDiiHistory } from '@/lib/use-fii-dii-history';
import { useOptionChainSummary } from '@/lib/use-option-chain-summary';
import { useChartPatterns } from '@/lib/use-chart-patterns';
import { useFeedSummary } from '@/lib/use-feed-summary';
import { useHealth } from '@/lib/use-health';
import { ChartPatternsPanel } from '@/components/common/chart-patterns-panel';
import { PageBody, PageHeader, Section } from '@/components/ui/card';
import { WatchlistPanel } from './watchlist-panel';
import { StatusBar } from './sections/status-bar';
import { RegimeSummary } from './sections/regime-summary';
import { PaperTradesPanel } from './sections/paper-trades-panel';
import { BestSetupsPanel } from './sections/best-setups-panel';
import { ChartSection, INSTRUMENTS } from './sections/chart-section';
import { FiiDiiPanel, OptionsPanel, TopMoversPanel, RiskSentimentPanel, FnoScreenerPanel } from './sections/secondary';

// ============================================================
// DASHBOARD — action first
// ============================================================
//   A  Market and feed status       how current is the data, per feed and exchange session
//   B  Market regime                what the engine last concluded, from where, and when
//   C  My paper trades              simulated trades open now and closed today
//   D  Best current setups          recorded candidates and whether they can trade
//   E  Main chart                   with a legend of the overlays the recorded data supports
//   F  Secondary market information FII/DII, options OI, movers, risk, screener — collapsible
// Everything reads recorded data only: opening or refreshing this page never runs the engine, a scan or a write.
// ============================================================

export function Dashboard() {
  const feed = useFeedSummary();
  const { data: healthData } = useHealth();
  const { indices } = useLiveIndices();
  const { indices: allIndices } = useAllIndices();
  const { rows: fnoRows } = useFnoScanner('NSE');
  const { patterns, loading: patternsLoading } = useChartPatterns();
  const { data: fiiDii } = useFiiDii();
  const { data: fiiDiiHistory } = useFiiDiiHistory(20);
  const { snapshot: sentiment } = useInstitutionalFlow();

  const [instrumentIdx, setInstrumentIdx] = useState(0);
  const instrument = INSTRUMENTS[instrumentIdx];
  const [selectedExpiry, setSelectedExpiry] = useState<string | undefined>(undefined);
  useEffect(() => {
    setSelectedExpiry(undefined); // nearest expiry whenever the instrument changes
  }, [instrument.symbol]);
  const { data: optionSummary, availableExpiries, currentExpiry } = useOptionChainSummary(instrument.symbol, instrument.exchange, selectedExpiry);
  const state = useMarketBias(instrument.symbol, instrument.exchange);

  const vixQuote = allIndices.find((i) => i.symbol === 'INDIAVIX') ?? null;
  const quote = allIndices.find((i) => i.symbol === instrument.symbol) ?? indices.find((i) => i.symbol === instrument.symbol) ?? null;

  const breadth = useMemo(() => {
    const advances = fnoRows.filter((r) => r.changePercent > 0).length;
    const declines = fnoRows.filter((r) => r.changePercent < 0).length;
    const total = fnoRows.length;
    const withSpread = fnoRows.filter((r) => r.atmSpreadPct != null);
    return {
      advances,
      declines,
      advPercent: total ? Math.round((advances / total) * 100) : 0,
      avgSpread: withSpread.length ? withSpread.reduce((a, r) => a + (r.atmSpreadPct ?? 0), 0) / withSpread.length : null,
      has: total > 0,
    };
  }, [fnoRows]);

  const orderFlowStatus = healthData?.orderFlow?.status ?? null;

  return (
    <PageBody>
      <PageHeader title="Dashboard" subtitle="Is the data current, what is the market doing, what are my paper trades doing, and which setups are worth a look." />

      <StatusBar />

      <RegimeSummary
        label={instrument.label}
        exchange={instrument.exchange}
        state={state}
        sentiment={{ score: sentiment?.sentimentScore ?? null, label: sentiment?.sentimentLabel ?? null }}
        vix={vixQuote?.ltp ?? null}
        atmIv={optionSummary?.atmIv ?? null}
        breadth={breadth.has ? { advances: breadth.advances, declines: breadth.declines, advPercent: breadth.advPercent } : null}
        now={feed.now}
      />

      <div className="grid grid-cols-1 gap-5 2xl:grid-cols-2">
        <PaperTradesPanel />
        <BestSetupsPanel />
      </div>

      <ChartSection instrumentIdx={instrumentIdx} onInstrument={setInstrumentIdx} quote={quote} state={state} orderFlowStatus={orderFlowStatus} />

      <Section title="More market information" subtitle="Secondary context. Each block can be collapsed.">
        <div className="space-y-5">
          <FiiDiiPanel today={fiiDii} history={fiiDiiHistory} />
          <OptionsPanel label={instrument.label} summary={optionSummary} availableExpiries={availableExpiries} currentExpiry={currentExpiry} onExpiryChange={setSelectedExpiry} />
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <TopMoversPanel rows={fnoRows} />
            <div className="space-y-5">
              <WatchlistPanel allIndices={allIndices} fnoRows={fnoRows} />
              <RiskSentimentPanel vix={vixQuote} breadth={breadth} bias={state.bias} biasLive={state.isLive} sentiment={sentiment} />
            </div>
          </div>
          <FnoScreenerPanel rows={fnoRows} />
          <ChartPatternsPanel patterns={patterns} loading={patternsLoading} />
        </div>
      </Section>
    </PageBody>
  );
}
