import { usePresentationListener } from '../../../presentation/PresentationSurface';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import {
  notebookPackagePaths,
  parseNotebookPackageDocument,
  parseNotebookPackageMetadata,
} from '../../../db/notebook-package';
import { getCurrentCatalogFileForEntity } from '../../../db/workspace-catalog';
import { platform } from '../../../platform';
import {
  extractBenchlingNotebookSourceDetails,
  MAX_BENCHLING_NOTEBOOK_PROVENANCE_BYTES,
  parseBenchlingNotebookProvenanceSidecar,
  safeBenchlingSourceUrl,
  type BenchlingNotebookSourceDetails,
  type ParsedBenchlingNotebookProvenanceSidecar,
} from '../../../shared/benchling-notebook-source';
import { isManagedBenchlingImportPath } from '../../../shared/benchling-import-display-name';
import { stripWorkspaceScope } from '../../../shared/workspace-scoped-identity';
import { NotebookTabIcon, OpenExternalIcon, XIcon } from '../../../components/icons';
import { scheduleFocus } from '../../../shared/utils/safeFocus';

const MAX_BENCHLING_NOTEBOOK_SIDECAR_CANDIDATES = 512;
const SIDECAR_READ_CONCURRENCY = 8;

interface NotebookSourceReader {
  getBinding(pageId: string): Promise<{ path: string; file_kind: string } | null>;
  readDir(path: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
  readTextFile(path: string): Promise<string>;
  readTextFileSlice(path: string, maxBytes: number): Promise<{ text: string; bytesRead: number }>;
}

const defaultReader: NotebookSourceReader = {
  getBinding: getCurrentCatalogFileForEntity,
  readDir: (path) => platform().fs.readDir(path),
  readTextFile: (path) => platform().fs.readTextFile(path),
  readTextFileSlice: (path, maxBytes) => platform().fs.readTextFileSlice(path, maxBytes),
};

function pathParts(path: string): { parent: string; name: string; separator: '/' | '\\' } {
  const separator = path.includes('\\') && !path.includes('/') ? '\\' : '/';
  const normalized = path.endsWith(separator) ? path.slice(0, -1) : path;
  const boundary = normalized.lastIndexOf(separator);
  return {
    parent: boundary < 0 ? '' : normalized.slice(0, boundary),
    name: boundary < 0 ? normalized : normalized.slice(boundary + 1),
    separator,
  };
}

function notebookSidecarContainer(bindingPath: string): string {
  const binding = pathParts(bindingPath);
  if (bindingPath.toLowerCase().endsWith('.wpnote.json')) {
    return binding.parent;
  }
  return bindingPath;
}

async function readManagedBenchlingSidecars(
  containerPath: string,
  reader: NotebookSourceReader
): Promise<ParsedBenchlingNotebookProvenanceSidecar[]> {
  const { separator } = pathParts(containerPath);
  const candidates = (await reader.readDir(containerPath)).filter(
    (entry) => !entry.isDirectory && entry.name.toLowerCase().endsWith('.benchling-provenance.json')
  );
  if (candidates.length > MAX_BENCHLING_NOTEBOOK_SIDECAR_CANDIDATES) return [];

  const parsed: ParsedBenchlingNotebookProvenanceSidecar[] = [];
  for (let offset = 0; offset < candidates.length; offset += SIDECAR_READ_CONCURRENCY) {
    const batch = await Promise.all(
      candidates.slice(offset, offset + SIDECAR_READ_CONCURRENCY).map(async (candidate) => {
        try {
          const prefix = await reader.readTextFileSlice(
            `${containerPath}${separator}${candidate.name}`,
            MAX_BENCHLING_NOTEBOOK_PROVENANCE_BYTES + 1
          );
          return parseBenchlingNotebookProvenanceSidecar(prefix.text, prefix.bytesRead);
        } catch {
          return null;
        }
      })
    );
    parsed.push(...batch.filter((candidate) => candidate !== null));
  }
  return parsed;
}

export async function readNotebookSourceDetails(
  pageId: string,
  reader: NotebookSourceReader = defaultReader
): Promise<BenchlingNotebookSourceDetails | null> {
  const binding = await reader.getBinding(pageId);
  if (!binding || binding.file_kind !== 'waypoint-notebook') return null;
  if (!isManagedBenchlingImportPath(binding.path)) return null;
  const sidecars = await readManagedBenchlingSidecars(
    notebookSidecarContainer(binding.path),
    reader
  );
  if (sidecars.length === 0) return null;
  const rawPageId = stripWorkspaceScope(pageId);
  const currentMatches = sidecars.filter(
    (sidecar) =>
      sidecar.hasEntryMetadataSnapshot &&
      sidecar.destinationObjectId !== undefined &&
      stripWorkspaceScope(sidecar.destinationObjectId) === rawPageId
  );
  if (currentMatches.length === 1) return currentMatches[0].details;
  if (currentMatches.length > 1) return null;

  const legacyCandidates = sidecars.filter(
    (sidecar) =>
      sidecar.destinationObjectId === undefined ||
      stripWorkspaceScope(sidecar.destinationObjectId) === rawPageId
  );
  if (legacyCandidates.length === 0) return null;
  const metadataPath = binding.path.toLowerCase().endsWith('.wpnote.json')
    ? binding.path
    : notebookPackagePaths(binding.path).metaPath;
  try {
    const rawMetadata = await reader.readTextFile(metadataPath);
    const parsedMetadata = JSON.parse(rawMetadata) as { formatVersion?: unknown };
    const document =
      parsedMetadata.formatVersion === undefined
        ? parseNotebookPackageDocument(rawMetadata)
        : parseNotebookPackageMetadata(rawMetadata);
    if (stripWorkspaceScope(document.id) !== rawPageId) return null;
    const packageDetails = extractBenchlingNotebookSourceDetails(document);
    if (!packageDetails) return null;
    const matchingLegacySidecars = legacyCandidates.filter((sidecar) => {
      if (sidecar.destinationObjectId !== undefined) {
        return stripWorkspaceScope(sidecar.destinationObjectId) === rawPageId;
      }
      return Boolean(
        (sidecar.details.stableSourceId &&
          packageDetails.stableSourceId === sidecar.details.stableSourceId) ||
        (sidecar.details.sourceObjectId &&
          packageDetails.sourceObjectId === sidecar.details.sourceObjectId)
      );
    });
    if (matchingLegacySidecars.length !== 1) return null;
    const sidecarDetails = matchingLegacySidecars[0].details;
    return {
      ...sidecarDetails,
      project: packageDetails.project ?? sidecarDetails.project,
      author: packageDetails.author ?? sidecarDetails.author,
      status: packageDetails.status ?? sidecarDetails.status,
      entryCreatedAt: packageDetails.entryCreatedAt ?? sidecarDetails.entryCreatedAt,
      entryModifiedAt: packageDetails.entryModifiedAt ?? sidecarDetails.entryModifiedAt,
      exportGeneratedAt: packageDetails.exportGeneratedAt ?? sidecarDetails.exportGeneratedAt,
    };
  } catch {
    return null;
  }
}

export function useNotebookSourceDetails(pageId: string): BenchlingNotebookSourceDetails | null {
  const [details, setDetails] = useState<BenchlingNotebookSourceDetails | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    void readNotebookSourceDetails(pageId)
      .then((next) => {
        if (!cancelled) setDetails(next);
      })
      .catch((error) => {
        console.warn('[NotebookSourceDetails] Could not read notebook source details:', error);
        if (!cancelled) setDetails(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  return details;
}

function formatTimestamp(value: string | undefined): string | null {
  if (!value) return null;
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp);
}

function DetailRow({
  label,
  value,
  exact,
}: {
  label: string;
  value?: string | null;
  exact?: string;
}) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 py-1.5">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="min-w-0 break-words font-medium text-fg" title={exact}>
        {value}
      </dd>
    </div>
  );
}

export function NotebookSourceDetailsControl({
  details,
}: {
  details: BenchlingNotebookSourceDetails | null;
}) {
  const presentationEvents = usePresentationListener();

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) scheduleFocus(triggerRef.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const cancelFocus = scheduleFocus(closeRef.current);
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        containerRef.current &&
        !containerRef.current.contains(event.target)
      ) {
        close(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(true);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    presentationEvents.add(window, 'keydown', closeOnEscape);
    return () => {
      cancelFocus();
      document.removeEventListener('mousedown', closeOnOutsideClick);
      presentationEvents.remove(window, 'keydown', closeOnEscape);
    };
  }, [close, open, presentationEvents]);

