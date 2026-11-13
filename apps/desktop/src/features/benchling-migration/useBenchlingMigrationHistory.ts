import { toUserMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useState } from 'react';
import type { PlatformBridge } from '../../platform';
import type { BenchlingMigrationHistorySummaryView } from '../../shared/benchling-migration-ipc';

type HistoryBridge = Pick<PlatformBridge['benchlingMigration'], 'getHistory'>;

export function useBenchlingMigrationHistory(bridge: HistoryBridge, enabled: boolean) {
  const [history, setHistory] = useState<BenchlingMigrationHistorySummaryView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      setHistory(await bridge.getHistory());
      setError(null);
    } catch (cause) {
      setError(toUserMessage(cause, 'failure.migration-history-is-unavailable'));
    }
  }, [bridge, enabled]);

  useEffect(() => {
    if (!enabled) {
      setHistory([]);
      setError(null);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [enabled, refresh]);

  return { history, error, refresh };
}
