// ============================================================
// AI EXPLAIN — "Why this trade?" / "Why no trade?" (2026-10-16)
// ============================================================
// Read-only. Inside the AI assistant import boundary (eslint.config.mjs and
// api/__tests__/ai-assistant-boundary.test.ts): it reads the stored records
// with SQL and never imports a trading module, so nothing here can mint,
// size, gate or change a decision.
//
// What: one stored decision (a paper trade's signals row and the decision
// snapshot that minted it, or the latest decision snapshot of a symbol) is
// turned into a short fact sheet in code — vote stances, the refusal rule,
// the option and its cost, the outcome — and the model only puts those facts
// into plain English. It is told to invent nothing. Answers are cached, so a
// repeat click costs no request.
// ============================================================

import { sql } from '../lib/db.js';
import { cached } from '../lib/cache.js';
import { askAi } from '../lib/llm.js';

export type ExplainTarget = { kind: 'trade'; id: string } | { kind: 'decision'; symbol: string; exchange: string; mode: string };

export interface Explanation {
  subject: string;
  text: string;
  via: string;
  model: string;
}

export class ExplainNotFoundError extends Error {}

/** Vote names as a trader reads them. */
export const VOTE_LABEL: Record<string, string> = {
  trend: 'trend',
  priceAction: 'price action',
  technicals: 'technical indicators',
  relativeStrength: 'relative strength',
  volume: 'volume',
  futuresOi: 'futures open interest',
  optionsOi: 'options open interest',
  oiShifts: 'OI shifts',
  pcr: 'put-call ratio',
  iv: 'implied volatility',
};

/**
 * Pure: a decision snapshot's vote_contributions as stances. Each is 50 + vote × sign × 45, so 95 agrees with the
 * call, 5 is against it and 50 is neutral.
 */
export function voteStances(votes: Record<string, unknown> | null | undefined): { agree: string[]; against: string[]; neutral: string[] } {
  const out = { agree: [] as string[], against: [] as string[], neutral: [] as string[] };
  for (const [k, v] of Object.entries(votes ?? {})) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const name = VOTE_LABEL[k] ?? k;
    if (v >= 70) out.agree.push(name);
    else if (v <= 30) out.against.push(name);
    else out.neutral.push(name);
  }
  return out;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const fmt = (v: number | null, d = 2) => (v == null ? null : v.toFixed(d));
const clip = (s: unknown, n = 600) => (typeof s === 'string' && s.trim() ? (s.length > n ? `${s.slice(0, n)}…` : s) : null);
const istTime = (t: Date | number | string) => new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const engineName = (source: unknown) => (source === 'INDICATOR' || source == null ? 'Old Indicator' : String(source));

export interface TradeRow {
  time: Date | string;
  symbol: string;
  inputs: Record<string, any>;
}

export interface SnapshotRow {
  decision_id?: string;
  time: Date | string;
  symbol: string;
  exchange: string;
  mode: string;
  decision: string;
  reason_code: string | null;
  reason: string | null;
  regime: string | null;
  bias: string | null;
  confidence: string | number | null;
  vote_contributions: Record<string, unknown> | null;
  option_quality_grade?: string | null;
  spread_pct?: string | number | null;
  delta?: string | number | null;
  location_score?: number | null;
  room_ratio?: string | number | null;
  contract_refusal_reason?: string | null;
}

function stanceLines(snap: SnapshotRow | null): string[] {
  if (!snap) return [];
  const s = voteStances(snap.vote_contributions);
  const lines: string[] = [];
  if (snap.bias) lines.push(`Direction call: ${snap.bias}${num(snap.confidence) != null ? `, confidence ${Math.round(num(snap.confidence)!)}/100 (how much the signals agreed)` : ''}.`);
  if (snap.regime) lines.push(`Market regime: ${snap.regime.replace(/_/g, ' ').toLowerCase()}.`);
  if (s.agree.length) lines.push(`Signals agreeing with the call: ${s.agree.join(', ')}.`);
  if (s.against.length) lines.push(`Signals against the call: ${s.against.join(', ')}.`);
  if (s.neutral.length) lines.push(`Neutral signals: ${s.neutral.join(', ')}.`);
  return lines;
}

/** Pure: the fact sheet of one paper trade. */
export function tradeFactSheet(t: TradeRow, snap: SnapshotRow | null): { subject: string; facts: string[] } {
  const i = t.inputs ?? {};
  const entry = num(i.entry);
  const stop = num(i.stopLoss);
  const target = num(i.target);
  const exit = num(i.exitPrice);
  const direction = i.side === 'CE' ? 'bullish' : i.side === 'PE' ? 'bearish' : snap?.bias?.toLowerCase() ?? 'unknown';
  const contract = [t.symbol, i.strike, i.side].filter((x) => x != null && x !== '').join(' ');
  const subject = `${contract} (${direction}), opened ${istTime(t.time)} IST`;
  const facts = [
    `Paper trade on ${t.symbol} (${i.exchange ?? '?'}, ${String(i.mode ?? '').toLowerCase() || 'unknown mode'}), opened ${istTime(t.time)} IST. No order was placed.`,
    `Engine that took it: ${engineName(i.source)}.`,
    `Option bought: ${i.side ?? '?'} ${i.strike ?? '?'}${i.expiry ? `, expiry ${i.expiry}` : ''}${num(i.dte) != null ? ` (${num(i.dte)} days to expiry)` : ''}.`,
    `Premium entry ${fmt(entry) ?? '?'}, stop ${fmt(stop) ?? '?'}, target ${fmt(target) ?? '?'}${num(i.riskReward) != null ? `, planned reward:risk ${fmt(num(i.riskReward))}` : ''}.`,
  ];
  if (num(i.estimatedCostPct) != null) facts.push(`Estimated round-trip cost: ${fmt(num(i.estimatedCostPct))}% of the premium (spread, slippage, charges, brokerage).`);
  facts.push(...stanceLines(snap));
  if (snap?.reason) facts.push(`The engine's own reason at entry: ${clip(snap.reason)}`);
  if (i.outcome) {
    const risk = entry != null && stop != null && entry > stop ? entry - stop : null;
    const r = exit != null && entry != null && risk ? (exit - entry) / risk : null;
    facts.push(
      `Outcome: ${i.outcome}${i.closeReason ? ` (closed by ${String(i.closeReason).replace(/_/g, ' ').toLowerCase()})` : ''}${exit != null ? `, exit premium ${fmt(exit)}` : ''}${r != null ? `, ${r >= 0 ? '+' : ''}${r.toFixed(2)}R before costs` : ''}${num(i.holdMinutes) != null ? `, held ${Math.round(num(i.holdMinutes)!)} minutes` : ''}.`
    );
  } else {
    facts.push('The trade is still open.');
  }
  return { subject, facts };
}

