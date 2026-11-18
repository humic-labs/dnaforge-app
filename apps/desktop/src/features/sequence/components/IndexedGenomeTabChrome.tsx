import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { GenomeAssembly } from '@waypoint/genome-data';

import { TargetIcon } from '../../../components/icons';
import type { GenomeSessionShell } from '../../../shared/indexed-genome';
import type { SearchMode } from '../hooks/useGenomeSearch';
import type { IndexedGenomeScene, IndexedGenomeSceneTrack } from './indexed-genome-scene';
import type { HostedBackgroundPreparationState } from './indexed-genome-tab-status';
import type { DataTrackRestoreIssue } from './usePersistedUcscTracks';
import { FeatureDetailsInspector } from './FeatureDetailsInspector';
import type { FeatureDetailsState } from './useIndexedFeatureDetails';
import { formatIndexedCoordinateInputEdit } from './indexed-coordinate-input';
import { GUTTER_COLLAPSED_WIDTH, GUTTER_STYLE, TrackGutterHeader } from './TrackGutter';
import { useTrackGutterLayoutStore } from './track-gutter-layout-store';

const WINDOW_SIZE_OPTIONS = [500, 2_000, 10_000, 50_000];

function formatNumber(value: number): string {
  return Math.max(0, Math.trunc(value)).toLocaleString();
}

export function IndexedGenomeTabShell({
  sessionScene,
  sessionShell,
  sessionSequenceTrack,
  sessionAnnotationTrack,
  assembly,
  assemblySourceReady,
  assemblyAnnotationsNotApplicable,
  assemblyAnnotationProductsReady,
  assemblyAnnotationSearchNotApplicable,
  assemblyAnnotationSearchReady,
  hostedBackgroundPreparation,
  eventHandlers,
  children,
}: {
  sessionScene: IndexedGenomeScene | null;
  sessionShell: GenomeSessionShell | null;
  sessionSequenceTrack: IndexedGenomeSceneTrack | undefined;
  sessionAnnotationTrack: IndexedGenomeSceneTrack | undefined;
  assembly: GenomeAssembly | undefined;
  assemblySourceReady: boolean;
  assemblyAnnotationsNotApplicable: boolean;
  assemblyAnnotationProductsReady: boolean;
  assemblyAnnotationSearchNotApplicable: boolean;
  assemblyAnnotationSearchReady: boolean;
  hostedBackgroundPreparation: HostedBackgroundPreparationState;
  eventHandlers: {
    onFocusCapture: () => void;
    onMouseDownCapture: () => void;
  };
  children: ReactNode;
}) {
  return (
    <div
      className="h-full min-h-0 flex flex-col bg-bg text-fg"
      data-testid="indexed-genome-tab"
      data-session-id={sessionScene?.sessionId ?? ''}
      data-session-open-ready={String(sessionShell?.openReady ?? false)}
      data-session-assembly-annotation-products-readiness={
        sessionShell?.assemblyAnnotationProductsReadiness ?? ''
      }
      data-session-assembly-search-readiness={sessionShell?.assemblySearchReadiness ?? ''}
      data-scene-mode={sessionScene?.mode ?? ''}
      data-coordinate-ready={String(sessionScene?.coordinateReady ?? false)}
      data-length-state={sessionScene?.lengthState ?? 'length_unknown'}
      data-validation-state={sessionScene?.validationState ?? ''}
      data-lane-epoch={sessionScene?.laneEpoch ?? ''}
      data-viewport-generation={sessionScene?.viewport?.generation ?? ''}
      data-sequence-track-state={sessionSequenceTrack?.state ?? ''}
      data-sequence-user-state={sessionSequenceTrack?.userState ?? ''}
      data-annotation-track-state={sessionAnnotationTrack?.state ?? ''}
      data-annotation-user-state={sessionAnnotationTrack?.userState ?? ''}
      data-assembly-source-readiness={assembly ? (assemblySourceReady ? 'ready' : 'pending') : ''}
      data-assembly-annotation-products-readiness={
        assembly
          ? assemblyAnnotationsNotApplicable
            ? 'not-applicable'
            : assemblyAnnotationProductsReady
              ? 'ready'
              : 'pending'
          : ''
      }
      data-assembly-search-readiness={
        assembly
          ? assemblyAnnotationSearchNotApplicable
            ? 'not-applicable'
            : assemblyAnnotationSearchReady
              ? 'ready'
              : 'pending'
          : ''
      }
      data-assembly-background-preparation={assembly ? hostedBackgroundPreparation.status : ''}
      {...eventHandlers}
    >
      {children}
    </div>
  );
}

