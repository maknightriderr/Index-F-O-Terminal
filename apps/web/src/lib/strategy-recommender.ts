// Moved to @fno/shared so the server's track-record job grades exactly what
// this page recommends. Re-exported here under the names the page uses.
export { recommendStrategy, STRATEGY_MIN_CONFIDENCE } from '@fno/shared';
export type {
  ScannerStrategyCategory as StrategyCategory,
  ScannerRiskProfile as RiskProfile,
  ScannerStrategyRecommendation as StrategyRecommendation,
} from '@fno/shared';
