import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useEffect, useState } from 'react';

import { platform } from '../../../../platform';
import type {
  ExternalProviderSourceRequest,
  ExternalProviderSourceResult,
} from '../../../../shared/benchling-migration-raw-source';

export function OriginalProviderSourceDialog({
  request,
  label,
  onClose,
}: {
  request: ExternalProviderSourceRequest;
  label: string;
  onClose: () => void;
}) {
  const [result, setResult] = useState<ExternalProviderSourceResult | null>(null);

  useEffect(() => {
    let active = true;
    setResult(null);
    void platform()
      .benchlingMigration.viewExternalSource(request)
      .then((next) => {
        if (active) setResult(next);
      })
      .catch(() => {
        if (active) {
          setResult({
            status: 'source_integrity_error',
            originalPath: null,
            sourceDisplayName: null,
            message: 'The original source record could not be verified.',
          });
        }
      });
    return () => {
      active = false;
    };
  }, [request]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[10070] flex items-center justify-center bg-black/40"
      data-testid="original-provider-source-backdrop"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="original-provider-source-title"
        data-testid="original-provider-source-dialog"
        className="mx-4 flex max-h-[calc(100vh-48px)] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2
              id="original-provider-source-title"
              className="truncate text-sm font-semibold text-fg"
            >
              Original Benchling source — {label}
            </h2>
            <p className="mt-1 text-xs text-fg-muted">
              Read-only evidence from the exact ZIP selected for this migration.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close original source"
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-fg-muted hover:bg-bg-muted hover:text-fg"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {!result ? (
            <div data-testid="original-provider-source-loading" className="text-sm text-fg-muted">
              Verifying original source…
            </div>
          ) : (
            <SourceResult result={result} />
          )}
        </div>
      </section>
    </div>
  );
}

function SourceResult({ result }: { result: ExternalProviderSourceResult }) {
  const location = result.originalPath;
  return (
    <div className="space-y-3">
      {location ? (
        <div className="rounded border border-border bg-bg-subtle px-3 py-2 text-xs">
          <div className="font-medium text-fg">Original ZIP</div>
          <div className="mt-1 break-all font-mono text-fg-muted">{location}</div>
        </div>
      ) : null}

      {result.status === 'ready' ? (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
            <span className="font-medium text-fg">{result.displayFilename}</span>
            <span>{result.mediaType}</span>
            <span>{result.sizeBytes.toLocaleString()} bytes</span>
            {result.truncated ? <span className="text-warning">Preview truncated</span> : null}
          </div>
          <p data-testid="original-provider-source-note" className="text-xs text-fg-muted">
            {userMessage(result.truncated ? 'source.previewTruncated' : 'source.verified')}
          </p>
          <pre
            data-testid="original-provider-source-text"
            className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-bg-subtle p-3 font-mono text-xs text-fg"
          >
            {result.text}
          </pre>
        </>
      ) : result.status === 'unsupported' ? (
        <div
          data-testid="original-provider-source-unsupported"
          className="rounded border border-border bg-bg-subtle p-3 text-sm text-fg-muted"
        >
          <div className="font-medium text-fg">{result.displayFilename}</div>
          <p className="mt-1">{toUserMessage(result.message, 'operation.failed')}</p>
        </div>
      ) : (
        <div
          role="status"
          data-testid={`original-provider-source-${result.status}`}
          className="rounded border border-warning/40 bg-warning/10 p-3 text-sm text-fg"
        >
          <div className="font-medium">Original source unavailable</div>
          <p className="mt-1 text-fg-muted">
            {userMessage(
              result.status === 'source_changed'
                ? 'source.originalChanged'
                : result.status === 'source_integrity_error'
                  ? 'source.originalUnverified'
                  : 'source.originalUnavailable'
            )}
          </p>
          <p className="mt-2 text-xs text-fg-muted">
            The imported DNAForge record and migration history are unchanged.
          </p>
        </div>
      )}
    </div>
  );
}
