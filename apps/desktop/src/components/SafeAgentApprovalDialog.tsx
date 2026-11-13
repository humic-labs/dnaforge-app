import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';

import { safeFocus } from '../shared/utils/safeFocus';

interface SafeAgentApprovalDialogProps {
  title: string;
  body: ReactNode;
  allowLabel: string;
  denyLabel: string;
  onAllow: () => void;
  onDeny: () => void;
  testId: string;
  allowTestId: string;
  denyTestId: string;
}

export function SafeAgentApprovalDialog({
  title,
  body,
  allowLabel,
  denyLabel,
  onAllow,
  onDeny,
  testId,
  allowTestId,
  denyTestId,
}: SafeAgentApprovalDialogProps) {
  const modalRef = useRef<HTMLDialogElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const modal = modalRef.current;
    modal?.showModal();
    return () => {
      if (modal?.open) modal.close();
    };
  }, []);

  useEffect(() => {
    safeFocus(denyRef.current);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Enter') {
        event.preventDefault();
        onDeny();
      }
    };
    const handleClickOutside = (event: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(event.target as Node)) onDeny();
    };

    window.addEventListener('keydown', handleKeyDown);
    const timer = setTimeout(() => document.addEventListener('mousedown', handleClickOutside), 0);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onDeny]);

  return (
    <dialog
      ref={modalRef}
      className="fixed inset-0 m-0 h-full w-full max-h-none max-w-none border-0 p-0 items-center justify-center bg-black/50 backdrop:bg-transparent open:flex"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={`${testId}-title`}
      onCancel={(event) => {
        event.preventDefault();
        onDeny();
      }}
      data-testid={testId}
      data-agent-approval-ui="safe-default-v1"
    >
      <div
        ref={dialogRef}
        className="bg-bg border border-border rounded-lg shadow-xl max-w-md w-full mx-4"
      >
        <div className="px-4 py-3 border-b border-border">
          <h2 id={`${testId}-title`} className="text-sm font-medium text-fg">
            {title}
          </h2>
        </div>
        <div className="px-4 py-3 space-y-2">{body}</div>
        <div className="px-4 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onAllow}
            className="px-3 py-1.5 text-sm text-red-500 hover:bg-red-500/10 rounded transition-colors"
            data-testid={allowTestId}
          >
            {allowLabel}
          </button>
          <button
            ref={denyRef}
            type="button"
            onClick={onDeny}
            className="px-3 py-1.5 text-sm bg-accent text-white hover:bg-accent/90 rounded transition-colors"
            data-testid={denyTestId}
            autoFocus
          >
            {denyLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
