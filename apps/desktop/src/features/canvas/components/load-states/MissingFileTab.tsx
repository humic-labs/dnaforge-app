import { Button } from '../../../../components/ui';

interface MissingFileTabProps {
  filePath?: string;
  displayName?: string;
  onReveal?: () => void;
  onClose: () => void;
  onRetry: () => void;
}

export function MissingFileTab({
  filePath,
  displayName,
  onReveal,
  onClose,
  onRetry,
}: MissingFileTabProps) {
  const fileName = displayName ?? filePath?.split('/').pop() ?? 'Document';

  return (
    <div
      className="h-full flex items-center justify-center p-6"
      data-testid="canvas-missing-file-tab"
    >
      <div className="max-w-md w-full text-center space-y-4">
        <div className="text-4xl text-fg-muted" aria-hidden="true">
          ⊘
        </div>
        <h2 className="text-base font-medium text-fg">File not found</h2>
        <p className="text-sm text-fg-muted break-words">
          <span className="font-medium text-fg">{fileName}</span> couldn{"'"}t be opened because its
          source is no longer available.
        </p>
        {filePath && (
          <p className="text-xs text-fg-muted font-mono break-all bg-bg-muted rounded px-2 py-1">
            {filePath}
          </p>
        )}
        <div className="flex items-center justify-center gap-2 pt-2">
          <Button type="button" onClick={onClose} data-testid="missing-file-tab-close">
            Close tab
          </Button>
          {onReveal && (
            <Button type="button" onClick={onReveal} data-testid="missing-file-tab-reveal">
              Reveal in Finder
            </Button>
          )}
          <Button
            type="button"
            onClick={onRetry}
            variant="primary"
            data-testid="missing-file-tab-retry"
          >
            Retry
          </Button>
        </div>
      </div>
    </div>
  );
}
