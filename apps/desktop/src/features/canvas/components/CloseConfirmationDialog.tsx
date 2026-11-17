import {
  usePresentationOverlay,
  PresentationScopeContext,
  usePresentationListener,
} from '../../../presentation/PresentationSurface';
import { Button } from '../../../components/ui';
import { safeFocus } from '../../../shared/utils/safeFocus';

import { useEffect, useLayoutEffect, useRef } from 'react';

interface CloseConfirmationDialogProps {
  fileName: string;
  onSave: () => void;
  onDontSave: () => void;
  onCancel: () => void;
  allowDontSave?: boolean;
}

export function CloseConfirmationDialog({
  fileName,
  onSave,
  onDontSave,
  onCancel,
  allowDontSave = true,
}: CloseConfirmationDialogProps) {
  const presentationOverlay = usePresentationOverlay('modal');
  const presentationEvents = usePresentationListener(presentationOverlay.scope);

  const modalRef = useRef<HTMLDialogElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    modal.showModal();
    safeFocus(saveRef.current, { preventScroll: true });
    const containFocus = (event: FocusEvent) => {
      if (modal.open && !modal.contains(event.target as Node))
        safeFocus(saveRef.current, { preventScroll: true });
    };
    document.addEventListener('focusin', containFocus);
    return () => {
      document.removeEventListener('focusin', containFocus);
      if (modal.open) modal.close();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        const buttons = [
          ...(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ??
            []),
        ];
        const first = buttons[0];
        const last = buttons.at(-1);
        const active = document.activeElement;
        if (
          first &&
          last &&
          (!buttons.includes(active as HTMLButtonElement) ||
            (e.shiftKey ? active === first : active === last))
        ) {
          e.preventDefault();
          safeFocus(e.shiftKey ? last : first, { preventScroll: true });
        }
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onCancel();
      }
    };

    presentationEvents.add(window, 'keydown', handleKeyDown);
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      presentationEvents.remove(window, 'keydown', handleKeyDown);
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onCancel, presentationEvents]);

  return (
    <PresentationScopeContext.Provider value={presentationOverlay.scope}>
      <dialog
        ref={presentationOverlay.bindRef(modalRef, '0')}
        className="fixed inset-0 z-50 m-0 h-full w-full max-h-none max-w-none border-0 p-0 items-center justify-center bg-black/50 backdrop:bg-transparent open:flex"
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-dialog-title"
        onCancel={(event) => {
          event.preventDefault();
          onCancel();
        }}
      >
        <div
          ref={dialogRef}
          className="bg-bg border border-border rounded-lg shadow-xl max-w-md w-full mx-4"
        >
          {}
          <div className="px-4 py-3 border-b border-border">
            <h2 id="close-dialog-title" className="text-sm font-medium text-fg">
              Do you want to save changes?
            </h2>
          </div>

          {}
          <div className="px-4 py-3">
            <p className="text-sm text-fg-muted">
              {allowDontSave ? (
                <>
                  Your changes to <span className="font-medium text-fg">{fileName}</span> will be
                  lost if you don{"'"}t save them.
                </>
              ) : (
                <>
                  Save the unfinished assembly working copy for{' '}
                  <span className="font-medium text-fg">{fileName}</span> before closing.
                </>
              )}
            </p>
          </div>

          {}
          <div className="px-4 py-3 border-t border-border flex items-center justify-end gap-2">
            <Button onClick={onCancel}>Cancel</Button>
            {allowDontSave && <Button onClick={onDontSave}>Don{"'"}t Save</Button>}
            <Button ref={saveRef} onClick={onSave} variant="primary">
              Save
            </Button>
          </div>
        </div>
      </dialog>
    </PresentationScopeContext.Provider>
  );
}
