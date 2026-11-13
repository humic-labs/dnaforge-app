import { toUserMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { platform } from '../../platform';
import {
  anchorsForStep,
  protocolForPdf,
  usePaperProtocolReviewStore,
} from '../paper-protocol-review/public/store';
import {
  PdfPage,
  type PdfCitationTarget,
  type PdfPageOverlay,
  type PdfPageReport,
} from './PdfPage';
import { beginPdfLoad, type PdfLoadTask } from './runtime';
import { PdfContinuousViewport, type PdfContinuousViewportHandle } from './PdfContinuousViewport';
import './pdf.css';
import { snapshotPdfBytes } from './snapshot';
import { claimPdfRead, subscribePdfRead, type PdfReadOperation } from './telemetry';
import { usePdfSourceWatcher } from './usePdfSourceWatcher';
import { TelemetryBlockedSurface } from '../../components/TelemetryBlockedSurface';
import { COMMAND_IDS, COMMAND_SCOPES, useCommandHandler, useCommandScope } from '../../commands';
import { useCanvasStore } from '../canvas/public/store';
import { commitReadableContent, failReadableContent } from '../../lib/readable-content-telemetry';

type PdfTabProps = {
  filePath: string;
  tabId?: string;
  isActive?: boolean;
};

const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;
const SCALE_STEP = 0.2;

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(scale.toFixed(2))));
}

export function PdfTab({ filePath, tabId, isActive = true }: PdfTabProps) {
  return (
    <TelemetryBlockedSurface className="contents">
      <OwnedPdfTab key={tabId ?? filePath} filePath={filePath} tabId={tabId} isActive={isActive} />
    </TelemetryBlockedSurface>
  );
}

