import { userMessage } from '@waypoint/user-messages';
import { useEffect } from 'react';
import { isDesktopRuntime } from '../../utils/environment';
import { useToastStore } from '../../stores/toast-store';

export function useSheetSyncProjects(paths: readonly string[], enabled: boolean): void {
  const key = enabled ? [...new Set(paths)].sort().join('\0') : '';
  useEffect(() => {
    if (!key || !isDesktopRuntime()) return;
    let disposed = false;
    let release: Array<() => void> = [];
    void import('./sheet-sync-projects')
      .then((module) => {
        if (!disposed) release = key.split('\0').map((path) => module.retainSheetSyncProject(path));
      })
      .catch(() => {
        if (!disposed)
          useToastStore
            .getState()
            .addToast(
              userMessage('notice.spreadsheet-sync-could-not-start-reopen-the-project-to-retry'),
              {
                definition: 'sheet-sync-project-start-failed',
              }
            );
      });
    return () => {
      disposed = true;
      for (const stop of release) stop();
    };
  }, [key]);
}
