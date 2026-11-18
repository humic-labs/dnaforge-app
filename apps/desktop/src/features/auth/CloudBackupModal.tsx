import {
  usePresentationOverlay,
  PresentationScopeContext,
} from '../../presentation/PresentationSurface';
import type { ReactNode } from 'react';

export function CloudBackupModal({
  open,
  onClose,
  title = 'Cloud backup',
  testId = 'account-cloud-backup-modal',
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  testId?: string;
  children: ReactNode;
}) {
  const presentationOverlay = usePresentationOverlay('modal');

  if (!open) return null;

  return (
    <PresentationScopeContext.Provider value={presentationOverlay.scope}>
      <div
        className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
        data-testid={testId}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        ref={presentationOverlay.bindRef(undefined, '0')}
      >
        <div className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-border bg-bg p-5 shadow-xl">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-fg">{title}</h2>
            <button
              type="button"
              className="rounded px-2 py-1 text-sm text-fg-muted wp-interactive "
              onClick={onClose}
              data-testid={`${testId}-close`}
            >
              Close
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        </div>
      </div>
    </PresentationScopeContext.Provider>
  );
}
