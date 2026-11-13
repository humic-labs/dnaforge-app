import { Button } from '../../../../components/ui';

import { useEffect, useRef } from 'react';
import { formatFileSize } from '../../../../shared/oversized-guard';

interface OversizedFileDialogProps {
  fileName: string;
  sizeBytes: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export function OversizedFileDialog({
  fileName,
  sizeBytes,
  onConfirm,
  onCancel,
}: OversizedFileDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm();
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onCancel, onConfirm]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="oversized-file-dialog"
    >
      <div
        ref={dialogRef}
        className="bg-bg border border-border rounded-lg shadow-xl max-w-md w-full mx-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="oversized-file-dialog-title"
      >
        <div className="px-4 py-3 border-b border-border">
          <h2 id="oversized-file-dialog-title" className="text-sm font-medium text-fg">
            Open this large file?
          </h2>
        </div>
        <div className="px-4 py-3 space-y-2">
          <p className="text-sm text-fg-muted">
            <span className="font-medium text-fg">{fileName}</span> is{' '}
            <span className="font-medium text-fg">{formatFileSize(sizeBytes)}</span>. Loading it can
            be slow and may freeze the app while parsing.
          </p>
        </div>
        <div className="px-4 py-3 border-t border-border flex items-center justify-end gap-2">
          <Button type="button" onClick={onCancel} data-testid="oversized-file-dialog-cancel">
            Cancel
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            variant="primary"
            data-testid="oversized-file-dialog-confirm"
            autoFocus
          >
            Open anyway
          </Button>
        </div>
      </div>
    </div>
  );
}
