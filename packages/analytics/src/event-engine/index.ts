// ============================================================
// EVENT ENGINE — multi-path, event-driven research architecture
// ============================================================
// RESEARCH / SHADOW ONLY. Nothing in this module is read by a live or paper
// decision path; it does not change the structure engine, the consensus
// engine, any gate, any option selection or any flag.
//
//   context.ts       ATR, EMA, session range, liquidity pools, market state
//   events.ts        detectors → the chronological event log per session
//   triggers.ts      the trigger registry (pre-registered rules) + evaluation,
//                    move potential and entry timing
//   candidates.ts    parent-setup grouping, the major-move diagnostic
//   data-quality.ts  session coverage before anything is called a miss
// ============================================================

export * from './types.js';
export * from './context.js';
export * from './events.js';
export * from './triggers.js';
export * from './candidates.js';
export * from './arbitration.js';
export * from './data-quality.js';
