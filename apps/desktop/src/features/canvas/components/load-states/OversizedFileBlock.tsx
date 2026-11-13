import { Button } from '../../../../components/ui';

import { useEffect, useRef } from 'react';
import { formatFileSize } from '../../../../shared/oversized-guard';

interface OversizedFileBlockProps {
  fileName: string;
  sizeBytes: number;
  onDismiss: () => void;
}

export function OversizedFileBlock({ fileName, sizeBytes, onDismiss }: OversizedFileBlockProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        onDismiss();
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onDismiss();
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
  }, [onDismiss]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="oversized-file-block"
    >
      <div
        ref={dialogRef}
        className="bg-bg border border-border rounded-lg shadow-xl max-w-md w-full mx-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="oversized-file-block-title"
      >
        <div className="px-4 py-3 border-b border-border">
          <h2 id="oversized-file-block-title" className="text-sm font-medium text-fg">
            File too large to open
          </h2>
        </div>
        <div className="px-4 py-3 space-y-2">
          <p className="text-sm text-fg-muted">
            <span className="font-medium text-fg">{fileName}</span> is{' '}
            <span className="font-medium text-fg">{formatFileSize(sizeBytes)}</span>. Streaming load
            for files over 256&nbsp;MB isn{"'"}t supported yet.
          </p>
        </div>
        <div className="px-4 py-3 border-t border-border flex items-center justify-end gap-2">
          <Button
            type="button"
            onClick={onDismiss}
            variant="primary"
            data-testid="oversized-file-block-dismiss"
            autoFocus
          >
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}
