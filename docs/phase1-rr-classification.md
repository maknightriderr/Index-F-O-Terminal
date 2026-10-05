# Phase 1 — R:R classification audit (2026-10-05)

Searched `apps/server`, `packages/analytics`, `apps/web` (and `packages/shared`) case-insensitively for `1.5`, `1.50`, `MIN_RR`, `MIN_NET_RR`, `MIN_NET_RISK_REWARD`, `REQUIRED_RR`, `requiredRr`, `RR_THRESHOLD`, `minimum RR`, `minimumRiskReward`, `MIN_RISK_REWARD`, `minT1R`, `RR_MIN`, `RICH_IV_MIN_RISK_REWARD`, `LOW_RR`, `REWARD_RISK_TOO_LOW`, `rrOnly`, `rrIsGate`, `1.50R` / `1.5R`, plus every comparison of `riskReward` / `rToT1` / `netRR` against a constant. Each hit was read with its callers.

Classes: **(a)** R:R gate → removed · **(b)** display / ranking only → kept · **(c)** unrelated, research-only or a genuine check → kept.

## (a) R:R gates — removed from the live path

| # | Location | What it did | Change |
|---|---|---|---|
| 1 | `packages/analytics/src/structure-engine/index.ts` `confirm()` — `st.rToT1 < rules.minT1R` → `LOW_RR` | A confirmed S1 setup with T1 < 1.5R became terminal LOW_RR (never filled) | Live engine calls pass `liveStructureRulesFor()` (`minT1R: 0`). The `!(risk > 0) || !t1` geometry check still yields LOW_RR ("no valid target"). Research / backtests keep `STRUCTURE_RULES`. |
| 2 | `structure-live.ts` `structureSequenceRefusal` — `reward / risk < STRUCTURE_RULES.minT1R` | Refused a fill whose T1 was < 1.5R away | Removed. Kept: no levels, at / through the stop, at / through T1. |
| 3 | `structure-live.ts` `fillCandidate` keep-alive branch — `rr >= STRUCTURE_RULES.minT1R` | Offered a kept-alive setup only at ≥ 1.5R | Removed with the keep-alive state (`LiveLifecycle.keepAlive`). |
| 4 | `trade-setup/index.ts` non-structural branch — `stopWidth < minStopWidth` after sizing for `requiredRr` → `REWARD_RISK_TOO_LOW` | Refused when the target could not pay 1.5R at the tightest stop | `rrGate: false` (every live caller): the stop is sized as before when affordable, else the tightest tradeable stop (`MIN_SL_PREMIUM_PCT`); never refused for R:R. |
| 5 | `trade-setup/index.ts` structural branch — `netRrAtStop < requiredRr` → `REWARD_RISK_TOO_LOW` | Refused when net R:R at the structural stop < 1.5 | `rrGate: false`: not refused; a stop tighter than the minimum premium stop is widened to it. |
| 6 | `trade-setup/index.ts` noise widening — `ceiling = min(cap, rrStopWidth)` | The R:R-affordable width capped the noise widening | `rrGate: false`: only the 45 % cap. |
| 7 | `trade-setup/index.ts` / `trading-flags.ts` `RICH_IV_MIN_RISK_REWARD` (2.0) via `requiredRr` | A higher R:R bar when IV is rich | Not applied with `rrGate: false` (still recorded as `requiredRiskReward`). |
| 8 | `market-bias.ts` `storedIsPlausible` — `riskReward >= MIN_RISK_REWARD` | Retired a minted trade below 1.5R on the next read | `isNakedLongRiskRewardPlausible`: `0 < R:R ≤ MAX_RISK_REWARD`. |
| 9 | `trigger-router.ts` `validateCandidateRisk` — `bucket !== 'TRADE'` | Rejected LOW_RR family candidates | `LOW_RR` (valid geometry) is tradeable; `NO_TARGET` / `INVALID_STOP` still rejected. |
| 10 | `trigger-router.ts` `recoveredFamilyCandidates`, `keepFamilyAlive`, `displayOnlyFamilyWatch`, watch causes | Re-handed families once they "recovered" to ≥ 1.5R | Removed; the family watch is display-only. |
| 11 | `setup-watch-core.ts` `RR_MIN`, `rrStatus(…min)`, RR_RECOVERED, `keepAliveStep`, `rrAtMin`, `startedBelowMin`, `firstAtMinAt` | Status / lifecycle decided by 1.5R | Removed. Status "Confirmed — R:R x" + display-only `rrBand`. |
| 12 | `market-bias.ts` `recordRefusal(rrOnly)` / `recordStructureOutcome(keepAlive)` / per-bar claim key | R:R-only refusals kept the setup alive | Removed (no R:R refusal exists any more). |
| 13 | `fno-validation.ts` `rrIsGate` | Display-vs-mint strike tiering by R:R refusal | Removed (live builds never refuse for R:R). |
| 14 | `signal-diagnostics.ts` `diagnosticsRrRecovery` + `GET /api/diagnostics/rr-recovery` | Reported recovery to 1.50R | Removed. |

