'use client';

// ============================================================
// SYSTEM LEARNING / SELF-AUDIT
// ============================================================
// Answers, in this order: what went wrong, why, has it happened before, what
// changed, did the protection work, and does a person have to decide.
//
// Uses the existing terminal design language (the same Tailwind tokens and
// light: variants as every other page) rather than a separate visual system.
// ============================================================

import React, { useState } from 'react';
import { useLearning } from '@/lib/use-learning';
import { api } from '@/lib/api';

type Tab = 'overview' | 'errors' | 'recurring' | 'expected' | 'root-causes' | 'protections' | 'regressions' | 'review' | 'history';

const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview',
  errors: 'Errors',
  recurring: 'Recurring',
  expected: 'Expected',
  'root-causes': 'Root Causes',
  protections: 'Protections',
  regressions: 'Regression Tests',
  review: 'Human Review',
  history: 'History',
};

const SEV_CLASS: Record<string, string> = {
  CRITICAL: 'bg-red-500/15 text-red-400 border-red-500/40 light:bg-red-100 light:text-red-700 light:border-red-300',
  HIGH: 'bg-orange-500/15 text-orange-400 border-orange-500/40 light:bg-orange-100 light:text-orange-700 light:border-orange-300',
  MEDIUM: 'bg-amber-500/15 text-amber-400 border-amber-500/40 light:bg-amber-100 light:text-amber-700 light:border-amber-300',
  LOW: 'bg-sky-500/15 text-sky-400 border-sky-500/40 light:bg-sky-100 light:text-sky-700 light:border-sky-300',
  INFO: 'bg-gray-500/15 text-gray-400 border-gray-500/40 light:bg-slate-200 light:text-slate-600 light:border-slate-300',
};

