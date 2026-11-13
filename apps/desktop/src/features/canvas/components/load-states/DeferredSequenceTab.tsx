import { Button } from '../../../../components/ui';

import { formatFileSize } from '../../../../shared/oversized-guard';

interface DeferredSequenceTabProps {
  documentLabel: string;
  fileSizeBytes?: number;
  onLoadRequest: () => void;
  onClose: () => void;
}

export function DeferredSequenceTab({
  documentLabel,
  fileSizeBytes,
  onLoadRequest,
  onClose,
}: DeferredSequenceTabProps) {
  const sizeLabel =
    typeof fileSizeBytes === 'number' ? formatFileSize(fileSizeBytes) : 'large file';

  return (
    <div
      className="h-full flex items-center justify-center p-6"
      data-testid="canvas-deferred-sequence-tab"
    >
      <div className="max-w-md w-full text-center space-y-4">
        <div className="text-4xl text-fg-muted" aria-hidden="true">
          ⚠
        </div>
        <h2 className="text-base font-medium text-fg">Large file not auto-loaded</h2>
        <p className="text-sm text-fg-muted break-words">
          <span className="font-medium text-fg">{documentLabel}</span> is {sizeLabel}. Loading it
          can be slow and may freeze the app while parsing. The file was kept in this tab from a
          previous session, but not opened.
        </p>
        <div className="flex items-center justify-center gap-2 pt-2">
          <Button type="button" onClick={onClose} data-testid="deferred-sequence-tab-close">
            Close tab
          </Button>
          <Button
            type="button"
            onClick={onLoadRequest}
            variant="primary"
            data-testid="deferred-sequence-tab-load"
          >
            Load anyway
          </Button>
        </div>
      </div>
    </div>
  );
}
