import { Button } from '../../../components/ui';
import {
  retrySequenceHistory,
  refreshSequenceHistoryDisplay,
  useSequenceHistoryRecovery,
} from '../sequence-history-recovery';

export function SequenceHistoryNotice({ documentId }: { documentId: string }) {
  const recovery = useSequenceHistoryRecovery((state) => state.documents[documentId]);
  if (!recovery) return null;
  return (
    <div
      role="status"
      data-testid="sequence-history-recovery"
      className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <span>
        {recovery.status === 'delivery-pending'
          ? 'Sequence saved. Its view needs to refresh.'
          : recovery.status === 'revision-changed'
            ? 'Sequence saved. Its saved revision changed on disk. Review History before committing.'
            : recovery.status === 'unavailable'
              ? 'Sequence saved. Git history is unavailable for this document.'
              : 'Sequence saved. Its Git history needs a retry.'}
      </span>
      {recovery.status === 'delivery-pending' && (
        <Button type="button" onClick={() => void refreshSequenceHistoryDisplay(documentId)}>
          Refresh view
        </Button>
      )}
      {(recovery.status === 'pending' || recovery.status === 'retrying') && (
        <Button
          type="button"
          data-testid="sequence-history-retry"
          disabled={recovery.status === 'retrying'}
          onClick={() => void retrySequenceHistory(documentId)}
        >
          {recovery.status === 'retrying' ? 'Retrying history…' : 'Retry history'}
        </Button>
      )}
    </div>
  );
}
