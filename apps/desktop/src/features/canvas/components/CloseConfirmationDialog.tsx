import {
  usePresentationOverlay,
  PresentationScopeContext,
  usePresentationListener,
} from '../../../presentation/PresentationSurface';
import { Button } from '../../../components/ui';

import { useEffect, useRef } from 'react';

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

  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onSave();
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
  }, [onCancel, onSave, presentationEvents]);

  return (
    <div
      ref={presentationOverlay.bindRef(undefined, '0')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    >
      <PresentationScopeContext.Provider value={presentationOverlay.scope}>
        <div
          ref={dialogRef}
          className="bg-bg border border-border rounded-lg shadow-xl max-w-md w-full mx-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="close-dialog-title"
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
            <Button onClick={onSave} variant="primary">
              Save
            </Button>
          </div>
        </div>
      </PresentationScopeContext.Provider>
    </div>
  );
}
