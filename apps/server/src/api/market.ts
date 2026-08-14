// ============================================================
// API ROUTES — MARKET DATA
// ============================================================

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib/logger.js';
import type { MarketDataProvider } from '../providers/interface.js';
import { CM_SEGMENT, FO_SEGMENT } from '@fno/shared';
import type { CandleInterval, Exchange } from '@fno/shared';
import { getLiveIndexQuotes, ALL_INDEX_LIST } from '../services/indices.js';
import { buildMarketBias } from '../services/market-bias.js';
import { getCachedPatterns } from '../services/chart-patterns.js';

export function createMarketDataRoutes(provider: MarketDataProvider): Router {
  const router = Router();

  /**
   * GET /api/market/status
   * Get market open/close status.
   */
  router.get('/status', async (req: Request, res: Response) => {
    try {
      const exchange = (req.query.exchange as string) || 'NSE';
      const status = await provider.getMarketStatus(exchange as any);

      res.json({ success: true, data: status });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: { code: 'MARKET_STATUS_FAILED', message: error.message },
      });
    }
  });

  /**
   * GET /api/market/indices
   * Live spot quotes for the well-known indices (NIFTY, BANKNIFTY, SENSEX, FINNIFTY, MIDCPNIFTY).
   */
  router.get('/indices', async (_req: Request, res: Response) => {
    try {
      const data = await getLiveIndexQuotes(provider);
      res.json({ success: true, data, meta: { timestamp: Date.now(), source: 'LIVE' } });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Live index quotes failed');
      res.status(502).json({
        success: false,
        error: { code: 'INDICES_FETCH_FAILED', message: error.message },
      });
    }
  });

  /**
   * GET /api/market/all-indices
   * Live spot quotes for every index this terminal has a confirmed token
   * for — broad market + sectoral on NSE/BSE, plus MCX's commodity
   * benchmark indices. Powers the dedicated Indices tab.
   */
  router.get('/all-indices', async (_req: Request, res: Response) => {
    try {
      const data = await getLiveIndexQuotes(provider, ALL_INDEX_LIST);
      res.json({ success: true, data, meta: { timestamp: Date.now(), source: 'LIVE' } });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Live all-indices quotes failed');
      res.status(502).json({
        success: false,
        error: { code: 'ALL_INDICES_FETCH_FAILED', message: error.message },
      });
    }
  });

  /**
   * GET /api/market/chart-patterns
   * Cached background-scanned chart patterns (Head & Shoulders, Double
   * Top/Bottom, Triangles, Wedges, Flags) across 15m/1h, scoped to the
   * Dashboard's curated indices + current top-8 F&O movers. Updated on
   * its own ~25-minute cycle by the pattern scanner, not per-request.
   */
  router.get('/chart-patterns', async (_req: Request, res: Response) => {
    try {
      const data = await getCachedPatterns();
      res.json({ success: true, data, meta: { timestamp: Date.now(), source: 'CACHED' } });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Chart pattern read failed');
      res.status(502).json({ success: false, error: { code: 'CHART_PATTERNS_FETCH_FAILED', message: error.message } });
    }
  });

  /**
   * GET /api/market/ltp/:tokens
   * Get latest prices for comma-separated tokens.
   */
  router.get('/ltp/:tokens', async (req: Request, res: Response) => {
    try {
      const tokens = req.params.tokens.split(',');
      const exchange = ((req.query.exchange as string) || 'NSE') as Exchange;
      // Cash-market by default; pass ?segment=fo for option/futures tokens.
      const segmentMap = req.query.segment === 'fo' ? FO_SEGMENT : CM_SEGMENT;

      const data = await provider.getLTP(segmentMap[exchange], tokens);

      res.json({
        success: true,
        data,
        meta: { timestamp: Date.now(), source: 'LIVE' },
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: { code: 'LTP_FETCH_FAILED', message: error.message },
      });
    }
  });

  /**
   * GET /api/market/historical/:token
   * Get historical OHLCV data.
   */
  router.get('/historical/:token', async (req: Request, res: Response) => {
    try {
      const { token } = req.params;
      const exchange = (req.query.exchange as string) || 'NSE';
      const interval = (req.query.interval as CandleInterval) || 'ONE_DAY';
      const fromDate = req.query.from as string;
      const toDate = req.query.to as string;

      if (!fromDate || !toDate) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PARAMS', message: 'from and to query params required' },
        });
        return;
      }

      const data = await provider.getHistoricalData({
        exchange: exchange as any,
        token,
        interval,
        fromDate,
        toDate,
      });

      res.json({
        success: true,
        data,
        meta: { count: data.length, timestamp: Date.now(), source: 'HISTORICAL' },
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: { code: 'HISTORICAL_FETCH_FAILED', message: error.message },
      });
    }
  });

  /**
   * GET /api/market/bias/:symbol
   * Live market bias, regime, and intelligence score for an underlying —
   * computed from real technicals + OI + PCR, not sample data.
   */
  router.get('/bias/:symbol', async (req: Request, res: Response) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const exchange = ((req.query.exchange as string) || 'NSE') as Exchange;

      const result = await buildMarketBias(provider, symbol, exchange);

      res.json({
        success: true,
        data: result,
        meta: { timestamp: Date.now(), source: 'LIVE' },
      });
    } catch (error: any) {
      logger.error({ error: error.message, symbol: req.params.symbol }, 'Market bias build failed');
      res.status(502).json({
        success: false,
        error: { code: 'MARKET_BIAS_FAILED', message: error.message },
      });
    }
  });

  /**
   * GET /api/market/greeks/:name
   * Get option Greeks from provider.
   */
  router.get('/greeks/:name', async (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      const expiry = req.query.expiry as string;

      if (!expiry) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PARAMS', message: 'expiry query param required' },
        });
        return;
      }

      const data = await provider.getOptionGreeks(name, expiry);

      res.json({
        success: true,
        data,
        meta: { count: data.length, timestamp: Date.now() },
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: { code: 'GREEKS_FETCH_FAILED', message: error.message },
      });
    }
  });

  return router;
}