export function IndexedGenomeTabChrome({
  tabId,
  assembly,
  fileName,
  length,
  assemblySourceReady,
  assemblyAnnotationsNotApplicable,
  assemblyAnnotationSearchReady,
  assemblyAnnotationSearchNotApplicable,
  totalAnnotationCount,
  positionInput,
  onPositionInputChange,
  onGoToPosition,
  canNavigate,
  windowSize,
  onWindowSizeChange,
  displayedViewportRange,
  displayedViewportSpan,
  sequenceSearchReady,
  searchMode,
  onOpenSearch,
  savingPortableView,
  onSavePortableView,
  dataRestoreIssues,
  featureDetailsState,
  viewActions,
}: {
  tabId: string;
  assembly: GenomeAssembly | undefined;
  fileName: string;
  length: number;
  assemblySourceReady: boolean;
  assemblyAnnotationsNotApplicable: boolean;
  assemblyAnnotationSearchReady: boolean;
  assemblyAnnotationSearchNotApplicable: boolean;
  totalAnnotationCount: number | null;
  positionInput: string;
  onPositionInputChange: (value: string) => void;
  onGoToPosition: () => void;
  canNavigate: boolean;
  windowSize: number;
  onWindowSizeChange: (value: string) => void;
  displayedViewportRange: { start: number; end: number };
  displayedViewportSpan: number;
  sequenceSearchReady: boolean;
  searchMode: SearchMode;
  onOpenSearch: (mode: SearchMode) => void;
  savingPortableView: boolean;
  onSavePortableView: () => void;
  dataRestoreIssues: readonly DataTrackRestoreIssue[];
  featureDetailsState: FeatureDetailsState;
  viewActions?: ReactNode;
}) {
  return (
    <>
      <div data-testid="indexed-genome-toolbar-surface" className="flex shrink-0 bg-bg">
        <IndexedTrackGutterHeaderCell tabId={tabId} />
        <div
          data-testid="indexed-genome-toolbar"
          className="relative flex min-w-0 flex-1 items-center gap-2 px-4 py-2"
        >
          {}
          <span
            aria-hidden
            data-testid="indexed-genome-toolbar-rule"
            className={`pointer-events-none absolute bottom-0 -left-[3px] right-0 ${GUTTER_STYLE.toolbarRule}`}
          />
          <div
            data-testid="indexed-genome-toolbar-scroll"
            className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto"
          >
            <h2 className="sr-only">{assembly?.displayName ?? fileName}</h2>
            <span data-testid="indexed-genome-identity" className="sr-only">
              {assembly?.displayName ?? fileName}
              {length > 0 ? ` ${formatNumber(length)} bp` : ''}
              {assembly && !assemblySourceReady ? ' Source pending' : ' Indexed'}
            </span>
            <span data-testid="indexed-genome-live-range" className="sr-only">
              {length > 0
                ? `${formatNumber(displayedViewportRange.start + 1)}–${formatNumber(displayedViewportRange.end)}`
                : 'Coordinates pending'}
            </span>
            {length > 0 && (
              <span data-testid="indexed-genome-live-span" className="sr-only">
                {formatNumber(displayedViewportSpan)} bp span
              </span>
            )}
            <span
              data-testid="indexed-genome-annotation-count"
              data-count-state={
                assemblyAnnotationsNotApplicable
                  ? 'not-applicable'
                  : totalAnnotationCount === null
                    ? 'pending'
                    : 'ready'
              }
              className="sr-only"
            >
              {assemblyAnnotationsNotApplicable
                ? 'No annotations'
                : totalAnnotationCount === null
                  ? 'Annotations pending'
                  : `${formatNumber(totalAnnotationCount)} annotations`}
            </span>
            <IndexedGenomeTabSearchReadiness
              assembly={assembly}
              assemblyAnnotationSearchReady={assemblyAnnotationSearchReady}
              assemblyAnnotationSearchNotApplicable={assemblyAnnotationSearchNotApplicable}
            />
            <IndexedGenomeTabToolbar
              positionInput={positionInput}
              onPositionInputChange={onPositionInputChange}
              onGoToPosition={onGoToPosition}
              canNavigate={canNavigate}
              windowSize={windowSize}
              onWindowSizeChange={onWindowSizeChange}
              sequenceSearchReady={sequenceSearchReady}
              searchMode={searchMode}
              onOpenSearch={onOpenSearch}
              assemblyAnnotationSearchReady={assemblyAnnotationSearchReady}
              assemblyAnnotationSearchNotApplicable={assemblyAnnotationSearchNotApplicable}
              savingPortableView={savingPortableView}
              onSavePortableView={viewActions ? undefined : onSavePortableView}
            />
            <FeatureDetailsInspector state={featureDetailsState} />
          </div>
          {viewActions && <div className="shrink-0">{viewActions}</div>}
        </div>
      </div>
      <IndexedGenomeTabRestoreAlerts dataRestoreIssues={dataRestoreIssues} />
    </>
  );
}