function OwnedPdfTab({ filePath, tabId = filePath, isActive = true }: PdfTabProps) {
  const viewportRef = useRef<HTMLElement>(null);
  const continuousRef = useRef<PdfContinuousViewportHandle>(null);
  const active = useRef(isActive);
  active.current = isActive;
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [pageAttempt, setPageAttempt] = useState(0);
  const generationId = useMemo(() => crypto.randomUUID(), [filePath, loadAttempt]);
  const [loaded, setLoaded] = useState<{
    generationId: string;
    document: PDFDocumentProxy;
    sha256: string;
  } | null>(null);
  const document = loaded?.generationId === generationId ? loaded.document : null;
  const sha256 = loaded?.generationId === generationId ? loaded.sha256 : null;
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1);
  const isFocused = useCanvasStore((state) => {
    const panel = state.focusedPanelId ? state.panels[state.focusedPanelId] : undefined;
    return panel?.activeTabId === tabId;
  });
  const ownsZoomCommands = isActive && isFocused;
  const pdfScope = useCommandScope(COMMAND_SCOPES.tabPdf, {
    claimOnMount: true,
    enabled: ownsZoomCommands,
  });
  useCommandHandler(
    COMMAND_IDS.pdfZoomIn,
    () => setScale((current) => clampScale(current + SCALE_STEP)),
    { scope: COMMAND_SCOPES.tabPdf, active: ownsZoomCommands }
  );
  useCommandHandler(
    COMMAND_IDS.pdfZoomOut,
    () => setScale((current) => clampScale(current - SCALE_STEP)),
    { scope: COMMAND_SCOPES.tabPdf, active: ownsZoomCommands }
  );
  useCommandHandler(COMMAND_IDS.pdfResetZoom, () => setScale(1), {
    scope: COMMAND_SCOPES.tabPdf,
    active: ownsZoomCommands,
  });
  const [loadError, setLoadError] = useState<{ generationId: string; message: string } | null>(
    null
  );
  const error = loadError?.generationId === generationId ? loadError.message : null;
  const [watchUnavailable, setWatchUnavailable] = useState(false);
  const [pageReports, setPageReports] = useState<ReadonlyMap<string, PdfPageReport>>(
    () => new Map()
  );
  const pageGenerations = useMemo(
    () => new Map<number, string>(),
    [generationId, scale, pageAttempt]
  );
  const generationForPage = (number: number) => {
    let id = pageGenerations.get(number);
    if (!id) {
      id = crypto.randomUUID();
      pageGenerations.set(number, id);
    }
    return id;
  };
  const pageGenerationId = generationForPage(pageNumber);
  const currentPages = useRef(pageGenerations);
  currentPages.current = pageGenerations;
  useEffect(() => setPageReports(new Map()), [pageGenerations]);
  const currentPage = useRef(pageGenerationId);
  currentPage.current = pageGenerationId;
  const currentDocument = useRef(generationId);
  currentDocument.current = generationId;
  const failedDocument = useRef<string | null>(null);
  const operation = useRef<PdfReadOperation | null>(null);
  const [citation, setCitation] = useState<{
    id: string;
    documentGenerationId: string;
    anchor: NonNullable<typeof navigationAnchor>;
  } | null>(null);
  const reportPage = useCallback((report: PdfPageReport) => {
    if (
      !Array.from(currentPages.current.values()).includes(report.generationId) ||
      failedDocument.current === currentDocument.current
    )
      return;
    if (report.phase !== 'presented')
      setPageReports((reports) => new Map(reports).set(report.generationId, report));
    if (report.phase === 'canvas_complete')
      operation.current?.emit('canvas_complete', report.generationId);
    if (report.phase === 'failed')
      operation.current?.emit('failed', report.generationId, report.failure);
    if (report.phase === 'ready') {
      operation.current?.emit(
        report.textAvailable ? 'text_ready' : 'text_unavailable',
        report.generationId
      );
    }
    if (report.phase === 'presented' && active.current) {
      operation.current?.emit('page_presented', report.generationId);
      operation.current?.emit('first_page_presented', report.generationId);
    }
  }, []);
  const pageReady = pageReports.get(pageGenerationId)?.phase === 'ready';
  const navigateToPage = useCallback((number: number) => {
    setPageNumber(number);
    continuousRef.current?.goToPage(number);
  }, []);
  const reload = useCallback(() => {
    operation.current?.emit('retry', currentDocument.current);
    setLoadAttempt((attempt) => attempt + 1);
  }, []);
  useEffect(() => subscribePdfRead(tabId, () => setLoadAttempt((attempt) => attempt + 1)), [tabId]);
  usePdfSourceWatcher(filePath, reload, () => setWatchUnavailable(true));
  const protocols = usePaperProtocolReviewStore((state) => state.protocols);
  const selectedStep = usePaperProtocolReviewStore((state) => state.selectedStep);
  const hoveredStep = usePaperProtocolReviewStore((state) => state.hoveredStep);
  const selectStep = usePaperProtocolReviewStore((state) => state.selectStep);
  const hoverStep = usePaperProtocolReviewStore((state) => state.hoverStep);

  useEffect(() => {
    const reading = claimPdfRead(tabId, loadAttempt > 0);
    operation.current = reading;
    let cancelled = false;
    let failed = false;
    let destroyed = false;
    let loadingTask: PdfLoadTask | null = null;
    const destroy = () => {
      if (destroyed || !loadingTask) return;
      destroyed = true;
      void loadingTask.destroy().catch(() => {});
    };
    const fail = () => {
      if (cancelled || failed || currentDocument.current !== generationId) return;
      failed = true;
      failedDocument.current = generationId;
      setLoaded(null);
      reading.emit('failed', generationId, 'load');
      failReadableContent(filePath);
      destroy();
      setLoadError({
        generationId,
        message:
          'This PDF could not be loaded. Your page, zoom and selected evidence are kept for retry.',
      });
    };
    const load = async () => {
      setLoaded(null);
      setLoadError(null);
      try {
        const bytes = await platform().fs.readFile(filePath);
        if (import.meta.env.MODE === 'test')
          await (await import('./pdf-test-controls')).waitPdfPhase('bytes');
        if (cancelled || failed) return;
        const snapshot = await snapshotPdfBytes(bytes);
        if (cancelled || failed) return;
        loadingTask = beginPdfLoad(snapshot.bytes);
        void loadingTask.workerFailure.then(fail);
        const nextDocument = await loadingTask.result;
        if (import.meta.env.MODE === 'test')
          await (await import('./pdf-test-controls')).waitPdfPhase('document');
        if (cancelled || failed) {
          destroy();
          return;
        }
        if (!Number.isInteger(nextDocument.numPages) || nextDocument.numPages < 1)
          throw new Error('PDF has no readable pages');
        reading.emit('parsed', generationId);
        setLoaded({ generationId, document: nextDocument, sha256: snapshot.sha256 });
        setPageNumber((current) => Math.min(nextDocument.numPages, Math.max(1, current)));
        commitReadableContent(filePath);
      } catch {
        fail();
      }
    };
    void load();
    return () => {
      cancelled = true;
      destroy();
      reading.cancel(
        generationId,
        currentDocument.current === generationId ? 'closed' : 'superseded'
      );
    };
  }, [filePath, generationId, tabId, loadAttempt]);

  useEffect(() => {
    if (!document || !sha256) return;
    usePaperProtocolReviewStore.getState().registerPdf({
      filePath,
      sha256,
      pageCount: document.numPages,
      generationId,
    });
    return () => usePaperProtocolReviewStore.getState().unregisterPdf(filePath, generationId);
  }, [document, filePath, sha256, generationId]);

  const protocol = useMemo(
    () => protocolForPdf(protocols, filePath, selectedStep?.protocolPath),
    [filePath, protocols, selectedStep?.protocolPath]
  );
  const source = protocol?.sources.find((candidate) => candidate.absolutePath === filePath) ?? null;
  const identityMatches = Boolean(
    document && source && sha256 === source.sha256 && document.numPages === source.pageCount
  );
  const selectedAnchors = identityMatches ? anchorsForStep(protocol, selectedStep, filePath) : [];
  const hoveredAnchors = identityMatches ? anchorsForStep(protocol, hoveredStep, filePath) : [];
  const navigationAnchor = hoveredAnchors[0] ?? selectedAnchors[0];

  useEffect(() => {
    if (document && source && !identityMatches)
      operation.current?.emit('identity_refused', generationId, 'source_identity');
  }, [document, source, identityMatches, generationId]);
  useEffect(() => {
    if (!navigationAnchor) {
      setCitation(null);
      return;
    }
    const id = crypto.randomUUID();
    setCitation({ id, documentGenerationId: generationId, anchor: navigationAnchor });
    operation.current?.emit('citation_requested', generationId, 'none', id);
    navigateToPage(navigationAnchor.page);
  }, [navigationAnchor, generationId, navigateToPage, pageAttempt]);
  const pendingCitation =
    citation &&
    citation.documentGenerationId === generationId &&
    identityMatches &&
    pageReady &&
    citation.anchor === navigationAnchor &&
    citation.anchor.page === pageNumber
      ? citation
      : null;
  const currentCitation = useRef(pendingCitation);
  currentCitation.current = pendingCitation;
  const citationTarget = useMemo<PdfCitationTarget | null>(
    () =>
      pendingCitation
        ? {
            requestId: pendingCitation.id,
            anchorId: pendingCitation.anchor.anchorId,
          }
        : null,
    [pendingCitation]
  );
  const reportCitation = useCallback(
    (pageGeneration: string, requestId: string, anchorId: string) => {
      const pending = currentCitation.current;
      if (
        !active.current ||
        failedDocument.current === currentDocument.current ||
        currentPage.current !== pageGeneration ||
        !pending ||
        pending.documentGenerationId !== currentDocument.current ||
        pending.id !== requestId ||
        pending.anchor.anchorId !== anchorId
      )
        return;
      currentCitation.current = null;
      operation.current?.emit('citation_arrived', pageGeneration, 'none', pending.id);
      setCitation((current) => (current?.id === requestId ? null : current));
    },
    []
  );

  const overlays = useMemo<Array<PdfPageOverlay & { page: number }>>(() => {
    if (!protocol || !source || !identityMatches) return [];
    return protocol.steps.flatMap((step) =>
      step.anchors
        .filter((anchor) => anchor.sourceId === source.sourceId)
        .map((anchor) => ({
          id: anchor.anchorId,
          page: anchor.page,
          protocolPath: protocol.protocolPath,
          stepId: step.id,
          label: `Step ${step.ordinal}: ${step.title}`,
          rects: anchor.rects,
          selected:
            selectedStep?.protocolPath === protocol.protocolPath && selectedStep.stepId === step.id,
          highlighted:
            hoveredStep?.protocolPath === protocol.protocolPath && hoveredStep.stepId === step.id,
        }))
    );
  }, [hoveredStep, identityMatches, protocol, selectedStep, source]);

  if (error) {
    return (
      <div className="grid h-full place-items-center bg-bg p-8" data-testid="pdf-tab-error">
        <div className="max-w-md text-center">
          <h2 className="text-base font-semibold text-fg">PDF unavailable</h2>
          <p className="mt-2 text-sm leading-6 text-fg-muted">
            {toUserMessage(error, 'operation.failed')}
          </p>
          <button type="button" className="mt-3 text-sm text-accent" onClick={reload}>
            Retry PDF
          </button>
        </div>
      </div>
    );
  }

  if (!document) {
    return (
      <div
        className="grid h-full place-items-center bg-bg text-sm text-fg-muted"
        data-testid="pdf-tab-loading"
      >
        Opening PDF…
      </div>
    );
  }

  const pageCount = document.numPages;
  return (
    <div
      className="flex h-full min-h-0 flex-col bg-bg-subtle"
      data-testid="pdf-tab"
      onFocusCapture={pdfScope.eventHandlers.onFocusCapture}
      onMouseDownCapture={pdfScope.eventHandlers.onMouseDownCapture}
    >
      <header className="flex h-11 shrink-0 items-center border-b border-border bg-bg px-3 text-xs text-fg">
        <div className="flex items-center gap-1" role="group" aria-label="PDF page navigation">
          <ToolbarButton
            disabled={pageNumber === 1}
            label="Previous page"
            onClick={() => navigateToPage(Math.max(1, pageNumber - 1))}
          >
            ←
          </ToolbarButton>
          <label className="ml-1 flex items-center gap-1.5 text-fg-muted">
            <span className="sr-only">Current page</span>
            <input
              aria-label="Current PDF page"
              className="h-7 w-10 border-b border-border bg-transparent text-center tabular-nums text-fg outline-none focus:border-accent"
              inputMode="numeric"
              min={1}
              max={pageCount}
              type="number"
              value={pageNumber}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isInteger(next) && next >= 1 && next <= pageCount) navigateToPage(next);
              }}
            />
            <span aria-hidden="true">/</span>
            <span className="min-w-5 tabular-nums">{pageCount}</span>
          </label>
          <ToolbarButton
            disabled={pageNumber === pageCount}
            label="Next page"
            onClick={() => navigateToPage(Math.min(pageCount, pageNumber + 1))}
          >
            →
          </ToolbarButton>
        </div>

        <div className="ml-auto flex items-center gap-1" role="group" aria-label="PDF zoom">
          <ToolbarButton
            disabled={scale <= MIN_SCALE}
            label="Zoom out"
            onClick={() => setScale((current) => clampScale(current - SCALE_STEP))}
          >
            −
          </ToolbarButton>
          <span className="w-12 text-center tabular-nums text-fg-muted">
            {Math.round(scale * 100)}%
          </span>
          <ToolbarButton
            disabled={scale >= MAX_SCALE}
            label="Zoom in"
            onClick={() => setScale((current) => clampScale(current + SCALE_STEP))}
          >
            +
          </ToolbarButton>
        </div>
      </header>

      <main
        ref={viewportRef}
        className="relative min-h-0 flex-1 overflow-auto px-8 py-6"
        data-testid="pdf-viewport"
      >
        {watchUnavailable && (
          <div role="status" className="mb-3 text-xs text-fg-muted">
            Source changes may not reload automatically.{' '}
            <button type="button" onClick={reload}>
              Reload PDF
            </button>
          </div>
        )}
        {protocol && source && !identityMatches ? (
          <div
            className="mx-auto mb-4 max-w-[760px] border-l-2 border-warning bg-warning/10 px-3 py-2 text-xs text-fg"
            data-testid="pdf-evidence-mismatch"
          >
            This PDF does not match the bytes used for the protocol evidence. Highlights are
            disabled.
          </div>
        ) : null}
        <PdfContinuousViewport
          key={generationId}
          ref={continuousRef}
          pageCount={pageCount}
          scale={scale}
          initialPage={pageNumber}
          viewportRef={viewportRef}
          onPageChange={setPageNumber}
          renderPage={(number, onSize) => {
            const id = generationForPage(number);
            return (
              <PdfPage
                key={id}
                document={document}
                generationId={id}
                isActive={isActive}
                viewportRef={viewportRef}
                citationTarget={number === pageNumber ? citationTarget : null}
                onCitationPresented={reportCitation}
                onReport={reportPage}
                onSize={onSize}
                onRetry={() => {
                  operation.current?.emit('retry', id);
                  setPageAttempt((attempt) => attempt + 1);
                }}
                onReload={reload}
                overlays={
                  pageReports.get(id)?.phase === 'ready'
                    ? overlays.filter((overlay) => overlay.page === number)
                    : []
                }
                pageNumber={number}
                scale={scale}
                onHoverStep={(protocolPath, stepId, hovered) =>
                  hoverStep(hovered ? { protocolPath, stepId } : null)
                }
                onSelectStep={(protocolPath, stepId) => selectStep({ protocolPath, stepId })}
              />
            );
          }}
        />
      </main>
    </div>
  );
}

function ToolbarButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: string;
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="grid h-8 w-8 place-items-center text-base text-fg-muted hover:bg-bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}