  if (!details) return null;

  const sourceUrl = safeBenchlingSourceUrl(details.sourceUrl);
  const recordId = details.stableSourceId ?? details.sourceObjectId;
  const created = formatTimestamp(details.entryCreatedAt);
  const modified = formatTimestamp(details.entryModifiedAt);
  const exported = formatTimestamp(details.exportGeneratedAt);
  const captured = formatTimestamp(details.capturedAt);

  return (
    <div ref={containerRef} className="relative ml-auto flex-shrink-0">
      <button
        ref={triggerRef}
        type="button"
        data-testid="notebook-source-details-trigger"
        aria-expanded={open}
        aria-controls={open ? `${titleId}-popover` : undefined}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border bg-bg-subtle px-2 text-[11px] font-medium text-fg-muted transition-colors wp-interactive "
      >
        <NotebookTabIcon className="h-3.5 w-3.5" />
        Imported from Benchling
      </button>

      {open ? (
        <section
          id={`${titleId}-popover`}
          data-testid="notebook-source-details-popover"
          role="dialog"
          aria-labelledby={titleId}
          className="absolute right-0 top-[calc(100%+0.4rem)] z-[10002] w-[380px] overflow-hidden rounded-lg border border-border bg-bg shadow-xl"
        >
          <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <h2 id={titleId} className="text-sm font-semibold text-fg">
                Source details
              </h2>
              <p className="mt-0.5 text-[11px] text-fg-subtle">Benchling notebook entry</p>
            </div>
            <button
              ref={closeRef}
              type="button"
              aria-label="Close source details"
              onClick={() => close(true)}
              className="rounded p-1 text-fg-muted wp-interactive "
            >
              <XIcon size={13} />
            </button>
          </header>

          <div className="max-h-[min(520px,70vh)] overflow-auto px-4 py-3 text-xs">
            <dl className="divide-y divide-border/60">
              <DetailRow label="Project" value={details.project} />
              <DetailRow label="Author" value={details.author} />
              <DetailRow label="Status" value={details.status} />
              <DetailRow label="Created" value={created} exact={details.entryCreatedAt} />
              <DetailRow label="Last modified" value={modified} exact={details.entryModifiedAt} />
              <DetailRow label="Exported" value={exported} exact={details.exportGeneratedAt} />
            </dl>

            <div className="mt-3 border-t border-border pt-3">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">
                Source evidence
              </div>
              <dl className="divide-y divide-border/60">
                <DetailRow label="Record ID" value={recordId} />
                <DetailRow label="Captured" value={captured} exact={details.capturedAt} />
              </dl>

              {details.immutableSource ? (
                <div
                  data-testid="notebook-immutable-source-evidence"
                  className="mt-2 rounded-md border border-accent/20 bg-accent/5 px-3 py-2"
                >
                  <div className="flex items-center gap-2 font-medium text-fg">
                    <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
                    Immutable source record
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-fg-subtle">
                    Stable provider identity is preserved with this notebook package.
                  </p>
                </div>
              ) : null}

              {sourceUrl ? (
                <a
                  href={sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex items-center gap-1.5 rounded text-xs font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  Open original in Benchling
                  <OpenExternalIcon size={12} />
                </a>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
