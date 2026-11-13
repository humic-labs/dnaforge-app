import { toUserMessage } from '@waypoint/user-messages';
import { useEffect } from 'react';
import { Button } from '../../../components/ui';

export function AssemblyEditUnsavedDialog({
  busy,
  error,
  onChoose,
}: {
  busy: boolean;
  error: string | null;
  onChoose: (choice: 'save' | 'discard' | 'cancel') => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return;
      event.preventDefault();
      event.stopPropagation();
      onChoose('cancel');
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [busy, onChoose]);

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40"
      data-testid="assembly-edit-unsaved-backdrop"
      onMouseDown={() => {
        if (!busy) onChoose('cancel');
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="assembly-edit-unsaved-title"
        data-testid="assembly-edit-unsaved-dialog"
        className="mx-4 w-full max-w-sm rounded-lg border border-border bg-bg-subtle p-4 shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h3 id="assembly-edit-unsaved-title" className="text-sm font-semibold text-fg">
          Unsaved sequence changes
        </h3>
        <p className="mt-2 text-sm leading-5 text-fg-muted">
          Save or discard the current sequence edits before editing its assembly?
        </p>
        {error ? (
          <p className="mt-2 text-sm text-error" role="alert">
            {toUserMessage(error, 'tracks.loadFailed')}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button type="button" autoFocus disabled={busy} onClick={() => onChoose('cancel')}>
            Cancel
          </Button>
          <Button type="button" disabled={busy} onClick={() => onChoose('discard')}>
            Discard changes
          </Button>
          <Button type="button" disabled={busy} onClick={() => onChoose('save')} variant="primary">
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </div>
  );
}
