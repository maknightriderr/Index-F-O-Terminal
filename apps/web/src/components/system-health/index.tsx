'use client';

import React, { useMemo } from 'react';
import { PageBody, PageHeader, Section } from '@/components/ui/card';
import { ActionButton } from '@/components/ui/controls';
import { DataTable, type Column } from '@/components/ui/data-table';
import { ErrorNotice } from '@/components/ui/data-state';
import { HealthBadge, FreshnessBadge, StatusBadge } from '@/components/ui/status-badge';
import { useFeedSummary } from '@/lib/use-feed-summary';
import { useHealth } from '@/lib/use-health';
import { formatAge, formatIstDateTime, MISSING } from '@/lib/format';
import type { FeedRow, HealthRow } from '@/lib/health-model';

// ============================================================
// SYSTEM HEALTH — what is actually known, and how we know it
// ============================================================
// Each row has a status AND its evidence. "API unreachable" is one finding about the connection from this browser,
// never a list of services declared down. Services that do not exist yet are listed as planned, not as failures.
// A feed that is idle because the market is closed says so. The server-side flows below read /api/health; where that
// response lacks the evidence, the row says UNAVAILABLE rather than guessing.
// ============================================================

export function SystemHealthPage() {
  const feed = useFeedSummary();
  const { loading, refresh, fetchedAt } = useHealth();
  const m = feed.health;

  const serviceColumns = useMemo<Column<HealthRow>[]>(
    () => [
      { id: 'name', header: 'Component', cell: (r) => <span className="font-medium text-[var(--text-primary)]">{r.name}</span> },
      { id: 'status', header: 'Status', cell: (r) => <HealthBadge status={r.status} detail={r.detail} /> },
      { id: 'detail', header: 'Evidence', cell: (r) => <span className="text-[var(--text-secondary)]">{r.detail}</span> },
      { id: 'observed', header: 'Observed', hideBelow: 'md', cell: (r) => (r.observedAt ? <span className="whitespace-nowrap text-xs">{formatIstDateTime(r.observedAt, feed.now)}</span> : MISSING) },
    ],
    [feed.now]
  );

  const feedColumns = useMemo<Column<FeedRow>[]>(
    () => [
      { id: 'token', header: 'Token', sortValue: (r) => r.token, cell: (r) => <span className="font-mono text-xs">{r.token}</span> },
      { id: 'exchange', header: 'Exchange', sortValue: (r) => r.exchange, cell: (r) => r.exchange },
      { id: 'status', header: 'Status', sortValue: (r) => r.freshness, cell: (r) => <FreshnessBadge state={r.freshness} detail={r.detail} /> },
      {
        id: 'last',
        header: 'Last tick (IST)',
        sortValue: (r) => r.lastTickAt,
        cell: (r) => (r.lastTickAt ? <span className="whitespace-nowrap">{formatIstDateTime(r.lastTickAt, feed.now)} <span className="text-xs text-[var(--text-secondary)]">({formatAge(feed.now - r.lastTickAt)})</span></span> : MISSING),
      },
      { id: 'detail', header: 'Note', hideBelow: 'md', cell: (r) => <span className="text-[var(--text-secondary)]">{r.detail}</span> },
    ],
    [feed.now]
  );

  return (
    <PageBody>
      <PageHeader
        title="System Health"
        subtitle="Service and data-feed status from observed evidence: timestamps, exchange sessions and what the server reports. Where the evidence is missing the status says so."
        actions={<ActionButton onClick={refresh}>{loading ? 'Checking…' : 'Check now'}</ActionButton>}
      />

      {!m.apiReachable ? (
        <ErrorNotice
          title="API unreachable"
          detail={`${m.headline} Only what this browser can observe is shown below; the server's services (Redis, database, broker, feeds) cannot be checked until the connection returns, so none of them is reported as down.`}
          onRetry={refresh}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--border-secondary)] bg-[var(--surface-card)] px-4 py-3">
          <HealthBadge status={m.overall} />
          <p className="text-sm text-[var(--text-primary)]">{m.headline}</p>
          {fetchedAt && <p className="ml-auto text-xs text-[var(--text-secondary)]">Checked {formatIstDateTime(fetchedAt, feed.now)}</p>}
        </div>
      )}

      {m.sessions.length > 0 && (
        <Section title="Exchange sessions" subtitle="Feeds are only expected to update while their exchange is in session.">
          <div className="flex flex-wrap gap-3">
            {m.sessions.map((s) => (
              <div key={s.exchange} className="flex items-center gap-2 rounded-lg border border-[var(--border-primary)] px-3 py-2 text-sm">
                <span className="font-medium">{s.exchange}</span>
                <StatusBadge tone={s.open ? 'ok' : 'info'} label={s.open ? 'IN SESSION' : 'CLOSED'} />
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="Services" subtitle="Each component with its status and the evidence behind it.">
        <DataTable columns={serviceColumns} rows={m.rows} rowKey={(r) => r.id} ariaLabel="Services and their status" pageSize={50} />
      </Section>

      {m.feed.length > 0 && (
        <Section title="Market-data feed" subtitle="Per token, from the last tick and the token's own exchange session. A closed market's last tick is not a failure, and a connected socket is not evidence of a current price.">
          <DataTable columns={feedColumns} rows={m.feed} rowKey={(r) => `${r.exchange}:${r.token}`} ariaLabel="Market-data feed by token" pageSize={25} initialSort={{ id: 'status', dir: 'desc' }} />
        </Section>
      )}

      <Section title="Planned services" subtitle="Not built yet. These are not failures." collapsible defaultOpen={false}>
        <DataTable columns={serviceColumns.slice(0, 3)} rows={m.planned} rowKey={(r) => r.id} ariaLabel="Planned services" pageSize={20} />
      </Section>
    </PageBody>
  );
}
