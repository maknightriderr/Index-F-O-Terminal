// ============================================================
// AI ASSISTANT
// ============================================================
// Grounds Claude in a compact live-data snapshot (indices, F&O
// universe aggregates, recent alerts) rather than letting it answer
// from training data alone — the snapshot reuses the SAME cached
// scan/quote calls the rest of the app already makes, so a chat
// message doesn't trigger fresh Angel One calls on every turn.
// Deliberately does NOT dump the full 200+ row scanner or pull a
// per-symbol historical/Greeks read per message — that's what the
// asset workspace tab and Strategy Scanner are for; this assistant
// summarizes/explains, it doesn't replace them.
// ============================================================

import { cached } from '../lib/cache.js';
import { getLiveIndexQuotes } from './indices.js';
import { scanFnoUniverse } from './fno-scanner.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { askClaude, type ChatTurn } from '../lib/anthropic.js';
import type { MarketDataProvider } from '../providers/interface.js';

const INDEX_CONTEXT_CACHE_TTL_SECONDS = 60;
const SCANNER_CACHE_TTL_SECONDS = 180; // matches instruments.ts's fno-scanner cache TTL — same key, shared cache

const SYSTEM_PROMPT_HEADER = `You are the AI Assistant embedded in a personal F&O trading terminal for Indian markets (NSE/BSE/MCX, via Angel One). Answer using ONLY the live data snapshot below plus general market/options knowledge — never invent numbers that aren't in the snapshot. Be concise and plain-spoken; a few sentences unless asked for more. If the snapshot doesn't have what's needed to answer precisely, say so and point to which terminal tab would (F&O Stocks, IV & Greeks, OI Intelligence, Strategy Scanner, Alerts, or opening the specific stock's tab for a full technical/option-chain read). This is data summarization and explanation, not investment advice — never phrase a reply as a recommendation to buy or sell.`;

interface AlertRow {
  symbol: string;
  alert_type: string;
  message: string;
  severity: string;
  created_at: Date;
}

async function buildMarketContext(provider: MarketDataProvider): Promise<string> {
  const [indices, rows, recentAlerts] = await Promise.all([
    cached('ai-context:indices', INDEX_CONTEXT_CACHE_TTL_SECONDS, () => getLiveIndexQuotes(provider)),
    cached('fno-scanner:NSE', SCANNER_CACHE_TTL_SECONDS, () => scanFnoUniverse(provider, 'NSE')),
    sql<AlertRow[]>`
      SELECT symbol, alert_type, message, severity, created_at FROM alerts ORDER BY created_at DESC LIMIT 10
    `.catch((err) => {
      logger.warn({ error: err.message }, 'AI context: recent alerts fetch failed');
      return [] as AlertRow[];
    }),
  ]);

  const bullish = rows.filter((r) => r.direction === 'BULLISH').length;
  const bearish = rows.filter((r) => r.direction === 'BEARISH').length;
  const neutral = rows.length - bullish - bearish;

  const topByScore = [...rows].sort((a, b) => b.score - a.score).slice(0, 8);
  const topOiMovers = [...rows]
    .filter((r) => r.futuresOi > 0)
    .sort((a, b) => Math.abs(b.futuresChangeOiPercent) - Math.abs(a.futuresChangeOiPercent))
    .slice(0, 5);
  const topIvRank = rows
    .filter((r): r is typeof r & { ivRank: number } => r.ivRank != null)
    .sort((a, b) => b.ivRank - a.ivRank)
    .slice(0, 5);

  const lines: string[] = [];
  lines.push(`Live snapshot as of ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST.`);
  lines.push('');
  lines.push(
    'Indices: ' +
      (indices.length > 0
        ? indices.map((i) => `${i.symbol} ${i.ltp.toFixed(2)} (${i.changePercent >= 0 ? '+' : ''}${i.changePercent.toFixed(2)}%)`).join(' | ')
        : 'unavailable right now')
  );
  lines.push('');
  if (rows.length > 0) {
    lines.push(`F&O universe (NSE, ${rows.length} stocks): ${bullish} bullish, ${bearish} bearish, ${neutral} neutral.`);
    lines.push('Top by intelligence score: ' + topByScore.map((r) => `${r.symbol} (${r.score}, ${r.direction})`).join(', '));
    lines.push(
      'Largest futures OI% swings: ' +
        (topOiMovers.length > 0
          ? topOiMovers.map((r) => `${r.symbol} (${r.futuresChangeOiPercent >= 0 ? '+' : ''}${r.futuresChangeOiPercent.toFixed(1)}%, ${r.oiInterpretation})`).join(', ')
          : 'none notable')
    );
    lines.push(
      'Richest IV Rank: ' +
        (topIvRank.length > 0 ? topIvRank.map((r) => `${r.symbol} (${r.ivRank})`).join(', ') : 'not enough history yet across the universe')
    );
  } else {
    lines.push('F&O universe scanner: unavailable right now.');
  }
  lines.push('');
  if (recentAlerts.length > 0) {
    lines.push('Recent alerts (newest first):');
    for (const a of recentAlerts) lines.push(`- [${a.severity}] ${a.symbol}: ${a.message}`);
  } else {
    lines.push('No recent alerts.');
  }

  return lines.join('\n');
}

export async function chat(provider: MarketDataProvider, message: string, history: ChatTurn[]): Promise<string> {
  const context = await buildMarketContext(provider);
  const system = `${SYSTEM_PROMPT_HEADER}\n\n<snapshot>\n${context}\n</snapshot>`;
  const messages: ChatTurn[] = [...history, { role: 'user', content: message }];
  return askClaude(system, messages);
}