function IndexedTrackGutterHeaderCell({ tabId }: { tabId: string }) {
  const width = useTrackGutterLayoutStore((state) => state.width);
  const collapsed = useTrackGutterLayoutStore((state) => state.collapsedByTabId[tabId] ?? false);
  const toggleCollapsed = useTrackGutterLayoutStore((state) => state.toggleCollapsed);
  return (
    <div
      data-testid="indexed-genome-track-gutter-header"
      style={{ width: collapsed ? GUTTER_COLLAPSED_WIDTH : width }}
      className="shrink-0"
    >
      <TrackGutterHeader collapsed={collapsed} onToggleCollapsed={() => toggleCollapsed(tabId)} />
    </div>
  );
}

function IndexedGenomeTabSearchReadiness({
  assembly,
  assemblyAnnotationSearchReady,
  assemblyAnnotationSearchNotApplicable,
}: {
  assembly: GenomeAssembly | undefined;
  assemblyAnnotationSearchReady: boolean;
  assemblyAnnotationSearchNotApplicable: boolean;
}) {
  if (assemblyAnnotationSearchNotApplicable) {
    return (
      <span data-testid="indexed-genome-search-readiness" className="sr-only">
        Annotations not included
      </span>
    );
  }
  if (assembly && !assemblyAnnotationSearchReady) {
    return (
      <span data-testid="indexed-genome-search-readiness" className="sr-only">
        Search pending
      </span>
    );
  }
  return null;
}