/** Pure: the fact sheet of one decision snapshot (usually a refusal). */
export function decisionFactSheet(snap: SnapshotRow): { subject: string; facts: string[] } {
  const taken = snap.decision === 'TAKE';
  const subject = `${snap.symbol} ${snap.mode.toLowerCase()}: ${taken ? 'trade taken' : 'no trade'} at ${istTime(snap.time)} IST`;
  const facts = [
    `Latest ${snap.mode.toLowerCase()} decision for ${snap.symbol} (${snap.exchange}) at ${istTime(snap.time)} IST: ${taken ? 'a paper trade was taken' : 'no trade'}.`,
    ...stanceLines(snap),
  ];
  if (!taken && snap.reason_code) facts.push(`Rule that refused it: ${snap.reason_code.replace(/_/g, ' ').toLowerCase()}.`);
  if (snap.reason) facts.push(`The engine's own explanation: ${clip(snap.reason)}`);
  if (snap.contract_refusal_reason) facts.push(`Option contract check: ${clip(snap.contract_refusal_reason, 300)}`);
  if (snap.option_quality_grade) facts.push(`Option quality: ${snap.option_quality_grade.toLowerCase()}${num(snap.spread_pct) != null ? `, bid-ask spread ${fmt(num(snap.spread_pct), 1)}% of the price` : ''}.`);
  return { subject, facts };
}

export const EXPLAIN_SYSTEM_PROMPT = `You explain one decision made by the user's own options paper-trading terminal, to the trader who owns it, in plain English.

Rules:
- Use only the facts between <facts> and </facts>. Never invent numbers, price levels, news or reasons. If something is not in the facts, leave it out.
- Write exactly 3 short bullet points starting with "• ", at most 90 words in total:
  1. what the engine saw (direction, confidence, which signals agreed or disagreed);
  2. why it took the trade or refused it, putting the rule or gate in plain words;
  3. the option and its cost, and, if the trade has closed, what happened.
- "R" is one unit of the trade's initial risk. Costs are estimates. This is a paper trade: no order was placed.
- Do not give advice, predictions or opinions about whether to trade. Never claim the strategy has an edge.
- Plain text only: no headings, no markdown, no tables.`;

async function ask(subject: string, facts: string[]): Promise<Explanation> {
  const reply = await askAi(EXPLAIN_SYSTEM_PROMPT, [{ role: 'user', content: `<facts>\n${facts.join('\n')}\n</facts>\nExplain this decision.` }]);
  return { subject, text: reply.text, via: reply.label, model: reply.model };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isTradeId = (id: unknown): id is string => typeof id === 'string' && UUID.test(id);

export async function explain(target: ExplainTarget): Promise<Explanation> {
  if (target.kind === 'trade') {
    const rows = await sql<TradeRow[]>`SELECT time, symbol, inputs FROM signals WHERE id = ${target.id} AND signal_type = 'TRADE_SETUP' LIMIT 1`;
    const t = rows[0];
    if (!t) throw new ExplainNotFoundError('No paper trade with that id');
    const snaps = await sql<SnapshotRow[]>`
      SELECT decision_id, time, symbol, exchange, mode, decision, reason_code, reason, regime, bias, confidence, vote_contributions, option_quality_grade, spread_pct, delta
      FROM decision_snapshots WHERE signal_id = ${target.id} ORDER BY time LIMIT 1
    `;
    const outcome = (t.inputs ?? {}).outcome ?? 'OPEN';
    // A closed trade's explanation never changes; an open one is re-asked at most every 10 minutes.
    return cached(`ai-explain:trade:${target.id}:${outcome}`, outcome === 'OPEN' ? 600 : 7 * 86_400, () => {
      const sheet = tradeFactSheet(t, snaps[0] ?? null);
      return ask(sheet.subject, sheet.facts);
    }, (v) => !!v?.text);
  }
  const snaps = await sql<SnapshotRow[]>`
    SELECT decision_id, time, symbol, exchange, mode, decision, reason_code, reason, regime, bias, confidence, vote_contributions,
           option_quality_grade, spread_pct, location_score, room_ratio, contract_refusal_reason
    FROM decision_snapshots WHERE symbol = ${target.symbol} AND exchange = ${target.exchange} AND mode = ${target.mode}
    ORDER BY time DESC LIMIT 1
  `;
  const snap = snaps[0];
  if (!snap) throw new ExplainNotFoundError(`No recorded ${target.mode.toLowerCase()} decision for ${target.symbol} yet`);
  return cached(`ai-explain:decision:${snap.decision_id}`, 86_400, () => {
    const sheet = decisionFactSheet(snap);
    return ask(sheet.subject, sheet.facts);
  }, (v) => !!v?.text);
}
