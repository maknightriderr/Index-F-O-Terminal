'use client';

// ============================================================
// SESSION CLUSTER — NSE · BSE · MCX in the header (UX redesign phase 1)
// ============================================================
// Replaces the NSE-only freshness badge: each exchange shows whether its session is open, how far through the session
// it is, and (NSE, from the index quotes) whether the data is current. MCX trades into the evening, so the header no
// longer says only "NSE CLOSED" while MCX is the market that is live. Clicking opens Ops & Health.
// ============================================================

import React from 'react';
import { getSessionWindow, type Exchange } from '@fno/shared';
import type { FeedSummary } from '@/lib/use-feed-summary';

const istDate = (t: number) => new Date(t + 19_800_000).toISOString().slice(0, 10);
const hhmm = (t: number) => new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });

export interface SessionView { exchange: Exchange; open: boolean; progress: number | null; opensAt: number | null; closesAt: number | null }

/** Pure: each exchange's session today and how far through it `now` is (null when there is no session today). */
export function sessionViews(sessions: FeedSummary['sessions'], now: number): SessionView[] {
  return sessions.map(({ exchange, open }) => {
    const w = getSessionWindow(exchange, istDate(now));
    if (!w) return { exchange, open, progress: null, opensAt: null, closesAt: null };
    const progress = Math.max(0, Math.min(1, (now - w.open) / (w.close - w.open)));
    return { exchange, open, progress, opensAt: w.open, closesAt: w.close };
  });
}

export function SessionCluster({ feed, onOpen }: { feed: FeedSummary; onOpen: () => void }) {
  const views = sessionViews(feed.sessions, feed.now);
  const nseStale = feed.quotes.state === 'STALE' || feed.quotes.state === 'UNAVAILABLE' || feed.quotes.state === 'DISCONNECTED';
  return (
    <button type="button" onClick={onOpen} className="terminal-sessions" aria-label={`Market sessions: ${views.map((v) => `${v.exchange} ${v.open ? 'open' : 'closed'}`).join(', ')}. ${feed.quotes.detail} Open Ops and Health.`} title={`${feed.quotes.detail} Open Ops & Health.`}>
      {views.map((v) => {
        const state = !v.open ? 'closed' : v.exchange === 'NSE' && nseStale ? 'stale' : 'open';
        const note = v.open ? (v.exchange === 'NSE' && nseStale ? 'stale' : `to ${v.closesAt ? hhmm(v.closesAt) : '—'}`) : v.opensAt && feed.now < v.opensAt ? `opens ${hhmm(v.opensAt)}` : 'closed';
        return (
          <span key={v.exchange} className="terminal-session" data-state={state}>
            <span className="terminal-session-row"><i aria-hidden="true" />{v.exchange}<small>{note}</small></span>
            <span className="terminal-session-bar" aria-hidden="true"><b style={{ width: `${Math.round((v.progress ?? 0) * 100)}%` }} /></span>
          </span>
        );
      })}
    </button>
  );
}
