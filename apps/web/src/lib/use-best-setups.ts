'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { useMarketScanner } from './use-market-scanner';
import { useStructureWatchlist } from './use-structure-watchlist';
import { buildSetupRows, type SetupRow, type StageMap } from './setups';

/** Each family's live stage, from the trigger registry (static server configuration; read-only). */
function useTriggerStages(): { stages: StageMap; loaded: boolean } {
  const [stages, setStages] = useState<StageMap>({});
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api
      .getDiagnosticsTriggers()
      .then((r) => {
        if (cancelled) return;
        const s = (r as { stages?: StageMap } | null)?.stages;
        if (s) setStages(s);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return { stages, loaded };
}

/**
 * Candidates from the recorded market scan and the structure watchlist, with each family's live stage so a
 * shadow-only signal is never presented as one that can trade. All sources are read-only.
 */
export function useBestSetups() {
  const scan = useMarketScanner();
  const watch = useStructureWatchlist();
  const { stages, loaded } = useTriggerStages();

  const rows: SetupRow[] = useMemo(() => buildSetupRows(scan.data, watch.rows, stages), [scan.data, watch.rows, stages]);
  const loading = (scan.loading || watch.loading || !loaded) && rows.length === 0;
  return {
    rows,
    loading,
    error: scan.error,
    scanMeta: scan.meta,
    scannedAt: scan.scannedAt,
    structureEnabled: watch.enabled,
    scanRunning: scan.running,
    runScan: scan.runScan,
    stagesLoaded: loaded,
  };
}
