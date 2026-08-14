// ============================================================
// API ROUTES — INSTRUMENTS
// ============================================================

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib/logger.js';
import type { MarketDataProvider } from '../providers/interface.js';
import type { Exchange } from '@fno/shared';
import { scanFnoUniverse } from '../services/fno-scanner.js';
import { cached } from '../lib/cache.js';

const SCANNER_CACHE_TTL_SECONDS = 180;

export function createInstrumentRoutes(provider: MarketDataProvider): Router {
  const router = Router();

  /**
   * GET /api/instruments
   * Search instruments by query string.
   * Query params: q (search), exchange, segment
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const query = (req.query.q as string) || '';
      const exchange = req.query.exchange as string | undefined;
      const segment = req.query.segment as string | undefined;

      if (!query || query.length < 1) {
        res.json({ success: true, data: [] });
        return;
      }

      const instruments = await provider.searchInstruments(
        query,
        exchange as any,
        segment
      );

      res.json({
        success: true,
        data: instruments,
        meta: { count: instruments.length, timestamp: Date.now() },
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Instrument search failed');
      res.status(500).json({
        success: false,
        error: { code: 'INSTRUMENT_SEARCH_FAILED', message: error.message },
      });
    }
  });

  /**
   * GET /api/instruments/fno
   * List all F&O stocks (equities with derivatives segment).
   */
  router.get('/fno', async (_req: Request, res: Response) => {
    try {
      const instruments = await provider.getInstrumentMaster();

      // Get unique F&O underlying stocks
      const fnoStocks = new Map<string, any>();
      instruments
        .filter(i =>
          i.segment === 'FO' &&
          (i.instrumentType === 'FUTSTK' || i.instrumentType === 'OPTSTK')
        )
        .forEach(i => {
          const key = i.underlying || i.symbol;
          if (!fnoStocks.has(key)) {
            fnoStocks.set(key, {
              symbol: key,
              exchange: i.exchange,
              lotSize: i.lotSize,
              hasFutures: false,
              hasOptions: false,
            });
          }
          const entry = fnoStocks.get(key)!;
          if (i.instrumentType === 'FUTSTK') entry.hasFutures = true;
          if (i.instrumentType === 'OPTSTK') entry.hasOptions = true;
        });

      const result = Array.from(fnoStocks.values()).sort((a, b) =>
        a.symbol.localeCompare(b.symbol)
      );

      res.json({
        success: true,
        data: result,
        meta: { count: result.length, timestamp: Date.now() },
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'F&O stocks list failed');
      res.status(500).json({
        success: false,
        error: { code: 'FNO_LIST_FAILED', message: error.message },
      });
    }
  });

  /**
   * GET /api/instruments/fno-scanner
   * Live price/OI/PCR/IV/bias for the whole F&O stock universe. Cached
   * for a few minutes server-side — a full scan is ~40 quote requests,
   * fine to run periodically but not on every page load.
   */
  router.get('/fno-scanner', async (req: Request, res: Response) => {
    try {
      const exchange = ((req.query.exchange as string) || 'NSE') as Exchange;
      const data = await cached(`fno-scanner:${exchange}`, SCANNER_CACHE_TTL_SECONDS, () =>
        scanFnoUniverse(provider, exchange)
      );

      res.json({
        success: true,
        data,
        meta: { count: data.length, timestamp: Date.now(), source: 'LIVE' },
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'F&O scanner failed');
      res.status(502).json({
        success: false,
        error: { code: 'FNO_SCANNER_FAILED', message: error.message },
      });
    }
  });

  /**
   * GET /api/instruments/:symbol
   * Get detailed instrument info.
   */
  router.get('/:symbol', async (req: Request, res: Response) => {
    try {
      const { symbol } = req.params;
      const instruments = await provider.searchInstruments(symbol);

      // Find exact match first
      const exact = instruments.find(
        i => i.symbol.toUpperCase() === symbol.toUpperCase() ||
             i.underlying?.toUpperCase() === symbol.toUpperCase()
      );

      if (exact) {
        res.json({ success: true, data: exact });
      } else if (instruments.length > 0) {
        res.json({ success: true, data: instruments[0] });
      } else {
        res.status(404).json({
          success: false,
          error: { code: 'INSTRUMENT_NOT_FOUND', message: `No instrument found for: ${symbol}` },
        });
      }
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: { code: 'INSTRUMENT_FETCH_FAILED', message: error.message },
      });
    }
  });

  /**
   * GET /api/expiries/:symbol
   * Get available expiry dates for an underlying.
   */
  router.get('/expiries/:symbol', async (req: Request, res: Response) => {
    try {
      const { symbol } = req.params;
      const exchange = (req.query.exchange as string) || 'NSE';

      const expiries = await provider.getExpiries(symbol, exchange as any);

      res.json({
        success: true,
        data: expiries,
        meta: { count: expiries.length, timestamp: Date.now() },
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: { code: 'EXPIRIES_FETCH_FAILED', message: error.message },
      });
    }
  });

  return router;
}
