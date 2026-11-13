'use client';
import { toUserMessage } from '@waypoint/user-messages';
import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import type { Annotation as ExistingAnnotation } from '@waypoint/sequence-utils';
import { safeFocus } from '../../../shared/utils/safeFocus';
import type { DraftAnnotation, DbSource } from '../types';
import { CONFIDENCE_THRESHOLDS } from '../types';
import { formatPosition } from './format-position';

type SortColumn =
  | 'name'
  | 'type'
  | 'position'
  | 'identity'
  | 'coverage'
  | 'confidence'
  | 'duplicate';
type SortDirection = 'asc' | 'desc';

const REVIEW_GRID =
  '24px 20px minmax(60px, 200px) minmax(40px, 100px) minmax(50px, 1fr) 48px 32px minmax(32px, 0.3fr) 24px';

const BAR_WIDTH_PX = 3;
const STROKE_WIDTH_PX = 1;

const FEATURE_COLOR_MAP: Record<string, string> = {
  CDS: '#3b82f6',
  gene: '#22c55e',
  promoter: '#f97316',
  terminator: '#ef4444',
  rep_origin: '#a855f7',
  misc_feature: '#06b6d4',
  primer_bind: '#ec4899',
  regulatory: '#eab308',
  protein_bind: '#14b8a6',
};
const DEFAULT_FEATURE_COLOR = '#8b5cf6';
const EXISTING_BAR_COLOR = '#9ca3af';

function getFeatureColor(type: string | undefined): string {
  return FEATURE_COLOR_MAP[type || ''] || DEFAULT_FEATURE_COLOR;
}

function LeftEdgeBar({ kind, color }: { kind: 'hollow' | 'solid' | 'gray'; color?: string }) {
  if (kind === 'hollow') {
    return (
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: `${STROKE_WIDTH_PX}px`,
          background: color ?? DEFAULT_FEATURE_COLOR,
        }}
      />
    );
  }
  const fill = kind === 'gray' ? EXISTING_BAR_COLOR : (color ?? DEFAULT_FEATURE_COLOR);
  return (
    <span
      aria-hidden="true"
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        width: `${BAR_WIDTH_PX}px`,
        background: fill,
      }}
    />
  );
}

function getDbSourceLabel(dbSource: DbSource): string {
  switch (dbSource) {
    case 'protein':
      return 'AA';
    case 'nucleotide':
      return 'nt';
    case 'rna':
      return 'RNA';
    default:
      return '';
  }
}

function getFragmentLabel(draft: DraftAnnotation): string | null {
  if (draft.coverage >= 95) return null;
  if (!draft.ref_length || draft.ref_length <= 0) return null;

  const unit = draft.db_source === 'protein' ? 'aa' : 'bp';
  return `${unit} ${draft.ref_start}-${draft.ref_end} of ${draft.ref_length}`;
}

function getConfidenceColor(confidence: number): string {
  if (confidence >= CONFIDENCE_THRESHOLDS.HIGH) return 'text-green-500 dark:text-green-400';
  if (confidence >= CONFIDENCE_THRESHOLDS.MEDIUM) return 'text-yellow-500 dark:text-yellow-400';
  return 'text-red-500 dark:text-red-400';
}

function getConfidenceLabel(confidence: number): string {
  if (confidence >= CONFIDENCE_THRESHOLDS.HIGH) return 'High';
  if (confidence >= CONFIDENCE_THRESHOLDS.MEDIUM) return 'Med';
  return 'Low';
}

function getPercentColor(value: number): string {
  if (value >= 95) return 'text-green-500 dark:text-green-400';
  if (value >= 80) return 'text-yellow-500 dark:text-yellow-400';
  return 'text-red-500 dark:text-red-400';
}