function Pill({ children, tone = 'flat' }: { children: React.ReactNode; tone?: 'good' | 'warn' | 'bad' | 'flat' }) {
  const cls =
    tone === 'good'
      ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40 light:bg-emerald-100 light:text-emerald-700 light:border-emerald-300'
      : tone === 'warn'
        ? 'bg-amber-500/15 text-amber-400 border-amber-500/40 light:bg-amber-100 light:text-amber-700 light:border-amber-300'
        : tone === 'bad'
          ? 'bg-red-500/15 text-red-400 border-red-500/40 light:bg-red-100 light:text-red-700 light:border-red-300'
          : 'bg-gray-700/40 text-gray-300 border-gray-600/50 light:bg-slate-200 light:text-slate-700 light:border-slate-300';
  return (
    <span className={`inline-block px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide border rounded ${cls}`}>
      {children}
    </span>
  );
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  const valueCls =
    tone === 'bad' ? 'text-red-400 light:text-red-600'
    : tone === 'warn' ? 'text-amber-400 light:text-amber-600'
    : tone === 'good' ? 'text-emerald-400 light:text-emerald-600'
    : 'text-gray-100 light:text-slate-900';
  return (
    <div className="border border-gray-700/60 light:border-slate-300 rounded-lg bg-gray-800/40 light:bg-white px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-gray-500 light:text-slate-500 font-mono">{label}</div>
      <div className={`text-xl font-bold tabular-nums mt-0.5 ${valueCls}`}>{value}</div>
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold text-gray-200 light:text-slate-800">{title}</h2>
        {subtitle && <p className="text-xs text-gray-500 light:text-slate-500 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-gray-500 light:text-slate-500 italic py-2">{children}</p>;
}

function EventCard({ e }: { e: any }) {
  // Days seen, never audit runs — and an expected finding has nothing
  // protecting against it, so it is neither active nor failed.
  const daysSeen = e.audit_days_seen ?? e.occurrence_count;
  const protectionTone =
    e.protection_id == null ? 'flat' : daysSeen > 1 && e.status !== 'EXPECTED' ? 'bad' : 'good';
  return (
    <div className="border border-gray-700/60 light:border-slate-300 rounded-lg bg-gray-800/30 light:bg-white p-3 space-y-1.5">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-100 light:text-slate-900">{e.error_title}</div>
          <div className="text-[11px] font-mono text-gray-500 light:text-slate-500 break-all">{e.error_signature}</div>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <span className={`inline-block px-1.5 py-0.5 text-[10px] font-mono uppercase border rounded ${SEV_CLASS[e.severity] ?? SEV_CLASS.INFO}`}>
            {e.severity}
          </span>
          <Pill tone={e.status === 'EXPECTED' ? 'good' : 'flat'}>{e.status}</Pill>
          {e.classification && e.classification !== 'DEFECT' && <Pill tone="good">{e.classification}</Pill>}
          {e.human_approval_required && <Pill tone={e.human_approved ? 'good' : 'warn'}>{e.human_approved ? 'approved' : 'approval pending'}</Pill>}
        </div>
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div><dt className="text-gray-500 light:text-slate-500 inline">expected </dt><dd className="inline text-gray-300 light:text-slate-700 font-mono">{e.expected_value ?? '—'}</dd></div>
        <div><dt className="text-gray-500 light:text-slate-500 inline">actual </dt><dd className="inline text-gray-300 light:text-slate-700 font-mono">{e.actual_value ?? '—'}</dd></div>
        <div><dt className="text-gray-500 light:text-slate-500 inline">module </dt><dd className="inline text-gray-300 light:text-slate-700">{e.module ?? '—'}{e.component ? ` / ${e.component}` : ''}</dd></div>
        {/* Days seen is the recurrence number. Audit runs is shown beside it
            so the difference is visible rather than implied. */}
        <div><dt className="text-gray-500 light:text-slate-500 inline">days seen </dt><dd className="inline text-gray-300 light:text-slate-700 tabular-nums">{e.audit_days_seen ?? e.occurrence_count} <span className="text-gray-500 light:text-slate-500">({e.audit_runs_seen ?? e.occurrence_count} audit run{(e.audit_runs_seen ?? e.occurrence_count) === 1 ? '' : 's'})</span></dd></div>
        {e.contract_generation && (
          <div><dt className="text-gray-500 light:text-slate-500 inline">contract </dt><dd className="inline text-gray-300 light:text-slate-700 font-mono text-[11px]">{e.contract_generation}</dd></div>
        )}
        {e.evidence_quality && (
          <div><dt className="text-gray-500 light:text-slate-500 inline">evidence </dt><dd className="inline"><Pill tone={e.evidence_quality === 'INSUFFICIENT' ? 'bad' : e.evidence_quality === 'HIGH' ? 'good' : 'warn'}>{e.evidence_quality}</Pill></dd></div>
        )}
        <div className="sm:col-span-2">
          <dt className="text-gray-500 light:text-slate-500 inline">root cause </dt>
          <dd className="inline text-gray-300 light:text-slate-700">
            {e.root_cause ?? <span className="text-amber-400 light:text-amber-600">not established — routed to human review, never guessed</span>}
          </dd>
        </div>
        <div><dt className="text-gray-500 light:text-slate-500 inline">protection </dt><dd className="inline"><Pill tone={protectionTone as any}>{e.protection_id == null ? 'none' : daysSeen > 1 && e.status !== 'EXPECTED' ? 'failed' : 'active'}</Pill></dd></div>
        <div><dt className="text-gray-500 light:text-slate-500 inline">regression </dt><dd className="inline"><Pill tone={e.regression_test_status === 'FAIL' ? 'bad' : e.regression_test_status === 'PASS' ? 'good' : 'flat'}>{e.regression_test_status ?? 'none'}</Pill></dd></div>
      </dl>

      {e.classification_reason && (
        <p className="text-[11px] text-gray-400 light:text-slate-600 border-l-2 border-emerald-500/40 pl-2">
          {e.classification_reason}
        </p>
      )}
      {e.review_note && (
        <p className="text-[11px] text-amber-400/90 light:text-amber-700 border-l-2 border-amber-500/50 pl-2">
          blocked by: {e.review_note}
        </p>
      )}
    </div>
  );
}

export function SystemLearningPage() {
  const [tab, setTab] = useState<Tab>('overview');
  const { summary, events, recurring, expected, unresolved, regressions, protections, review, history, loading, isLive, error, refresh } =
    useLearning();
  const [reviewer, setReviewer] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const data = summary?.data ?? null;
  const counts = data?.counts ?? {};
  const learning = data?.learning ?? null;
  const alerts: any[] = data?.repeated_failure_alerts ?? [];

  const decide = async (eventId: number, decision: string) => {
    if (reviewer.trim() === '') {
      setMessage('Enter your name first — an unattributed approval is not one.');
      return;
    }
    setBusy(eventId);
    try {
      const r = await api.submitLearningReview(eventId, { decision, reviewer: reviewer.trim() });
      setMessage(r?.message ?? 'recorded');
      refresh();
    } catch (err: any) {
      setMessage(err?.message ?? 'failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="p-4 space-y-4 min-h-full">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-100 light:text-slate-900">🧠 System Learning</h1>
          <p className="text-xs text-gray-400 light:text-slate-600 mt-0.5 max-w-3xl">
            What went wrong, why, whether it has happened before, and whether the protection put in place actually worked.
            This engine records and proposes — it does not change trading logic. Anything in the trading path stops at a
            proposal awaiting human approval.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!isLive && <Pill tone="bad">backend unreachable</Pill>}
          <button
            type="button"
            onClick={refresh}
            className="text-xs px-2 py-1 rounded border border-gray-600/60 light:border-slate-300 text-gray-300 light:text-slate-700 hover:bg-gray-700/40 light:hover:bg-slate-100"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="border border-red-500/40 light:border-red-300 bg-red-500/10 light:bg-red-50 rounded-lg p-3 text-xs text-red-300 light:text-red-700">
          Could not reach the audit API: {error}. This is not a clean audit — it is no audit.
        </div>
      )}

      {/* Whether the audit ran at all. "0 errors" and "never ran" look identical without this. */}
      {data && (
        <div
          className={`rounded-lg border p-3 text-xs ${
            data.audit_ran_today
              ? 'border-emerald-500/40 light:border-emerald-300 bg-emerald-500/10 light:bg-emerald-50 text-emerald-300 light:text-emerald-700'
              : 'border-amber-500/40 light:border-amber-300 bg-amber-500/10 light:bg-amber-50 text-amber-300 light:text-amber-700'
          }`}
        >
          {data.audit_ran_today ? (
            <>Audit ran for {data.date} — status {data.last_audit_run?.status}. A zero count below means a clean day.</>
          ) : (
            <>
              The audit has <strong>not</strong> run for {data.date}
              {data.last_audit_run ? <> (last run {data.last_audit_run.event_date}, {data.last_audit_run.status})</> : ' (never run)'}.
              Counts below are not evidence of a clean day.
            </>
          )}
        </div>
      )}

      <div className="flex items-center gap-0.5 bg-gray-800/60 light:bg-slate-200/60 rounded-lg p-0.5 overflow-x-auto" role="tablist">
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`px-2.5 py-1 text-xs rounded-md whitespace-nowrap transition-colors ${
              tab === t
                ? 'bg-gray-700 light:bg-white text-gray-100 light:text-slate-900 font-medium'
                : 'text-gray-400 light:text-slate-600 hover:text-gray-200 light:hover:text-slate-900'
            }`}
          >
            {TAB_LABELS[t]}
            {t === 'review' && review.length > 0 && <span className="ml-1 text-amber-400 light:text-amber-600">({review.length})</span>}
            {t === 'expected' && expected.length > 0 && <span className="ml-1 text-emerald-400 light:text-emerald-600">({expected.length})</span>}
            {t === 'regressions' && regressions.some((r: any) => r.status === 'FAIL') && <span className="ml-1 text-red-400 light:text-red-600">!</span>}
          </button>
        ))}
      </div>

      {loading && <Empty>loading…</Empty>}

      {/* ---------------- OVERVIEW ---------------- */}
      {tab === 'overview' && !loading && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            <Stat label="Total issues" value={counts.total_issues ?? 0} />
            <Stat label="New" value={counts.new_errors ?? 0} tone={(counts.new_errors ?? 0) > 0 ? 'warn' : undefined} />
            <Stat label="Recurring" value={counts.recurring ?? 0} tone={(counts.recurring ?? 0) > 0 ? 'bad' : undefined} />
            <Stat label="Expected" value={counts.expected ?? 0} tone="good" />
            <Stat label="Resolved" value={counts.resolved ?? 0} tone="good" />
            <Stat label="Needs review" value={counts.needs_review ?? 0} tone={(counts.needs_review ?? 0) > 0 ? 'warn' : undefined} />
            <Stat label="Regression fails" value={counts.regression_failures ?? 0} tone={(counts.regression_failures ?? 0) > 0 ? 'bad' : undefined} />
          </div>

          {alerts.length > 0 && (
            <Section title="⚠ Repeated system failures" subtitle="A fault at or above the repeat threshold. Where a protection exists and the fault came back anyway, the protection is the problem.">
              <div className="space-y-2">
                {alerts.map((a) => (
                  <div key={a.error_signature} className="border border-red-500/40 light:border-red-300 bg-red-500/10 light:bg-red-50 rounded-lg p-3 text-xs space-y-1">
                    <div className="font-medium text-red-300 light:text-red-700">{a.error}</div>
                    <div className="font-mono text-[11px] text-red-400/80 light:text-red-600 break-all">{a.error_signature}</div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-gray-300 light:text-slate-700">
                      <div>occurrences <span className="tabular-nums font-semibold">{a.occurrences}</span></div>
                      <div>first seen {new Date(a.first_seen).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })}</div>
                      <div>latest {new Date(a.latest).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })}</div>
                      <div>protection <Pill tone={a.protection_effectiveness === 'FAILED' ? 'bad' : a.protection_effectiveness === 'NONE' ? 'flat' : 'warn'}>{a.protection_effectiveness}</Pill></div>
                    </div>
                    <div className="text-gray-400 light:text-slate-600">{a.recommendation}</div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          <Section title="Why did the system fail?" subtitle="Occurrences grouped by cause, over four windows.">
            <div className="overflow-x-auto border border-gray-700/60 light:border-slate-300 rounded-lg">
              <table className="w-full text-xs">
                <thead className="bg-gray-800/60 light:bg-slate-100">
                  <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 light:text-slate-500 font-mono">
                    <th className="px-3 py-2">Cause</th>
                    <th className="px-3 py-2 text-right">Today</th>
                    <th className="px-3 py-2 text-right">7 days</th>
                    <th className="px-3 py-2 text-right">30 days</th>
                    <th className="px-3 py-2 text-right">All time</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(data?.why_did_the_system_fail?.all_time ?? {}).map((group) => {
                    const w = data.why_did_the_system_fail;
                    const all = w.all_time[group] ?? 0;
                    if (all === 0) return null;
                    return (
                      <tr key={group} className="border-t border-gray-700/40 light:border-slate-200">
                        <td className="px-3 py-1.5 text-gray-300 light:text-slate-700">{group}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-gray-200 light:text-slate-800">{w.today[group] ?? 0}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-gray-200 light:text-slate-800">{w.last_7_days[group] ?? 0}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-gray-200 light:text-slate-800">{w.last_30_days[group] ?? 0}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-gray-200 light:text-slate-800">{all}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {Object.values(data?.why_did_the_system_fail?.all_time ?? {}).every((n) => n === 0) && (
              <Empty>no occurrences recorded yet</Empty>
            )}
          </Section>

          {learning && (
            <Section title="Are we learning?" subtitle="Counts from the record, plus the four ratios that are actually defined. No composite score is published.">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Stat label="Unique classes" value={learning.stats.unique_error_classes} />
                <Stat label="Protected" value={learning.stats.protected_classes} />
                <Stat label="Regression-covered" value={learning.stats.regression_covered_classes} />
                <Stat label="Recurring" value={learning.stats.recurring_classes} tone={learning.stats.recurring_classes > 0 ? 'warn' : undefined} />
                <Stat label="Protection failures" value={learning.stats.protection_failures} tone={learning.stats.protection_failures > 0 ? 'bad' : undefined} />
                <Stat label="Unresolved" value={learning.stats.unresolved_classes} />
                <Stat label="Protection coverage" value={learning.protection_coverage == null ? '—' : `${learning.protection_coverage}%`} />
                <Stat label="Regression coverage" value={learning.regression_coverage == null ? '—' : `${learning.regression_coverage}%`} />
              </div>
              <p className="text-[11px] text-gray-500 light:text-slate-500">{learning.formula.note}</p>
            </Section>
          )}

          {data?.safety && (
            <Section title="Safety boundary" subtitle="What this engine may change by itself, and what it may not.">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-xs">
                <div className="border border-gray-700/60 light:border-slate-300 rounded-lg p-3">
                  <div className="text-[10px] uppercase tracking-wider text-emerald-400 light:text-emerald-700 font-mono mb-1">Automatic — observation only</div>
                  <div className="flex flex-wrap gap-1">
                    {(data.safety.auto_safe_scopes ?? []).map((s: string) => <Pill key={s} tone="good">{s}</Pill>)}
                  </div>
                </div>
                <div className="border border-amber-500/40 light:border-amber-300 rounded-lg p-3">
                  <div className="text-[10px] uppercase tracking-wider text-amber-400 light:text-amber-700 font-mono mb-1">Human approval required</div>
                  <div className="flex flex-wrap gap-1">
                    {(data.safety.trading_logic_categories ?? []).map((s: string) => <Pill key={s} tone="warn">{s}</Pill>)}
                  </div>
                </div>
              </div>
              <p className="text-[11px] text-gray-500 light:text-slate-500">{data.safety.note}</p>
            </Section>
          )}
        </div>
      )}

      {/* ---------------- ERRORS ---------------- */}
      {tab === 'errors' && !loading && (
        <Section title={`Errors detected — ${data?.date ?? ''}`} subtitle="Every finding recorded for this audit day.">
          {events.length === 0 ? <Empty>nothing recorded for this date</Empty> : (
            <div className="space-y-2">{events.map((e: any) => <EventCard key={e.event_id} e={e} />)}</div>
          )}
        </Section>
      )}

      {/* ---------------- RECURRING ---------------- */}
      {tab === 'recurring' && !loading && (
        <Section title="Recurring errors" subtitle="Seen more than once. Where a protection existed and the fault returned, the protection has failed — which is a different and worse finding than the fault itself.">
          {recurring.length === 0 ? <Empty>no fault has been seen more than once</Empty> : (
            <div className="space-y-2">{recurring.map((e: any) => <EventCard key={e.event_id} e={e} />)}</div>
          )}
        </Section>
      )}

      {/* ---------------- EXPECTED ---------------- */}
      {tab === 'expected' && !loading && (
        <Section
          title="Expected under contract"
          subtitle="Real observations whose verdict is decided by the contract generation that wrote the rows. Not suppressed, and not defects — if the governing contract changes, the same observation becomes a defect again."
        >
          {expected.length === 0 ? <Empty>none</Empty> : (
            <div className="space-y-2">{expected.map((e: any) => <EventCard key={e.event_id} e={e} />)}</div>
          )}
        </Section>
      )}

      {/* ---------------- ROOT CAUSES ---------------- */}
      {tab === 'root-causes' && !loading && (
        <div className="space-y-5">
          <Section title="Established root causes" subtitle="Findings whose cause is on the record.">
            {unresolved.filter((e: any) => e.root_cause_known).length === 0 ? <Empty>none established</Empty> : (
              <div className="space-y-2">{unresolved.filter((e: any) => e.root_cause_known).map((e: any) => <EventCard key={e.event_id} e={e} />)}</div>
            )}
          </Section>
          <Section title="Unknown root cause" subtitle="These stay open. A cause is never invented to close a record, and the symptom going quiet does not count as an explanation.">
            {unresolved.filter((e: any) => !e.root_cause_known).length === 0 ? <Empty>none — every open finding has a cause on the record</Empty> : (
              <div className="space-y-2">{unresolved.filter((e: any) => !e.root_cause_known).map((e: any) => <EventCard key={e.event_id} e={e} />)}</div>
            )}
          </Section>
        </div>
      )}

      {/* ---------------- PROTECTIONS ---------------- */}
      {tab === 'protections' && !loading && (
        <Section title="Protections" subtitle="What guards what. failure_count is the number of times the fault recurred after this protection was recorded — any value above zero means it does not work, whatever it asserts.">
          {protections.length === 0 ? <Empty>none registered</Empty> : (
            <div className="overflow-x-auto border border-gray-700/60 light:border-slate-300 rounded-lg">
              <table className="w-full text-xs">
                <thead className="bg-gray-800/60 light:bg-slate-100">
                  <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 light:text-slate-500 font-mono">
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Protection</th>
                    <th className="px-3 py-2">Rule</th>
                    <th className="px-3 py-2 text-right">Failures</th>
                  </tr>
                </thead>
                <tbody>
                  {protections.map((p: any) => (
                    <tr key={p.protection_id} className="border-t border-gray-700/40 light:border-slate-200 align-top">
                      <td className="px-3 py-1.5"><Pill>{p.protection_type}</Pill></td>
                      <td className="px-3 py-1.5 text-gray-200 light:text-slate-800">
                        {p.title}
                        <div className="text-[10px] font-mono text-gray-500 light:text-slate-500">{p.implemented_in}</div>
                      </td>
                      <td className="px-3 py-1.5 font-mono text-[11px] text-gray-400 light:text-slate-600 break-all">{p.rule}</td>
                      <td className="px-3 py-1.5 text-right">
                        {Number(p.failure_count ?? 0) > 0
                          ? <Pill tone="bad">{p.failure_count} — ineffective</Pill>
                          : <Pill tone="good">0</Pill>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {/* ---------------- REGRESSIONS ---------------- */}
      {tab === 'regressions' && !loading && (
        <Section title="Regression cases" subtitle="Each case names an assertion the audit re-evaluates every cycle. A case whose fault reappears is a REGRESSION FAILURE, not a fresh discovery.">
          {regressions.length === 0 ? <Empty>none created yet</Empty> : (
            <div className="overflow-x-auto border border-gray-700/60 light:border-slate-300 rounded-lg">
              <table className="w-full text-xs">
                <thead className="bg-gray-800/60 light:bg-slate-100">
                  <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 light:text-slate-500 font-mono">
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Case</th>
                    <th className="px-3 py-2">Assertion</th>
                    <th className="px-3 py-2 text-right">Pass</th>
                    <th className="px-3 py-2 text-right">Fail</th>
                  </tr>
                </thead>
                <tbody>
                  {regressions.map((r: any) => (
                    <tr key={r.test_id} className="border-t border-gray-700/40 light:border-slate-200 align-top">
                      <td className="px-3 py-1.5"><Pill tone={r.status === 'FAIL' ? 'bad' : r.status === 'PASS' ? 'good' : 'flat'}>{r.status}</Pill></td>
                      <td className="px-3 py-1.5 text-gray-200 light:text-slate-800">
                        {r.test_name}
                        <div className="text-[10px] font-mono text-gray-500 light:text-slate-500 break-all">{r.test_id}</div>
                        {r.status === 'FAIL' && (
                          <div className="text-[11px] text-red-400 light:text-red-600 mt-0.5">
                            expected {r.expected_behavior} · observed {r.current_behavior}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-[11px] text-gray-400 light:text-slate-600 break-all">{r.assertion_key}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-300 light:text-slate-700">{r.pass_count}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-300 light:text-slate-700">{r.fail_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {/* ---------------- HUMAN REVIEW ---------------- */}
      {tab === 'review' && !loading && (
        <div className="space-y-4">
          <div className="border border-amber-500/40 light:border-amber-300 bg-amber-500/10 light:bg-amber-50 rounded-lg p-3 text-xs text-amber-200 light:text-amber-800">
            These are trading-path findings. They have been detected, explained and proposed — nothing has been applied.
            Approving records that you consented to the change; it does not make the change. No code path in this engine
            edits a trading module.
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <label htmlFor="learning-reviewer" className="text-xs text-gray-400 light:text-slate-600">Reviewer</label>
            <input
              id="learning-reviewer"
              value={reviewer}
              onChange={(ev) => setReviewer(ev.target.value)}
              placeholder="your name"
              className="text-xs px-2 py-1 rounded bg-gray-800 light:bg-white border border-gray-600/60 light:border-slate-300 text-gray-100 light:text-slate-900"
            />
            {message && <span className="text-xs text-gray-400 light:text-slate-600">{message}</span>}
          </div>

          {review.length === 0 ? <Empty>empty — nothing is waiting on a person</Empty> : (
            <div className="space-y-2">
              {review.map((r: any) => (
                <div key={r.event_id} className="border border-gray-700/60 light:border-slate-300 rounded-lg bg-gray-800/30 light:bg-white p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div>
                      <div className="text-sm font-medium text-gray-100 light:text-slate-900">#{r.event_id} {r.issue}</div>
                      <div className="text-[11px] text-gray-500 light:text-slate-500">{r.category} · {r.module ?? '—'} · {r.occurrences} occurrence(s)</div>
                    </div>
                    <span className={`inline-block px-1.5 py-0.5 text-[10px] font-mono uppercase border rounded ${SEV_CLASS[r.severity] ?? SEV_CLASS.INFO}`}>{r.severity}</span>
                  </div>
                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <div><dt className="text-gray-500 light:text-slate-500 inline">expected </dt><dd className="inline font-mono text-gray-300 light:text-slate-700">{r.evidence?.expected ?? '—'}</dd></div>
                    <div><dt className="text-gray-500 light:text-slate-500 inline">actual </dt><dd className="inline font-mono text-gray-300 light:text-slate-700">{r.evidence?.actual ?? '—'}</dd></div>
                    <div className="sm:col-span-2"><dt className="text-gray-500 light:text-slate-500 inline">root cause </dt><dd className="inline text-gray-300 light:text-slate-700">{r.root_cause ?? 'UNKNOWN'}</dd></div>
                    <div className="sm:col-span-2"><dt className="text-gray-500 light:text-slate-500 inline">impact </dt><dd className="inline text-gray-300 light:text-slate-700">{r.impact ?? '—'}</dd></div>
                    <div><dt className="text-gray-500 light:text-slate-500 inline">suggested fix </dt><dd className="inline text-gray-300 light:text-slate-700">{r.suggested_fix ?? 'none recorded'}</dd></div>
                    <div><dt className="text-gray-500 light:text-slate-500 inline">regression </dt><dd className="inline font-mono text-gray-300 light:text-slate-700">{r.regression_test ?? 'none'}</dd></div>
                    <div><dt className="text-gray-500 light:text-slate-500 inline">commit </dt><dd className="inline font-mono text-gray-300 light:text-slate-700">{r.evidence?.commit ?? 'unknown'}</dd></div>
                  </dl>
                  <div className="flex items-center gap-1.5 flex-wrap pt-1">
                    {['APPROVE', 'REJECT', 'MODIFY', 'DEFER', 'EXPECTED'].map((d) => (
                      <button
                        key={d}
                        type="button"
                        disabled={busy === r.event_id}
                        onClick={() => decide(r.event_id, d)}
                        className={`text-[11px] px-2 py-1 rounded border transition-colors disabled:opacity-50 ${
                          d === 'APPROVE'
                            ? 'border-emerald-500/50 text-emerald-400 light:text-emerald-700 hover:bg-emerald-500/10'
                            : d === 'REJECT'
                              ? 'border-red-500/50 text-red-400 light:text-red-700 hover:bg-red-500/10'
                              : 'border-gray-600/60 light:border-slate-300 text-gray-300 light:text-slate-700 hover:bg-gray-700/40 light:hover:bg-slate-100'
                        }`}
                      >
                        {d === 'EXPECTED' ? 'Mark expected' : d.charAt(0) + d.slice(1).toLowerCase()}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---------------- HISTORY ---------------- */}
      {tab === 'history' && !loading && (
        <Section title="Audit history" subtitle="One row per audit run, so a day with no findings is distinguishable from a day the audit never ran.">
          {history.length === 0 ? <Empty>no audit has run yet</Empty> : (
            <div className="overflow-x-auto border border-gray-700/60 light:border-slate-300 rounded-lg">
              <table className="w-full text-xs">
                <thead className="bg-gray-800/60 light:bg-slate-100">
                  <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 light:text-slate-500 font-mono">
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Found</th>
                    <th className="px-3 py-2 text-right">New</th>
                    <th className="px-3 py-2 text-right">Recur</th>
                    <th className="px-3 py-2 text-right">Prot. fail</th>
                    <th className="px-3 py-2 text-right">Reg. fail</th>
                    <th className="px-3 py-2 text-right">Det. fail</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((r: any) => (
                    <tr key={r.audit_run_id} className="border-t border-gray-700/40 light:border-slate-200">
                      <td className="px-3 py-1.5 font-mono text-gray-300 light:text-slate-700">{r.event_date}</td>
                      <td className="px-3 py-1.5"><Pill tone={r.status === 'SUCCESS' ? 'good' : r.status === 'PARTIAL' ? 'warn' : 'bad'}>{r.status}</Pill></td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-200 light:text-slate-800">{r.findings}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-200 light:text-slate-800">{r.new_errors}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-200 light:text-slate-800">{r.recurrences}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-200 light:text-slate-800">{r.protection_failures}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-200 light:text-slate-800">{r.regression_failures}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-200 light:text-slate-800">{r.detectors_failed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}
