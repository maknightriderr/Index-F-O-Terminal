// ============================================================
// API ROUTES — EXPIRY PREMIUM PRESSURE (GXP), read-only
// ============================================================
// The latest read per index (kept in memory by the runner; nothing is computed or minted by a GET), the recent read
// changes, the module's own paper positions with a routine loss classification, and the stored-snapshot backtest.

import { Router, type Request, type Response } from 'express';
import { ppClassifyLoss, GXP_STRATEGY_ID, GXP_VERSION, GXP_CONFIG } from '@fno/analytics';
import { logger } from '../lib/logger.js';
import { sql } from '../lib/db.js';
import { premiumPressureEvents, premiumPressureLatest, gxpPaperEnabled } from '../services/premium-pressure/runner.js';
import { runGxpBacktest } from '../services/premium-pressure/backtest.js';

const BACKTEST_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY', 'BANKEX'];
let backtestBusy = false;

export function createPremiumPressureRoutes(): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.json({ success: true, data: { version: GXP_VERSION, strategy: GXP_STRATEGY_ID, paperEntries: gxpPaperEnabled(), weights: GXP_CONFIG.weights, windowsMin: GXP_CONFIG.windows, reads: premiumPressureLatest(), events: premiumPressureEvents().slice(-30).reverse() }, meta: { readOnly: true, simulated: true, timestamp: Date.now() } });
  });

  router.get('/trades', async (_req: Request, res: Response) => {
    try {
      const rows = await sql<any[]>`SELECT id, session, status, state, net_pnl, opened_at FROM fresh_paper_positions WHERE strategy = ${GXP_STRATEGY_ID} ORDER BY opened_at DESC LIMIT 200`;
      const trades = rows.map((p) => {
        const st = typeof p.state === 'string' ? JSON.parse(p.state) : p.state ?? {}, net = Number(st.netPnl ?? p.net_pnl ?? 0), risk = Number(st.originalRiskCurrency ?? 0), entry = st.candidate?.evidence?.gxp ?? null;
        return {
          id: p.id, session: p.session, status: p.status, contract: st.contract?.id ?? null, direction: st.candidate?.direction ?? null, entry: st.entry ?? null, exit: st.exitPrice ?? null, exitReason: st.exitReason ?? null,
          netPnl: Math.round(net), r: risk > 0 ? Math.round((net / risk) * 100) / 100 : null, classificationAtEntry: entry?.classification ?? null, scoreAtEntry: entry?.score ?? null,
          lossClass: p.status === 'CLOSED' && net < 0 ? ppClassifyLoss({ exitReason: st.exitReason ?? null, netPnl: net, entry }) : null, simulated: true,
        };
      });
      res.json({ success: true, data: { trades }, meta: { readOnly: true, simulated: true, timestamp: Date.now() } });
    } catch (e: any) {
      logger.error({ error: e.message }, 'Premium pressure trades read failed');
      res.status(503).json({ success: false, error: { code: 'GXP_TRADES_UNAVAILABLE', message: 'Premium-pressure paper trades could not be read.' } });
    }
  });

  router.get('/backtest', async (req: Request, res: Response) => {
    if (backtestBusy) return res.status(429).json({ success: false, error: { code: 'GXP_BACKTEST_BUSY', message: 'A backtest is already running.' } });
    backtestBusy = true;
    try {
      const days = Math.min(30, Math.max(1, parseInt(String(req.query.days ?? '30'), 10) || 30));
      const asked = String(req.query.symbols ?? '').toUpperCase().split(',').map((s) => s.trim()).filter((s) => /^[A-Z0-9&-]{2,20}$/.test(s)).slice(0, 8);
      res.json({ success: true, data: await runGxpBacktest(asked.length ? asked : BACKTEST_SYMBOLS, days), meta: { readOnly: true, simulated: true, timestamp: Date.now() } });
    } catch (e: any) {
      logger.error({ error: e.message }, 'Premium pressure backtest failed');
      res.status(503).json({ success: false, error: { code: 'GXP_BACKTEST_FAILED', message: 'The stored-snapshot backtest could not be run.' } });
    } finally { backtestBusy = false; }
  });

  return router;
}