function DirectionIndicator({ direction, color }: { direction: number; color?: string }) {
  const c = color || '#718096';
  if (direction === 1) {
    return (
      <svg width="12" height="8" viewBox="0 0 12 8" className="flex-shrink-0">
        <line x1="0" y1="4" x2="9" y2="4" stroke={c} strokeWidth="2" strokeLinecap="round" />
        <polyline
          points="7,1 10,4 7,7"
          fill="none"
          stroke={c}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (direction === -1) {
    return (
      <svg width="12" height="8" viewBox="0 0 12 8" className="flex-shrink-0">
        <line x1="3" y1="4" x2="12" y2="4" stroke={c} strokeWidth="2" strokeLinecap="round" />
        <polyline
          points="5,1 2,4 5,7"
          fill="none"
          stroke={c}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg width="12" height="8" viewBox="0 0 12 8" className="flex-shrink-0">
      <rect x="0" y="2.5" width="12" height="3" rx="1.5" fill={c} />
    </svg>
  );
}

interface AnnotationReviewPanelProps {
  drafts: DraftAnnotation[];
  existingAnnotations?: ExistingAnnotation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggleAccepted: (id: string) => void;
  onAcceptRange: (ids: string[]) => void;
  onSetRangeAccepted: (ids: string[], accepted: boolean) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onCommit: () => void;
  commitBlockedReason?: string;
  coordinateProvenance?: {
    coordinates: 'exact' | 'mapped';
    transitionCount: number;
  };
  onRefreshReview?: () => void;
  onRerunReview?: () => void;
  isApplying?: boolean;
  onCancel: () => void;
}

export function AnnotationReviewPanel({
  drafts,
  existingAnnotations,
  selectedId,
  onSelect,
  onToggleAccepted,
  onSetRangeAccepted,
  onAcceptAll,
  onRejectAll,
  onCommit,
  commitBlockedReason,
  coordinateProvenance,
  onRefreshReview,
  onRerunReview,
  isApplying = false,
  onCancel,
}: AnnotationReviewPanelProps) {
  const [sortColumn, setSortColumn] = useState<SortColumn>('position');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());

  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const lastClickedIdRef = useRef<string | null>(null);

  const visibleDrafts = useMemo(() => {
    return [...drafts].sort((a, b) => {
      let cmp = 0;
      switch (sortColumn) {
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'type':
          cmp = (a.type || '').localeCompare(b.type || '');
          break;
        case 'position':
          cmp = a.start - b.start;
          break;
        case 'identity':
          cmp = a.identity - b.identity;
          break;
        case 'coverage':
          cmp = a.coverage - b.coverage;
          break;
        case 'confidence':
          cmp = a.confidence - b.confidence;
          break;
        case 'duplicate':
          cmp = (a.duplicateStatus.isDuplicate ? 1 : 0) - (b.duplicateStatus.isDuplicate ? 1 : 0);
          break;
      }
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  }, [drafts, sortColumn, sortDirection]);

  const selectedVisibleIndex = useMemo(() => {
    if (!selectedId) return -1;
    return visibleDrafts.findIndex((d) => d.id === selectedId);
  }, [selectedId, visibleDrafts]);

  const navigateNext = useCallback(() => {
    if (visibleDrafts.length === 0) return;
    const nextIndex =
      selectedVisibleIndex < 0 ? 0 : (selectedVisibleIndex + 1) % visibleDrafts.length;
    onSelect(visibleDrafts[nextIndex].id);
    setMultiSelectedIds(new Set());
  }, [visibleDrafts, selectedVisibleIndex, onSelect]);

  const navigatePrevious = useCallback(() => {
    if (visibleDrafts.length === 0) return;
    const prevIndex =
      selectedVisibleIndex <= 0 ? visibleDrafts.length - 1 : selectedVisibleIndex - 1;
    onSelect(visibleDrafts[prevIndex].id);
    setMultiSelectedIds(new Set());
  }, [visibleDrafts, selectedVisibleIndex, onSelect]);

  useEffect(() => {
    if (selectedId) {
      const row = rowRefs.current.get(selectedId);
      if (row?.scrollIntoView) {
        row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }, [selectedId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        !containerRef.current?.contains(document.activeElement) &&
        document.activeElement !== containerRef.current
      ) {
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
        case 'j':
          e.preventDefault();
          navigateNext();
          break;
        case 'ArrowUp':
        case 'k':
          e.preventDefault();
          navigatePrevious();
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (selectedId) {
            if (multiSelectedIds.size > 0 && multiSelectedIds.has(selectedId)) {
              const current = drafts.find((d) => d.id === selectedId);
              const newAccepted = !(current?.accepted ?? false);
              onSetRangeAccepted([...multiSelectedIds], newAccepted);
            } else {
              onToggleAccepted(selectedId);
            }
          }
          break;
        case 'Escape':
          setMultiSelectedIds(new Set());
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [
    navigateNext,
    navigatePrevious,
    selectedId,
    onToggleAccepted,
    multiSelectedIds,
    drafts,
    onSetRangeAccepted,
  ]);

  useEffect(() => {
    safeFocus(containerRef.current);
  }, []);

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const handleRowClick = useCallback(
    (draft: DraftAnnotation, e: React.MouseEvent) => {
      if (e.shiftKey && lastClickedIdRef.current) {
        e.preventDefault();
        const lastIndex = visibleDrafts.findIndex((d) => d.id === lastClickedIdRef.current);
        const currentIndex = visibleDrafts.findIndex((d) => d.id === draft.id);
        if (lastIndex !== -1 && currentIndex !== -1) {
          const start = Math.min(lastIndex, currentIndex);
          const end = Math.max(lastIndex, currentIndex);
          const ids = visibleDrafts.slice(start, end + 1).map((d) => d.id);
          setMultiSelectedIds(new Set(ids));
        }
      } else if (e.metaKey || e.ctrlKey) {
        setMultiSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(draft.id)) {
            next.delete(draft.id);
          } else {
            next.add(draft.id);
          }
          return next;
        });
      } else {
        lastClickedIdRef.current = draft.id;
        setMultiSelectedIds(new Set());
      }
      onSelect(draft.id);
    },
    [visibleDrafts, onSelect]
  );

  const handleCheckboxToggle = useCallback(
    (draftId: string) => {
      if (multiSelectedIds.size > 0 && multiSelectedIds.has(draftId)) {
        const current = drafts.find((d) => d.id === draftId);
        const newAccepted = !(current?.accepted ?? false);
        onSetRangeAccepted([...multiSelectedIds], newAccepted);
      } else {
        onToggleAccepted(draftId);
      }
    },
    [multiSelectedIds, drafts, onSetRangeAccepted, onToggleAccepted]
  );

  const SortIndicator = ({ column }: { column: SortColumn }) => {
    if (sortColumn !== column) return <span className="opacity-30 ml-1">↕</span>;
    return <span className="ml-1">{sortDirection === 'asc' ? '↑' : '↓'}</span>;
  };

  const acceptedCount = drafts.filter((d) => d.accepted).length;
  const allAccepted = acceptedCount === drafts.length;
  const noneAccepted = acceptedCount === 0;

  const handleHeaderCheckbox = () => {
    if (allAccepted) {
      onRejectAll();
    } else {
      onAcceptAll();
    }
  };

  if (drafts.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-fg-muted">
        No annotations found
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className="h-full flex flex-col overflow-hidden outline-none select-none"
    >
      {}
      <div className="px-1 py-1 text-[10px] uppercase tracking-wider text-fg-subtle bg-bg-subtle border-b border-border">
        Review annotations
      </div>

      {coordinateProvenance && (
        <div
          data-testid="annotation-review-coordinate-provenance"
          className="px-3 py-2 text-xs text-fg-muted border-b border-border bg-bg-subtle"
        >
          {coordinateProvenance.coordinates === 'exact' ? (
            <p>Coordinates exactly match the analyzed saved sequence.</p>
          ) : (
            <>
              <p>
                Coordinates were moved through {coordinateProvenance.transitionCount} verified saved{' '}
                {coordinateProvenance.transitionCount === 1 ? 'edit' : 'edits'}.
              </p>
              <p>Identity and coverage scores were not recalculated.</p>
            </>
          )}
        </div>
      )}

      {}
      <div
        className="grid items-center py-1 pr-1 bg-bg-subtle border-b border-border text-xs text-fg-muted select-none flex-shrink-0"
        style={{
          gridTemplateColumns: REVIEW_GRID,
          paddingLeft: `${BAR_WIDTH_PX}px`,
        }}
      >
        <span className="text-center">
          <input
            type="checkbox"
            checked={allAccepted}
            ref={(el) => {
              if (el) el.indeterminate = !allAccepted && !noneAccepted;
            }}
            onChange={handleHeaderCheckbox}
            className="rounded border-border"
            title={allAccepted ? 'Deselect all' : 'Select all'}
          />
        </span>
        <span />
        <button
          className="text-left px-1 py-0.5 rounded hover:bg-bg-muted font-medium cursor-pointer truncate"
          onClick={() => handleSort('name')}
        >
          Name
          <SortIndicator column="name" />
        </button>
        <button
          className="text-left px-1 py-0.5 rounded hover:bg-bg-muted font-medium cursor-pointer truncate"
          onClick={() => handleSort('type')}
        >
          Type
          <SortIndicator column="type" />
        </button>
        <button
          className="text-left px-1 py-0.5 rounded hover:bg-bg-muted font-medium cursor-pointer"
          onClick={() => handleSort('position')}
        >
          Pos
          <SortIndicator column="position" />
        </button>
        <button
          className="text-left px-1 py-0.5 rounded hover:bg-bg-muted font-medium cursor-pointer"
          onClick={() => handleSort('identity')}
          title="Sequence identity"
        >
          Id%
          <SortIndicator column="identity" />
        </button>
        <button
          className="text-left px-1 py-0.5 rounded hover:bg-bg-muted font-medium cursor-pointer"
          onClick={() => handleSort('coverage')}
          title="Coverage of reference feature"
        >
          Cv%
          <SortIndicator column="coverage" />
        </button>
        <button
          className="text-center px-1 py-0.5 rounded hover:bg-bg-muted font-medium cursor-pointer"
          onClick={() => handleSort('confidence')}
          title="Confidence (identity × coverage)"
        >
          Cf
          <SortIndicator column="confidence" />
        </button>
        <button
          className="text-center px-0.5 py-0.5 rounded hover:bg-bg-muted font-medium cursor-pointer"
          onClick={() => handleSort('duplicate')}
          title="New annotation (not already on sequence)"
        >
          ★
          <SortIndicator column="duplicate" />
        </button>
      </div>

      {}
      <div className="flex-1 overflow-y-auto overflow-x-hidden overscroll-none">
        {visibleDrafts.map((draft) => {
          const isSelected = draft.id === selectedId;
          const isMultiSelected = multiSelectedIds.has(draft.id);

          return (
            <div
              key={draft.id}
              ref={(el) => {
                if (el) rowRefs.current.set(draft.id, el);
                else rowRefs.current.delete(draft.id);
              }}
              role="row"
              data-selected={isSelected}
              onClick={(e) => handleRowClick(draft, e)}
              className={`relative grid items-center pr-1 text-xs cursor-pointer scroll-mt-10 ${
                isMultiSelected || isSelected ? 'bg-green-500/15' : 'hover:bg-bg-subtle'
              }`}
              style={{
                gridTemplateColumns: REVIEW_GRID,
                paddingLeft: `${BAR_WIDTH_PX}px`,
                margin: 0,
                border: 0,
                minHeight: '22px',
              }}
            >
              <LeftEdgeBar
                kind={draft.accepted ? 'solid' : 'hollow'}
                color={getFeatureColor(draft.type)}
              />
              <span className="flex items-center justify-center">
                <input
                  type="checkbox"
                  checked={draft.accepted}
                  onChange={(e) => {
                    e.stopPropagation();
                    handleCheckboxToggle(draft.id);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="rounded border-border"
                />
              </span>
              <span className="flex items-center justify-center">
                <DirectionIndicator direction={draft.strand} />
              </span>
              <span className="px-1 truncate text-fg flex items-center min-w-0">
                <span className="truncate">{draft.name}</span>
                {draft.savedSubstitutionOverlap && (
                  <span
                    className="ml-1 shrink-0 rounded bg-yellow-500/15 px-1 text-[9px] text-yellow-700 dark:text-yellow-300"
                    title="Saved substitutions overlap this candidate; identity and coverage were not recalculated."
                  >
                    bases changed
                  </span>
                )}
              </span>
              <span className="px-1 text-fg-muted truncate">{draft.type || '-'}</span>
              <span
                className="px-1 font-mono text-[10px] tabular-nums text-fg-muted truncate"
                title={`${draft.start}-${draft.end}`}
              >
                {(() => {
                  const pos = formatPosition(draft.start, draft.end, draft.strand);
                  return pos.delta ? `${pos.origin} ${pos.delta}` : pos.origin;
                })()}
              </span>
              <span
                className={`px-1 truncate ${getPercentColor(draft.identity)}`}
                title={`${draft.db_source === 'protein' ? 'Amino acid' : draft.db_source === 'rna' ? 'RNA' : 'Nucleotide'} identity`}
              >
                {Math.round(draft.identity)}
                <span className="ml-0.5 opacity-60 text-[9px]">
                  {getDbSourceLabel(draft.db_source)}
                </span>
              </span>
              <span
                className={`px-1 truncate ${getPercentColor(draft.coverage)}`}
                title={getFragmentLabel(draft) || 'Full match'}
              >
                {Math.round(draft.coverage)}
              </span>
              <span
                className={`text-center font-medium ${getConfidenceColor(draft.confidence)}`}
                title={`${draft.confidence.toFixed(1)}%`}
              >
                {getConfidenceLabel(draft.confidence)}
              </span>
              <span className="text-center text-fg-muted">
                {draft.duplicateStatus.isDuplicate ? '-' : '✓'}
              </span>
            </div>
          );
        })}

        {}
        {existingAnnotations && existingAnnotations.length > 0 && (
          <>
            <div className="grid items-center px-1 py-1 text-[10px] uppercase tracking-wider text-fg-subtle bg-bg-subtle border-t border-b border-border">
              <span className="col-span-full">
                Already on sequence ({existingAnnotations.length})
              </span>
            </div>
            {existingAnnotations.map((ann, i) => {
              const direction = ann.direction === 1 ? 1 : ann.direction === -1 ? -1 : 0;
              return (
                <div
                  key={`existing-${i}`}
                  role="row"
                  className="relative grid items-center pr-1 text-xs scroll-mt-10 opacity-70"
                  style={{
                    gridTemplateColumns: REVIEW_GRID,
                    paddingLeft: `${BAR_WIDTH_PX}px`,
                    margin: 0,
                    border: 0,
                    minHeight: '22px',
                  }}
                  title="Already on sequence — not part of this review"
                >
                  <LeftEdgeBar kind="gray" />
                  <span aria-hidden="true" />
                  <span className="flex items-center justify-center">
                    <DirectionIndicator direction={direction} />
                  </span>
                  <span className="px-1 truncate text-fg-muted flex items-center min-w-0">
                    <span className="truncate">{ann.name}</span>
                  </span>
                  <span className="px-1 text-fg-muted truncate flex items-center">
                    {ann.type || '-'}
                  </span>
                  <span
                    className="px-1 font-mono text-[10px] tabular-nums text-fg-muted truncate flex items-center"
                    title={`${ann.start}-${ann.end}`}
                  >
                    {(() => {
                      const pos = formatPosition(ann.start, ann.end, direction);
                      return pos.delta ? `${pos.origin} ${pos.delta}` : pos.origin;
                    })()}
                  </span>
                  <span className="px-1 text-fg-subtle flex items-center">—</span>
                  <span className="px-1 text-fg-subtle flex items-center">—</span>
                  <span className="text-center text-fg-subtle flex items-center justify-center">
                    —
                  </span>
                  <span className="text-center text-fg-subtle flex items-center justify-center">
                    —
                  </span>
                </div>
              );
            })}
          </>
        )}
      </div>

      {}
      <div
        data-testid="plannotate-review-footer"
        className="flex flex-nowrap items-center justify-between gap-2 p-3 border-t border-border bg-bg-secondary"
      >
        <div
          data-testid="plannotate-review-footer-meta"
          className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden"
        >
          <span
            className="min-w-0 truncate whitespace-nowrap text-xs text-fg-muted"
            title={`${acceptedCount} of ${drafts.length} selected`}
          >
            {acceptedCount} of {drafts.length} selected
          </span>
          <button
            onClick={onAcceptAll}
            title="Select all"
            className="shrink-0 whitespace-nowrap text-xs text-fg-muted hover:text-success underline-offset-2 hover:underline"
          >
            Select all
          </button>
          <button
            onClick={onRejectAll}
            title="Clear all"
            className="shrink-0 whitespace-nowrap text-xs text-fg-muted hover:text-error underline-offset-2 hover:underline"
          >
            Clear all
          </button>
        </div>
        <div
          data-testid="plannotate-review-footer-actions"
          className="flex shrink-0 items-center gap-2"
        >
          <button
            onClick={onCancel}
            disabled={isApplying}
            className="shrink-0 whitespace-nowrap px-3 py-1.5 text-xs rounded border border-border hover:bg-bg-tertiary"
          >
            Discard
          </button>
          <button
            onClick={onCommit}
            disabled={isApplying || acceptedCount === 0 || !!commitBlockedReason}
            title={toUserMessage(commitBlockedReason, 'tracks.loadFailed')}
            className="shrink-0 whitespace-nowrap px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Apply ({acceptedCount})
          </button>
        </div>
      </div>
      {commitBlockedReason && (
        <div className="px-3 pb-2 text-xs text-fg-muted">
          <p role="status">{toUserMessage(commitBlockedReason, 'tracks.loadFailed')}</p>
          {onRerunReview ? (
            <button
              onClick={onRerunReview}
              className="mt-1 underline underline-offset-2 hover:text-fg"
            >
              Rerun annotation
            </button>
          ) : onRefreshReview ? (
            <button
              onClick={onRefreshReview}
              className="mt-1 underline underline-offset-2 hover:text-fg"
            >
              Refresh review
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
