import { useEffect, useRef } from 'react';
import { COMMAND_SCOPES, useCommandScope } from '../../commands';

export function TerminalOutputView({
  text,
  onClose,
  onCopy,
}: {
  text: string;
  onClose(): void;
  onCopy(): void;
}) {
  useCommandScope(COMMAND_SCOPES.modal, { claimOnMount: true });
  const dialog = useRef<HTMLDialogElement>(null);
  const close = () => {
    dialog.current?.close();
    onClose();
  };
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      data-terminal-surface
      ref={dialog}
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
  );
}
