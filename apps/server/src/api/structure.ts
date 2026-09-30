// ============================================================
// API ROUTES — STRUCTURE ENGINE
// ============================================================
// GET /api/structure/watchlist
//   The current non-terminal lifecycle stage of every symbol the structure
//   engine is tracking — WATCH (price near an untaken pool), DEVELOPING (the
//   pool was swept), CONFIRMED (the limit is resting), ENTRY / ACTIVE —
//   read from the Redis lifecycle state (structure_setup:*). Read-only; it
//   never evaluates a symbol, so it can never mint anything.
// ============================================================

import { Router, type Request, type Response } from 'express';
import type { StructureLifecycleView } from '@fno/shared';
import { logger } from '../lib/logger.js';
import { decisionIstDate } from '../services/decision-clock.js';
import { readAllLiveStates } from '../services/setup-lifecycle.js';
import { watchlistRows } from '../services/structure-live.js';
import { readCachedStructurePreview } from '../services/market-bias.js';
import { STRUCTURE } from '../config/trading-flags.js';

const STAGE_ORDER: Record<string, number> = { ACTIVE: 0, ENTRY: 1, CONFIRMED: 2, DEVELOPING: 3, WATCH: 4 };

export function createStructureRoutes(): Router {
  const router = Router();

  router.get('/watchlist', async (_req: Request, res: Response) => {
    try {
      const today = decisionIstDate();
      const states = await readAllLiveStates();
      const rows: StructureLifecycleView[] = states
        .filter((s) => s.day === today)
        .flatMap((s) => watchlistRows(s))
        .sort((a, b) => (STAGE_ORDER[a.stage] ?? 9) - (STAGE_ORDER[b.stage] ?? 9) || (b.score ?? -1) - (a.score ?? -1) || b.stageAt - a.stageAt);

      // CONFIRMED rows get whatever preview the last /api/market/bias poll
      // for that symbol already cached (structure_preview:*, 60s TTL) — a
      // plain cache READ, never a compute-on-miss, so this endpoint stays
      // exactly what its own comment promises: it never evaluates a symbol.
      await Promise.all(
        rows.map(async (row) => {
          if (row.stage !== 'CONFIRMED' || row.liveOutcome != null) return;
          const preview = await readCachedStructurePreview(row.exchange, row.symbol, row.mode, row.id);
          if (preview) row.preview = preview;
        })
      );

      res.json({ success: true, data: { enabled: STRUCTURE, day: today, rows }, meta: { count: rows.length, timestamp: Date.now(), source: 'LIVE' } });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Structure watchlist read failed');
      res.status(502).json({ success: false, error: { code: 'STRUCTURE_WATCHLIST_FAILED', message: error.message } });
    }
  });

  return router;
}
