'use client';

// ============================================================
// SIGNAL DIAGNOSTICS
// ============================================================
// Answers one question: are we missing good trades because of our
// architecture? Detection (opportunities available/detected/missed),
// decision (rejection-reason distribution, late entries), performance by
// grade/pool/trigger/instrument, and architecture health (trigger/rejection
// frequency, capture rate, filter and late-entry leakage).
//
// Read-only. Nothing here touches a live decision, and every figure is a
// SIMULATED paper-trade outcome, not account P&L. Instruments are always
// shown SEPARATELY — index and MCX are never pooled into one headline.
// ============================================================

import React, { useState } from 'react';
import { useSignalDiagnostics, type DiagnosticsSummaryRow, type DiagnosticsGradeRow, type DiagnosticsLeakageRow } from '@/lib/use-signal-diagnostics';

type View = 'detection' | 'decision' | 'performance' | 'health';

const VIEW_LABELS: Record<View, string> = {
  detection: 'Detection',
  decision: 'Decision',
  performance: 'Performance',
  health: 'Architecture Health',
};

function fmt(v: number | null | undefined, d = 2): string {
  return v == null ? '—' : v.toFixed(d);
}
function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
}
function rColor(v: number | null | undefined): string {
  if (v == null) return 'text-gray-400 light:text-slate-500';
  return v > 0 ? 'text-emerald-400 light:text-emerald-600' : v < 0 ? 'text-red-400 light:text-red-600' : 'text-gray-300 light:text-slate-700';
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900/40 light:bg-white border border-gray-800/60 light:border-slate-200 rounded-lg p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-gray-200 light:text-slate-800">{title}</h3>
        {subtitle && <p className="text-[11px] text-gray-500 light:text-slate-500 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function DetectionView({ summary }: { summary: DiagnosticsSummaryRow[] }) {
  if (summary.length === 0) return <p className="text-xs text-gray-500 light:text-slate-500 italic py-4">No setup_events rows in this window yet.</p>;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {summary.map((row) => (
        <Card key={`${row.instrument}:${row.exchange}`} title={`${row.instrument} (${row.exchange})`}>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <div className="text-gray-500 light:text-slate-500 text-[10px] uppercase">Opportunities</div>
              <div className="text-lg font-mono text-gray-200 light:text-slate-800">{row.detection.opportunitiesAvailable ?? '—'}</div>
            </div>
            <div>
              <div className="text-gray-500 light:text-slate-500 text-[10px] uppercase">Detection rate</div>
              <div className="text-lg font-mono text-gray-200 light:text-slate-800">{pct(row.detection.detectionRate)}</div>
            </div>
            <div>
              <div className="text-gray-500 light:text-slate-500 text-[10px] uppercase">Never detected</div>
              <div className="text-lg font-mono text-amber-400">{row.detection.neverDetected ?? '—'}</div>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function DecisionView({ summary, rejections }: { summary: DiagnosticsSummaryRow[]; rejections: import('@/lib/use-signal-diagnostics').DiagnosticsRejectionRow[] }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {summary.map((row) => (
          <Card key={`${row.instrument}:${row.exchange}`} title={`${row.instrument} (${row.exchange})`}>
            <div className="grid grid-cols-4 gap-2 text-xs">
              <div><div className="text-gray-500 light:text-slate-500 text-[10px] uppercase">Watch</div><div className="font-mono text-gray-300 light:text-slate-700">{row.decision.watch}</div></div>
              <div><div className="text-gray-500 light:text-slate-500 text-[10px] uppercase">Detected</div><div className="font-mono text-gray-300 light:text-slate-700">{row.decision.detected}</div></div>
              <div><div className="text-gray-500 light:text-slate-500 text-[10px] uppercase">Rejected</div><div className="font-mono text-red-400">{row.decision.rejected}</div></div>
              <div><div className="text-gray-500 light:text-slate-500 text-[10px] uppercase">Traded</div><div className="font-mono text-emerald-400">{row.decision.traded}</div></div>
            </div>
          </Card>
        ))}
      </div>
      <Card title="Rejection-reason distribution" subtitle="Grouped by instrument, event type and reason.">
        {rejections.length === 0 ? (
          <p className="text-xs text-gray-500 light:text-slate-500 italic py-2">No rejections recorded in this window.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 light:text-slate-600 uppercase tracking-wider text-[10px]">
                  <th className="text-left px-2 py-1.5 font-medium">Instrument</th>
                  <th className="text-left px-2 py-1.5 font-medium">Event</th>
                  <th className="text-left px-2 py-1.5 font-medium">Reason</th>
                  <th className="text-right px-2 py-1.5 font-medium">Count</th>
                </tr>
              </thead>
              <tbody>
                {rejections.map((r, i) => (
                  <tr key={i} className="border-t border-gray-800/40 light:border-slate-200">
                    <td className="px-2 py-1.5 font-medium text-gray-200 light:text-slate-800">{r.instrument} ({r.exchange})</td>
                    <td className="px-2 py-1.5 text-gray-300 light:text-slate-700">{r.eventType}</td>
                    <td className="px-2 py-1.5 text-gray-400 light:text-slate-600 max-w-md truncate" title={r.reason ?? ''}>{r.reason ?? '—'}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-gray-300 light:text-slate-700">{r.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function PerformanceView({ grades }: { grades: DiagnosticsGradeRow[] }) {
  if (grades.length === 0) return <p className="text-xs text-gray-500 light:text-slate-500 italic py-4">No graded setup_events rows yet.</p>;
  return (
    <Card title="Performance by grade / pool / trigger / instrument" subtitle="Grade bands (A+/A/B/C) are fixed from the score's own component structure, not fitted to outcomes.">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-400 light:text-slate-600 uppercase tracking-wider text-[10px]">
              <th className="text-left px-2 py-1.5 font-medium">Instrument</th>
              <th className="text-left px-2 py-1.5 font-medium">Grade</th>
              <th className="text-left px-2 py-1.5 font-medium">Pool</th>
              <th className="text-left px-2 py-1.5 font-medium">Trigger</th>
              <th className="text-right px-2 py-1.5 font-medium">n</th>
              <th className="text-right px-2 py-1.5 font-medium">Win %</th>
              <th className="text-right px-2 py-1.5 font-medium">Avg R</th>
              <th className="text-right px-2 py-1.5 font-medium">Net R</th>
              <th className="text-right px-2 py-1.5 font-medium">Avg MFE R</th>
              <th className="text-right px-2 py-1.5 font-medium">Avg MAE R</th>
            </tr>
          </thead>
          <tbody>
            {grades.map((g, i) => (
              <tr key={i} className="border-t border-gray-800/40 light:border-slate-200">
                <td className="px-2 py-1.5 font-medium text-gray-200 light:text-slate-800">{g.instrument} ({g.exchange})</td>
                <td className="px-2 py-1.5 text-gray-300 light:text-slate-700">{g.grade ?? '—'}</td>
                <td className="px-2 py-1.5 text-gray-400 light:text-slate-600">{g.poolType ?? '—'}</td>
                <td className="px-2 py-1.5 text-gray-400 light:text-slate-600">{g.triggerType ?? '—'}</td>
                <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{g.count}</td>
                <td className="text-right px-2 py-1.5 tabular-nums text-gray-300 light:text-slate-700">{pct(g.winRate)}</td>
                <td className={`text-right px-2 py-1.5 tabular-nums font-medium ${rColor(g.avgR)}`}>{fmt(g.avgR)}</td>
                <td className={`text-right px-2 py-1.5 tabular-nums font-medium ${rColor(g.netR)}`}>{fmt(g.netR)}</td>
                <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{fmt(g.avgMfeR)}</td>
                <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{fmt(g.avgMaeR)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function HealthView({ leakage, census }: { leakage: DiagnosticsLeakageRow[]; census: import('@/lib/use-signal-diagnostics').DiagnosticsCensusRow[] }) {
  return (
    <div className="space-y-4">
      <Card title="Filter leakage" subtitle="Rejected setups that were graded and later reached +2R — the architecture's own filters throwing away trades that would have worked.">
        {leakage.length === 0 ? (
          <p className="text-xs text-gray-500 light:text-slate-500 italic py-2">No graded rejections in this window.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 light:text-slate-600 uppercase tracking-wider text-[10px]">
                  <th className="text-left px-2 py-1.5 font-medium">Instrument</th>
                  <th className="text-left px-2 py-1.5 font-medium">Event</th>
                  <th className="text-right px-2 py-1.5 font-medium">Rejected (graded)</th>
                  <th className="text-right px-2 py-1.5 font-medium">Later hit +2R</th>
                  <th className="text-right px-2 py-1.5 font-medium">Leakage rate</th>
                </tr>
              </thead>
              <tbody>
                {leakage.map((l, i) => (
                  <tr key={i} className="border-t border-gray-800/40 light:border-slate-200">
                    <td className="px-2 py-1.5 font-medium text-gray-200 light:text-slate-800">{l.instrument} ({l.exchange})</td>
                    <td className="px-2 py-1.5 text-gray-300 light:text-slate-700">{l.eventType}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{l.rejectedGraded}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-amber-400">{l.laterHit2R}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-amber-400">{pct(l.leakageRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Daily opportunity census" subtitle="TRADED / DETECTED_BUT_REJECTED / DETECTED_LATE / NEVER_DETECTED, plus correctly-empty days.">
        {census.length === 0 ? (
          <p className="text-xs text-gray-500 light:text-slate-500 italic py-2">No census rows in this window.</p>
        ) : (
          <div className="overflow-x-auto max-h-96 overflow-y-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 light:text-slate-600 uppercase tracking-wider text-[10px] sticky top-0 bg-gray-900 light:bg-white">
                  <th className="text-left px-2 py-1.5 font-medium">Date</th>
                  <th className="text-left px-2 py-1.5 font-medium">Instrument</th>
                  <th className="text-right px-2 py-1.5 font-medium">Opps</th>
                  <th className="text-right px-2 py-1.5 font-medium">Traded</th>
                  <th className="text-right px-2 py-1.5 font-medium">Rejected</th>
                  <th className="text-right px-2 py-1.5 font-medium">Late</th>
                  <th className="text-right px-2 py-1.5 font-medium">Never</th>
                  <th className="text-right px-2 py-1.5 font-medium">Capture</th>
                  <th className="text-center px-2 py-1.5 font-medium">Empty OK?</th>
                </tr>
              </thead>
              <tbody>
                {census.map((c, i) => (
                  <tr key={i} className="border-t border-gray-800/40 light:border-slate-200">
                    <td className="px-2 py-1.5 text-gray-300 light:text-slate-700">{c.session_date}</td>
                    <td className="px-2 py-1.5 font-medium text-gray-200 light:text-slate-800">{c.instrument} ({c.exchange})</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{c.opportunities}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-emerald-400">{c.traded}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-red-400">{c.rejected}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-amber-400">{c.late}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{c.never_detected}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-gray-300 light:text-slate-700">{pct(c.capture_rate)}</td>
                    <td className="text-center px-2 py-1.5">{c.correctly_empty ? '✓' : c.opportunities === 0 ? '✗' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export function SignalDiagnosticsPage() {
  const [view, setView] = useState<View>('detection');
  const { loading, error, summary, rejections, census, grades, leakage, refresh } = useSignalDiagnostics();

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-100 light:text-slate-900">Signal Diagnostics</h2>
          <p className="text-xs text-gray-500 light:text-slate-500 mt-0.5">
            Are we missing good trades because of our architecture? Read-only, simulated paper-trade outcomes only. Instruments are always shown separately — index and MCX are never pooled.
          </p>
        </div>
        <button onClick={refresh} className="text-xs px-3 py-1.5 rounded border border-gray-700 light:border-slate-300 text-gray-300 light:text-slate-700 hover:bg-gray-800/60 light:hover:bg-slate-100">
          Refresh
        </button>
      </div>

      <div className="flex gap-1 border-b border-gray-800/60 light:border-slate-200">
        {(Object.keys(VIEW_LABELS) as View[]).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px ${
              view === v ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-500 light:text-slate-500 hover:text-gray-300 light:hover:text-slate-700'
            }`}
          >
            {VIEW_LABELS[v]}
          </button>
        ))}
      </div>

      {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">{error}</div>}
      {loading && summary.length === 0 && !error && <p className="text-xs text-gray-500 light:text-slate-500 italic py-4">Loading…</p>}

      {view === 'detection' && <DetectionView summary={summary} />}
      {view === 'decision' && <DecisionView summary={summary} rejections={rejections} />}
      {view === 'performance' && <PerformanceView grades={grades} />}
      {view === 'health' && <HealthView leakage={leakage} census={census} />}
    </div>
  );
}
