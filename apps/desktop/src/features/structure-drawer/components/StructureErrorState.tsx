import { toUserMessage } from '@waypoint/user-messages';
import type { StructureDrawerError } from '../types/structure-drawer';

interface Props {
  error: StructureDrawerError;
  onRetry: () => void;
}

export function StructureErrorState({ error, onRetry }: Props) {
  return (
    <div
      data-testid="structure-error-state"
      className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center"
    >
      <div className="text-3xl text-error">⚠</div>
      <div className="text-sm font-medium text-fg">Structure couldn&apos;t load</div>
      <div className="max-w-xs text-xs text-fg-muted">
        {toUserMessage(error, 'structure.failed')}
      </div>
      <button
        data-testid="structure-error-retry"
        onClick={onRetry}
        className="rounded border border-border bg-bg-subtle px-3 py-1 text-xs wp-interactive"
      >
        {error.failedStep ? 'Try a different source' : 'Retry'}
      </button>
    </div>
  );
}