function IndexedGenomeTabToolbar({
  positionInput,
  onPositionInputChange,
  onGoToPosition,
  canNavigate,
  windowSize,
  onWindowSizeChange,
  sequenceSearchReady,
  searchMode,
  onOpenSearch,
  assemblyAnnotationSearchReady,
  assemblyAnnotationSearchNotApplicable,
  savingPortableView,
  onSavePortableView,
}: {
  positionInput: string;
  onPositionInputChange: (value: string) => void;
  onGoToPosition: () => void;
  canNavigate: boolean;
  windowSize: number;
  onWindowSizeChange: (value: string) => void;
  sequenceSearchReady: boolean;
  searchMode: SearchMode;
  onOpenSearch: (mode: SearchMode) => void;
  assemblyAnnotationSearchReady: boolean;
  assemblyAnnotationSearchNotApplicable: boolean;
  savingPortableView: boolean;
  onSavePortableView?: () => void;
}) {
  const coordinateInputRef = useRef<HTMLInputElement>(null);
  const pendingCoordinateCaretRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const input = coordinateInputRef.current;
    const selectionStart = pendingCoordinateCaretRef.current;
    if (!input || selectionStart === null) return;
    pendingCoordinateCaretRef.current = null;
    if (document.activeElement === input) input.setSelectionRange(selectionStart, selectionStart);
  }, [positionInput]);

  return (
    <div
      data-testid="indexed-genome-toolbar-actions"
      className="flex min-w-0 shrink-0 items-center gap-2"
    >
      <div className="flex shrink-0 items-center">
        <input
          ref={coordinateInputRef}
          value={positionInput}
          onChange={(event) => {
            const formatted = formatIndexedCoordinateInputEdit(
              event.target.value,
              event.target.selectionStart
            );
            pendingCoordinateCaretRef.current = formatted.selectionStart;
            onPositionInputChange(formatted.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onGoToPosition();
          }}
          className="h-8 w-28 rounded-l border border-border bg-bg px-2 text-sm text-fg outline-none focus:z-10 focus:border-accent"
          disabled={!canNavigate}
          inputMode="numeric"
          maxLength={32}
          aria-label="Go to coordinate"
          placeholder="Coordinate"
          title="Assembly coordinate (numbers only)"
        />
        <button
          type="button"
          onClick={onGoToPosition}
          className="-ml-px flex h-8 w-8 items-center justify-center rounded-r border border-border text-fg-muted wp-interactive focus-visible:z-10 disabled:pointer-events-none disabled:opacity-50"
          disabled={!canNavigate}
          aria-label="Go to entered coordinate"
          title="Go to coordinate"
        >
          <TargetIcon className="h-4 w-4" />
        </button>
      </div>
      <select
        value={windowSize}
        onChange={(event) => onWindowSizeChange(event.target.value)}
        className="sr-only"
        aria-label="Window size"
        disabled={!canNavigate}
      >
        {WINDOW_SIZE_OPTIONS.map((size) => (
          <option key={size} value={size}>
            {formatNumber(size)} bp
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => onOpenSearch(assemblyAnnotationSearchReady ? searchMode : 'nucleotide')}
        className="h-8 rounded border border-border px-3 text-sm wp-interactive"
        disabled={!sequenceSearchReady}
        aria-label={
          assemblyAnnotationSearchNotApplicable
            ? 'Find DNA sequence'
            : 'Find sequence or annotations'
        }
        title={
          assemblyAnnotationSearchNotApplicable
            ? 'Find DNA sequence. This reference does not include annotations.'
            : undefined
        }
      >
        Find
      </button>
      {onSavePortableView && (
        <button
          type="button"
          onClick={onSavePortableView}
          className="h-8 rounded border border-border px-3 text-sm wp-interactive disabled:cursor-wait disabled:opacity-50"
          disabled={!canNavigate || savingPortableView}
          data-testid="portable-genome-view-save"
        >
          {savingPortableView ? 'Exporting…' : 'Export view'}
        </button>
      )}
    </div>
  );
}

function IndexedGenomeTabRestoreAlerts({
  dataRestoreIssues,
}: {
  dataRestoreIssues: readonly DataTrackRestoreIssue[];
}) {
  return (
    <>
      {dataRestoreIssues.length > 0 && (
        <div
          role="alert"
          aria-live="assertive"
          data-testid="ucsc-track-restore-error"
          className="shrink-0 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-600 dark:text-red-400"
        >
          <span className="font-medium">
            {`Couldn’t restore ${dataRestoreIssues.length} data ${
              dataRestoreIssues.length === 1 ? 'track' : 'tracks'
            }.`}
          </span>{' '}
          {dataRestoreIssues.map((issue) => `${issue.label}: ${issue.message}`).join(' ')}
        </div>
      )}
    </>
  );
}
