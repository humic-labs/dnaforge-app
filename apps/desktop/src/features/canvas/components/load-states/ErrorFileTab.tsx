import { Button } from '../../../../components/ui';

interface ErrorFileTabProps {
  filePath?: string;
  displayName?: string;
  onClose: () => void;
  onRetry: () => void;
}

export function ErrorFileTab({ filePath, displayName, onClose, onRetry }: ErrorFileTabProps) {
  const fileName = displayName ?? filePath?.split('/').pop() ?? 'Document';

  return (
    <div
      className="h-full flex items-center justify-center p-6"
      data-testid="canvas-error-file-tab"
    >
      <div className="max-w-md w-full text-center space-y-4">
        <div className="text-4xl text-fg-muted" aria-hidden="true">
          ✕
        </div>
        <h2 className="text-base font-medium text-fg">Couldn{"'"}t read this file</h2>
        <p className="text-sm text-fg-muted break-words">
          Failed to access <span className="font-medium text-fg">{fileName}</span>. Check that you
          have permission to read it and that the disk is connected.
        </p>
        <div className="flex items-center justify-center gap-2 pt-2">
          <Button type="button" onClick={onClose} data-testid="error-file-tab-close">
            Close tab
          </Button>
          <Button
            type="button"
            onClick={onRetry}
            variant="primary"
            data-testid="error-file-tab-retry"
          >
            Retry
          </Button>
        </div>
      </div>
    </div>
  );
}
