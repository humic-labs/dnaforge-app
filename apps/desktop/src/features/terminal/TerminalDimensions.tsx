import {
  usePresentationOverlay,
  PresentationScopeContext,
} from '../../presentation/PresentationSurface';
import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useRef, useState } from 'react';
import type { TerminalFixedDimensions } from '../../shared/terminal-ipc';

export function TerminalDimensions({
  value,
  onApply,
  onClose,
}: {
  value?: TerminalFixedDimensions;
  onApply(value: TerminalFixedDimensions): Promise<void>;
  onClose(): void;
}) {
  const presentationNativeDialog = usePresentationOverlay('modal');

  const dialog = useRef<HTMLDialogElement>(null);
  const [cols, setCols] = useState(String(value?.cols ?? ''));
  const [rows, setRows] = useState(String(value?.rows ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const close = () => {
    dialog.current?.close();
    onClose();
  };
  const apply = async () => {
    setBusy(true);
    setError('');
    try {
      await onApply({
        ...(cols ? { cols: Number(cols) } : {}),
        ...(rows ? { rows: Number(rows) } : {}),
      });
      close();
    } catch (failure) {
      setError(toUserMessage(failure, 'operation.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <PresentationScopeContext.Provider value={presentationNativeDialog.scope}>
      <dialog
        ref={presentationNativeDialog.bindRef(dialog, '0')}
        className="dnaforge-terminal-dimensions bg-bg text-fg"
        aria-label="Fixed terminal dimensions"
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) close();
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void apply();
          }}
        >
          <h2>Fixed terminal dimensions</h2>
          <p>Leave a field blank to fit the available space automatically.</p>
          <label>
            Columns
            <input
              aria-label="Fixed terminal columns"
              type="number"
              min={2}
              max={1000}
              step={1}
              value={cols}
              onChange={(event) => setCols(event.target.value)}
              autoFocus
            />
          </label>
          <label>
            Rows
            <input
              aria-label="Fixed terminal rows"
              type="number"
              min={1}
              max={1000}
              step={1}
              value={rows}
              onChange={(event) => setRows(event.target.value)}
            />
          </label>
          {error && <p role="alert">{toUserMessage(error, 'operation.failed')}</p>}
          <div className="dnaforge-terminal-toolbar">
            <button
              className="wp-interactive"
              type="submit"
              aria-label="Apply terminal dimensions"
              disabled={busy}
            >
              Apply
            </button>
            <button className="wp-interactive" type="button" disabled={busy} onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      </dialog>
    </PresentationScopeContext.Provider>
  );
}
