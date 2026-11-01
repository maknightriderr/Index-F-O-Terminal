'use client';

import React from 'react';
import { PageBody, PageHeader } from '@/components/ui/card';
import { SimulatedNotice } from '@/components/ui/controls';
import { FreshStartPanel } from './fresh-start';

// ============================================================
// PAPER TRADES — the fresh-start cohort only
// ============================================================
// The retired legacy engines' trade ledger (and its automatic reviews) is no longer shown: those engines cannot
// create trades, and their history mixed with the new cohort was confusing. The rows stay in the database untouched.
// Open trades are on the Command Center; one trade in full is its trade detail.
// ============================================================

export function PaperTradesPage() {
  return (
    <PageBody>
      <PageHeader
        title="Paper Trades"
        subtitle="Fresh-start paper trades: entries, quote-backed fills, results after estimated costs, and the evidence behind each. Legacy-engine trades are retired and not shown."
      />
      <SimulatedNotice />
      <FreshStartPanel />
    </PageBody>
  );
}
