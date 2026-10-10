'use client';

import React from 'react';
import { PageBody, PageHeader, Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';

/**
 * A page that is reachable but not built. It says so plainly: no feature list implying it works, no preview data.
 * (Positions and Settings were empty "Coming soon" placeholders in the sidebar; they are no longer listed there.)
 */
export function UnbuiltPage({ title, description }: { title: string; description: string }) {
  return (
    <PageBody>
      <PageHeader title={title} subtitle={description} />
      <Card>
        <StatusBadge tone="off" label="NOT IMPLEMENTED" />
        <p className="mt-3 text-sm text-[var(--text-secondary)]">This part of the terminal has not been built yet. Nothing on this page is live or simulated.</p>
      </Card>
    </PageBody>
  );
}
