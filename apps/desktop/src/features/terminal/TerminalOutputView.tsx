import {
  usePresentationOverlay,
  PresentationScopeContext,
} from '../../presentation/PresentationSurface';
import { useEffect, useRef } from 'react';

export function TerminalOutputView({
  text,
  onClose,
  onCopy,
}: {
  text: string;
  onClose(): void;
  onCopy(): void;
}) {
  const presentationNativeDialog = usePresentationOverlay('modal');

  const dialog = useRef<HTMLDialogElement>(null);
  const close = () => {
    dialog.current?.close();
    onClose();
  };
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <PresentationScopeContext.Provider value={presentationNativeDialog.scope}>
      <dialog
        data-terminal-surface
        ref={presentationNativeDialog.bindRef(dialog, '0')}
        aria-label="Terminal output"
        className="dnaforge-terminal-output-view bg-bg text-fg"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        <div className="dnaforge-terminal-toolbar">
          <h2>Terminal output</h2>
          <button onClick={onCopy}>Copy output</button>
          <button aria-label="Close terminal output" onClick={close}>
            Close
          </button>
        </div>
        <textarea
          aria-label="Accessible terminal output"
          readOnly
          value={text}
          autoFocus
          spellCheck={false}
        />
      </dialog>
    </PresentationScopeContext.Provider>
  );
}
