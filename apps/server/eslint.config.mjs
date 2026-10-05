// ============================================================
// IMPORT BOUNDARY — the AI assistant is read-only (Phase 7)
// ============================================================
// The assistant (routes + service) may read market data, quotes, the scanner
// and the alerts table. It must never import the trade, strategy, risk,
// strike, flag or learning modules — so nothing it does can mint, size,
// select, gate, configure or learn. Enforced here (npm run lint) and by
// src/api/__tests__/ai-assistant-boundary.test.ts in the test suite.
// ============================================================

import tseslint from 'typescript-eslint';

/** Module paths the assistant may not import (relative specifiers and packages). */
export const AI_ASSISTANT_FORBIDDEN = [
  // trade / strategy / slot / setups
  '**/market-bias*', '**/trade-setup*', '**/slot-arbitration*', '**/trigger-router*', '**/structure-live*', '**/setup-*', '**/momentum-break*',
  '**/strategy-*', '**/strategy*', '**/option-plans*', '**/decision-record*', '**/snapshot-context*', '**/backtesting*', '**/positional-stock-scan*',
  // risk / validation / strike selection
  '**/risk-*', '**/validation-gates*', '**/fno-validation*', '**/exposure-tracker*', '**/setup-cost*',
  // flags / configuration of the trading path
  '**/config/trading-flags*', '**/protected-constants*',
  // learning system
  '**/learning-*', '**/system-learning*',
  // the analytics engines themselves (trade-setup, strike-selection, …)
  '@fno/analytics', '@fno/analytics/*',
];

export default [
  {
    files: ['src/api/ai-assistant.ts', 'src/services/ai-assistant.ts'],
    languageOptions: { parser: tseslint.parser, sourceType: 'module', ecmaVersion: 'latest' },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: AI_ASSISTANT_FORBIDDEN,
              message: 'The AI assistant is read-only: it may not import trade, strategy, risk, strike, flag or learning modules (Phase 7 boundary).',
            },
          ],
        },
      ],
    },
  },
];
