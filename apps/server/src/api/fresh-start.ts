import { Router } from 'express';
import { freshStartStatus } from '../services/fresh-start/status.js';
import { logger } from '../lib/logger.js';
export function createFreshStartRoutes() {
    const router = Router();
    router.get('/status', async (_req, res) => {
        try {
            res.json({ success: true, data: await freshStartStatus(), meta: { readOnly: true, timestamp: Date.now() } });
        }
        catch (e: any) {
            logger.error({ error: e.message }, 'Fresh start status read failed');
            res.status(503).json({ success: false, error: { code: 'FRESH_STATUS_UNAVAILABLE', message: 'Fresh-start status could not be read.' } });
        }
    });
    return router;
}
