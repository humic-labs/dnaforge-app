import { useEffect, type ReactNode } from 'react';
import { useAISettingsStore } from './settings';

export function AISettingsBoundary({ children }: { children: ReactNode }) {
  const status = useAISettingsStore((state) => state.initializationStatus);
  const initialize = useAISettingsStore((state) => state.initialize);

  useEffect(() => {
    if (status === 'pending') void initialize();
  }, [initialize, status]);

  if (status === 'pending' || status === 'loading' || status === 'error') {
    return (
      <div
        className="flex h-full min-h-32 flex-col items-center justify-center gap-3 p-6 text-sm text-fg-muted"
        data-testid="ai-startup-status"
        role={status === 'error' ? 'alert' : 'status'}
      >
        <p>
          {status === 'error' ? 'Saved AI settings could not be loaded.' : 'Loading AI settings…'}
        </p>
        {status === 'error' && (
          <button
            className="rounded border border-border px-3 py-2"
            onClick={() => void useAISettingsStore.getState().initialize()}
          >
            Retry AI settings
          </button>
        )}
      </div>
    );
  }
  return children;
}
