import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { Button } from '../../components/ui';
import { useCallback, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { SpinnerIcon } from '../../components/icons/glyphs';
import { platform } from '../../platform';
import { BenchlingExportTutorial } from './BenchlingExportTutorial';

export function LocalExportIntakeStep({
  pendingState,
  onChooseExport,
  onDropExport,
}: {
  pendingState: 'loading' | 'opening_picker' | 'reading_export' | null;
  onChooseExport(): Promise<unknown>;
  onDropExport(sourcePath: string): Promise<unknown>;
}) {
  const [dragActive, setDragActive] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const dragDepth = useRef(0);

  const resetDrag = useCallback(() => {
    dragDepth.current = 0;
    setDragActive(false);
  }, []);

  const onDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  }, []);

  const onDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  }, []);

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      resetDrag();
      if (pendingState) return;
      setDropError(null);
      const [file] = Array.from(event.dataTransfer.files);
      if (!file) {
        setDropError(
          userMessage('failure.that-drop-carried-no-file-or-folder-try-the-button-below')
        );
        return;
      }
      const sourcePath = platform().workspace.getPathForFile(file);
      if (!sourcePath) {
        setDropError(
          userMessage('failure.could-not-read-that-item-s-location-use-the-button-below-instead')
        );
        return;
      }
      void onDropExport(sourcePath).catch((cause: unknown) => {
        setDropError(toUserMessage(cause, 'failure.could-not-read-that-export'));
      });
    },
    [onDropExport, resetDrag, pendingState]
  );

  return (
    <div className="space-y-3" data-testid="benchling-migration-local-export-intake">
      <div
        data-testid="benchling-migration-export-dropzone"
        data-drag-active={dragActive ? 'true' : 'false'}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={`flex min-h-56 flex-col items-center justify-center gap-4 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragActive ? 'border-accent bg-accent/5' : 'border-border bg-bg-muted/30'
        }`}
      >
        <p className="max-w-sm text-sm text-fg">Drop your Benchling export here</p>
        <Button
          type="button"
          disabled={pendingState !== null}
          data-testid="benchling-migration-choose-export"
          onClick={() => void onChooseExport()}
          variant="primary"
        >
          Choose file or folder…
        </Button>
        <span role="status" className="flex h-5 items-center gap-2 text-xs text-fg-muted">
          {pendingState ? (
            <>
              <SpinnerIcon className="h-4 w-4" />
              {pendingState === 'loading'
                ? 'Getting ready…'
                : pendingState === 'opening_picker'
                  ? 'Opening file picker…'
                  : 'Reading your export'}
            </>
          ) : null}
        </span>
      </div>

      <BenchlingExportTutorial align="center" presentation="intake" />

      {dropError ? (
        <p role="alert" data-testid="benchling-migration-drop-error" className="text-xs text-error">
          {toUserMessage(dropError, 'operation.failed')}
        </p>
      ) : null}
    </div>
  );
}
