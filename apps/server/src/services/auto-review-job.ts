// Separate observer: no close hooks, broker calls or imports from the decision/learning path.
import { logger } from '../lib/logger.js';
import { isAiConfigured } from '../lib/llm.js';
import { schemaFileReady } from './ensure-capture-schema.js';
import { automaticReviewEvidence, autoReviewEnabled, writeAutomaticReview } from './ai-trade-review.js';
import { automaticReviewSource, claimAutomaticReview, completeAutomaticReview, discoverAutomaticReviews, retryAutomaticReview } from './auto-review-store.js';

let running = false;
export async function runAutomaticReviewTick() {
  if (running || !autoReviewEnabled() || !schemaFileReady('046_automatic_ai_trade_reviews.sql')) return;
  running = true;
  try {
    await discoverAutomaticReviews();
    // Keep pending work durable even during a missing-key outage. No provider calls until configured.
    if (!isAiConfigured()) return;
    for (let i = 0; i < 2; i++) {
      const claim = await claimAutomaticReview();
      if (!claim) break;
      try {
        const source = await automaticReviewSource(claim, schemaFileReady('044_paper_execution_ledger.sql'));
        const evidence = automaticReviewEvidence(source);
        const answer = await writeAutomaticReview(evidence);
        await completeAutomaticReview(claim, evidence, answer);
      } catch {
        // Never persist provider error bodies (they can contain request data or credentials).
        await retryAutomaticReview(claim);
      }
    }
  } finally { running = false; }
}

export function startAutomaticTradeReview() {
  // The supervisor owns these timers and can restart them; no persistent "started" flag.
  const tick = () => runAutomaticReviewTick().catch(() => logger.warn('Automatic trade review tick failed; durable queue will retry'));
  setTimeout(tick, 15000);
  setInterval(tick, 60000);
}