## (b) Display / ranking only — kept

| Location | Use |
|---|---|
| `packages/analytics/src/trade-setup/index.ts` `MIN_RISK_REWARD = 1.5` | Protected constant (`protected-constants.ts`); now the displayed reference `RR_REFERENCE` (rrBand edge). Still the gate only for callers that keep `rrGate` on (research, golden snapshots). |
| `setup-watch-core.ts` `rrBandOf` (1.0 / 1.5 edges) | Display band. |
| `slot-arbitration.ts` criterion #3 "net R:R after costs" | Ranking. |
| `fno-validation.ts` `rankStrikeBuilds` net R:R | Strike ranking. |
| `event-engine/triggers.ts` `movePotentialAt` (LOW when `rToT1 < minT1R`) | Move-potential class (ranking criterion #2). |
| `event-engine/triggers.ts` `entryTimingAt` (≥ 1.5R ACCEPTABLE, < 1R CHASING) | Timing class (ranking criterion #1). |
| `event-engine` `CandidateBucket` `LOW_RR` label | Research label; the server treats it as tradeable. |
| `structure-live.ts` gate-diagnostic thresholds (`minT1R`) | Displayed in diagnostics. |
| `setup-events.ts` `wouldBeValidIf` for LOW_RR rows | Text on historical rows. |
| `apps/web` `structure-stage.tsx` `LOW_RR` label ("No valid target"), `asset-workspace` rrBand chip | Display. |
| `trade-setup/index.ts` `requiredRiskReward` record, reason text | Informational. |

## (c) Unrelated / research / genuine — kept

| Location | Why |
|---|---|
| `STRUCTURE_RULES.minT1R`, `STRUCTURE_RULES_5M.minT1R`, `EVENT_RULES.minT1R` (analytics) | Pre-registered research rules; backtests and research reports must stay reproducible. The live path overrides them. |
| `apps/server/src/research/*`, `backtest/*`, `cli/*` (sweep-close, structure backtests, harness, multipath, funnel, momentum report) | Research / backtest code, not the live path. |
| `event-engine/candidates.ts` major-move "T1 ≥ 1.5R" text | Research diagnostic wording. |
| `research-contract.ts` `REWARD_RISK_TOO_LOW: 'REFUSED'`, grading / diagnostics `event_type IN (… 'LOW_RR' …)` | Classify / grade historical rows. |
| `protected-constants.ts` needle | Protects the constant; unchanged. |
| `MAX_RISK_REWARD = 6` | Data-quality ceiling (bad upstream Greeks), not a minimum. |
| `COST_EXCEEDS_EDGE` (`netReward <= 0`) | Genuine validity: the target does not clear costs — no reward at all (see Assumptions). |
| Structure `LATE` (`lateR`, 1R of progress) | Timing rule (price already travelled), not R:R. |
| `outcome-classifier.ts` comment | Comment only. |
