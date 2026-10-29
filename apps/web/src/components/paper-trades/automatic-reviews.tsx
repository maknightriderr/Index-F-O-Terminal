'use client';

import React, { useEffect, useState } from 'react';
import type { AutoReviewReport, AutoReviewResult } from '@fno/shared';
import { api } from '@/lib/api';
import { Section, MetricGrid, MetricTile } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { ErrorNotice } from '@/components/ui/data-state';
import { formatIstDateTime, formatR } from '@/lib/format';

const names: Record<string, string> = { COST_ERASED_GAIN: 'Costs erased gross gain', STOP_OVERSHOOT: 'Exit beyond planned stop',
  LOW_SAMPLED_MFE: 'Limited sampled favourable move', SAMPLED_GIVEBACK: 'Sampled profit giveback', WIDE_RECORDED_SPREAD: 'Wide recorded entry spread', DATA_GAPS: 'Evidence gaps' };
function ReviewDetails({ row }: { row: AutoReviewResult }) {
  return <div className="space-y-3 whitespace-normal break-words text-sm">
    <p>Source {row.source_version} · Rules {row.logic_version} · {row.exchange} {row.mode}</p>
    {row.status !== 'COMPLETE' ? <p>{row.last_error ?? 'Automatic review queued.'} Attempts {row.attempts}; next eligible run {formatIstDateTime(Date.parse(row.next_attempt_at))}. Expired worker leases recover automatically.</p> : <>
      <p className="font-medium">AI interpretation · {row.provider} · {row.model}</p>
      <p>{row.review?.summary}</p>
      {(row.review?.hypotheses ?? []).map((h, i) => <div key={i} className="rounded border border-[var(--border-secondary)] p-3">
        <p><strong>Hypothesis:</strong> {h.explanation}</p>
        <p>Evidence references: {h.evidenceIds.join(', ')}</p>
        <p><strong>Proposed experiment (not applied):</strong> {h.experiment}</p>
      </div>)}
      {row.review?.hypotheses.length === 0 && <p>No evidence-supported hypothesis was proposed. A loss alone does not establish a mistake.</p>}
      <p className="font-medium">Recorded evidence</p>
      <ul className="list-disc space-y-1 pl-5">{(row.evidence?.facts ?? []).map(f => <li key={f.id}><strong>{f.id}:</strong> {f.text}</li>)}</ul>
      {!!row.evidence?.missing.length && <p>Missing evidence: {row.evidence.missing.join(' ')}</p>}
    </>}
  </div>;
}

export function AutomaticTradeReviews() {
  const [data, setData] = useState<AutoReviewReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const load = () => api.getAutomaticTradeReviews().then(r => { if (active) { setData(r); setError(null); } }).catch(() => { if (active) setError('Automatic review status could not be loaded. This panel retries every minute.'); });
    void load(); const timer = setInterval(load, 60000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const counts = data?.counts ?? {};
  return <Section title="Automatic AI Trade Review" subtitle="Closed trades are investigated automatically, including winners and expired exits. No review button or manual retry is required.">
    {error && <ErrorNotice title="Review status unavailable" detail={error} />}
    {!data && !error && <p role="status">Loading automatic reviews…</p>}
    {data && !data.available && <p>Automatic review storage is not ready in this backend build. Status refreshes automatically.</p>}
    {data?.available && <>
      <p className="mb-3 text-sm text-[var(--text-secondary)]">{data.version} · Automation {data.enabled ? 'on' : 'paused'} · AI {data.aiConfigured ? 'configured' : 'not configured — jobs stay queued'}. {data.scope}</p>
      <MetricGrid min={130}>
        <MetricTile label="Reviewed" value={counts.COMPLETE ?? 0} />
        <MetricTile label="Queued" value={counts.PENDING ?? 0} />
        <MetricTile label="Reviewing" value={counts.RUNNING ?? 0} />
        <MetricTile label="Automatic retry" value={counts.RETRY ?? 0} />
      </MetricGrid>
      <p className="my-3 text-sm text-[var(--text-secondary)]">Latest 100 jobs below. Issues are recorded observations, not confirmed causes or coding defects. AI hypotheses do not change entries, exits, risk or learning rules. Missing data is never inferred.</p>
      <DataTable rows={data.recent ?? []} rowKey={r => r.signal_id} ariaLabel="Automatic trade reviews" pageSize={10} emptyTitle="No closed trades queued yet" columns={[
        { id: 'symbol', header: 'Trade', cell: r => <span>{r.symbol}<small className="block text-[var(--text-secondary)]">{r.signal_id.slice(0,8)}</small></span> },
        { id: 'source', header: 'Strategy / version', cell: r => `${r.strategy} · ${r.source_version}` },
        { id: 'status', header: 'Review status', cell: r => r.status },
        { id: 'net', header: 'Net P&L (R)', numeric: true, cell: r => formatR(r.evidence?.netR) },
        { id: 'summary', header: 'AI summary', cell: r => <span className="block max-w-md whitespace-normal break-words">{r.status === 'COMPLETE' ? r.review?.summary ?? 'Unavailable' : 'Automatic processing / retry'}</span> },
        { id: 'time', header: 'Reviewed (IST)', cell: r => formatIstDateTime(r.completed_at ? Date.parse(r.completed_at) : null) },
      ]} renderDetail={r => <ReviewDetails row={r} />} />
      <h3 className="mb-2 mt-5 text-sm font-semibold">Repeated observations · winners and losers compared</h3>
      <DataTable rows={data.repeated ?? []} rowKey={r => JSON.stringify([r.strategy,r.source_version,r.logic_version,r.exchange,r.mode,r.code])} ariaLabel="Repeated trade review issues" pageSize={10} emptyTitle="No repeated observations recorded yet" columns={[
        { id: 'strategy', header: 'Strategy / version', cell: r => <span>{r.strategy} · {r.source_version}<small className="block break-all text-[var(--text-secondary)]">{r.logic_version} · {r.exchange} {r.mode}</small></span> },
        { id: 'issue', header: 'Observed pattern', cell: r => names[r.code] ?? r.code },
        { id: 'n', header: 'Trades with pattern', numeric: true, cell: r => r.trades },
        { id: 'wins', header: 'Profitable', numeric: true, cell: r => r.profitable },
        { id: 'loss', header: 'Losing', numeric: true, cell: r => r.losing },
        { id: 'net', header: 'Net R / measured', numeric: true, cell: r => `${formatR(r.net_r)} / ${r.measured}` },
      ]} />
      <p className="mt-3 text-sm text-[var(--text-secondary)]">Repeated rows require at least two completed reviews in the same strategy/version, exchange and mode. One trade can have multiple observations: do not add these rows as portfolio P&L. Samples are not matched controls and do not establish an edge.</p>
    </>}
  </Section>;
}
