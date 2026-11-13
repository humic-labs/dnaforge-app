import { usePresentationListener } from '../../../../presentation/PresentationSurface';
import { type UserMessage, toUserMessage, userMessage } from '@waypoint/user-messages';

import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import type { Annotation } from '@waypoint/sequence-utils';
import { PlannotateSpinner } from '@/components/icons';
import type { AnnotationDraft } from '../../types';
import {
  ANNOTATION_GRID,
  EMPTY_HIDDEN_KEYS,
  DEFAULT_MANUAL_ANNOTATION_COLOR,
  type AnnotationRange,
  type AnnotationSavePayload,
} from './helpers';
import { AnnotationAddForm } from './AnnotationAddForm';
import { VirtualAnnotationList } from './VirtualAnnotationList';
import { PlannotateRangeControl } from './PlannotateRangeControl';
import { usePlannotateRangeControl } from './usePlannotateRangeControl';
import type { WireRange } from './plannotate-range';

type SortKey = 'position' | 'name' | 'type';
type SortDir = 'asc' | 'desc';
type DrawerTab = 'annotations' | 'plannotate';

interface AnnotationsDrawerContentProps {
  filePath: string;
  annotations: Annotation[];
  circular?: boolean;
  sequenceLength?: number;
  hiddenAnnotationKeys?: Set<string>;
  onToggleAnnotationVisibility?: (ann: Annotation) => void;
  onSetAllAnnotationsVisible?: (visible: boolean) => void;
  onAnnotationClick: (annotation: Annotation) => void;
  onAnnotationSave: (index: number, data: AnnotationSavePayload) => void | Promise<void>;
  onAnnotationDelete: (index: number) => void | Promise<void>;
  onRunPlannotate: (range?: WireRange) => void;
  onImportAnnotationOutput?: () => void;
  isImportingAnnotationOutput?: boolean;
  importedOutputName?: string;
  plannotateStatus: 'idle' | 'loading' | 'success' | 'error';
  plannotateError?: UserMessage;
  plannotateUnavailableReason?: UserMessage;
  sequenceVersion: number;
  runVersion?: number;
  reviewPanel?: React.ReactNode;
  editTargetIndex?: number | null;
  onAnnotationEditCancel?: (abandonedIndex: number) => void;
  onClearEditTarget?: () => void;
  activeTab: DrawerTab;
  onTabChange: (tab: DrawerTab) => void;
  hasReviewSession?: boolean;
  onAnnotationAdd?: (annotation: Annotation) => void | Promise<void>;
  pendingNewRange?: AnnotationRange | null;
  currentSelectionRange?: AnnotationRange | null;
  currentSelectionWraps?: boolean;
  onClearPendingNewRange?: () => void;
  pendingNewDraft?: AnnotationDraft | null;
  onClearPendingNewDraft?: () => void;
  onPendingNewDraftChange?: (draft: AnnotationDraft | null) => void;
  draftSessionId?: number;
}

export function AnnotationsDrawerContent({
  annotations,
  circular,
  sequenceLength,
  hiddenAnnotationKeys = EMPTY_HIDDEN_KEYS,
  onToggleAnnotationVisibility,
  onSetAllAnnotationsVisible,
  onAnnotationClick,
  onAnnotationSave,
  onAnnotationDelete,
  onRunPlannotate,
  onImportAnnotationOutput,
  isImportingAnnotationOutput = false,
  importedOutputName,
  plannotateStatus,
  plannotateError,
  plannotateUnavailableReason,
  sequenceVersion,
  runVersion,
  reviewPanel,
  editTargetIndex,
  onAnnotationEditCancel,
  onClearEditTarget,
  activeTab: activeTabProp,
  onTabChange,
  hasReviewSession: hasReviewSessionProp = false,
  onAnnotationAdd,
  pendingNewRange,
  currentSelectionRange,
  currentSelectionWraps = false,
  onClearPendingNewRange,
  pendingNewDraft,
  onClearPendingNewDraft,
  onPendingNewDraftChange,
  draftSessionId,
}: AnnotationsDrawerContentProps) {
  const presentationEvents = usePresentationListener();

  const hasReviewSession = hasReviewSessionProp && !!reviewPanel;

  const rangeControl = usePlannotateRangeControl(
    currentSelectionRange,
    currentSelectionWraps,
    sequenceLength ?? 0
  );
  const runPlannotate = () => onRunPlannotate(rangeControl.resolveWireRange());

  const tab: DrawerTab = activeTabProp ?? 'annotations';
  const [isAddingNew, setIsAddingNew] = useState(false);

  const clearPendingAddAnnotation = useCallback(() => {
    onPendingNewDraftChange?.(null);
    onClearPendingNewRange?.();
    onClearPendingNewDraft?.();
  }, [onClearPendingNewDraft, onClearPendingNewRange, onPendingNewDraftChange]);

  const cancelAddAnnotation = useCallback(() => {
    setIsAddingNew(false);
    clearPendingAddAnnotation();
  }, [clearPendingAddAnnotation]);

  const switchTab = useCallback(
    (newTab: DrawerTab) => {
      onTabChange?.(newTab);
    },
    [onTabChange]
  );
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (pendingNewRange || pendingNewDraft) {
      setIsAddingNew(true);
    }
  }, [pendingNewRange, pendingNewDraft]);
  const [sortKey, setSortKey] = useState<SortKey>('position');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const previousExpandedIndexRef = useRef<number | null>(null);
  const savedIndexRef = useRef<number | null>(null);
  useEffect(() => {
    const previous = previousExpandedIndexRef.current;
    previousExpandedIndexRef.current = expandedIndex;
    if (previous === null || previous === expandedIndex) return;
    if (savedIndexRef.current === previous) {
      savedIndexRef.current = null;
      return;
    }
    onAnnotationEditCancel?.(previous);
  }, [expandedIndex, onAnnotationEditCancel]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [scrollTargetIndex, setScrollTargetIndex] = useState<number | null>(null);
  const filteredSortedRef = useRef<Array<{ ann: Annotation; originalIndex: number }>>([]);
  const handleScrollHandled = useCallback(() => setScrollTargetIndex(null), []);
  const [showTypeFilter, setShowTypeFilter] = useState(false);
  const typeFilterRef = useRef<HTMLDivElement>(null);
  const currentSelectionLabel = currentSelectionRange
    ? `${currentSelectionRange.start}..${currentSelectionRange.end}`
    : null;
  const addAnnotationTitle = currentSelectionRange
    ? `Add Annotation. Highlight selection available (${currentSelectionLabel}); use it as annotation boundaries.`
    : 'Add Annotation';

  const handleStartAddAnnotation = useCallback(() => {
    switchTab('annotations');
    setExpandedIndex(null);
    setSelectedIndex(null);
    setIsAddingNew(true);
    onClearPendingNewRange?.();
    if (currentSelectionRange && onPendingNewDraftChange) {
      onPendingNewDraftChange({
        type: 'misc_feature',
        name: '',
        start: currentSelectionRange.start,
        end: currentSelectionRange.end,
        direction: 1,
        color: DEFAULT_MANUAL_ANNOTATION_COLOR,
      });
      return;
    }
    onClearPendingNewDraft?.();
  }, [
    currentSelectionRange,
    onClearPendingNewDraft,
    onClearPendingNewRange,
    onPendingNewDraftChange,
    switchTab,
  ]);

  useEffect(() => {
    if (!showTypeFilter) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowTypeFilter(false);
    };
    const handleClick = (e: MouseEvent) => {
      if (typeFilterRef.current && !typeFilterRef.current.contains(e.target as Node)) {
        setShowTypeFilter(false);
      }
    };
    presentationEvents.add(document, 'keydown', handleKey);
    document.addEventListener('mousedown', handleClick);
    return () => {
      presentationEvents.remove(document, 'keydown', handleKey);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [showTypeFilter, presentationEvents]);

  useEffect(() => {
    if (tab !== 'annotations') {
      cancelAddAnnotation();
    }
  }, [tab, cancelAddAnnotation]);

  useEffect(() => {
    if (editTargetIndex != null) {
      switchTab('annotations');
      setExpandedIndex(editTargetIndex);
      setSelectedIndex(editTargetIndex);
      const targetIsListed = filteredSortedRef.current.some(
        (it) => it.originalIndex === editTargetIndex
      );
      if (!targetIsListed) {
        setSearch('');
        setTypeFilter(null);
      }
      setScrollTargetIndex(editTargetIndex);
      onClearEditTarget?.();
    }
  }, [editTargetIndex, onClearEditTarget, switchTab]);

  const presentTypes = useMemo(
    () => [...new Set(annotations.map((a) => a.type))].sort(),
    [annotations]
  );

  const indexedAnnotations = useMemo(
    () => annotations.map((ann, i) => ({ ann, originalIndex: i })),
    [annotations]
  );

  const filteredSorted = useMemo(() => {
    let result = indexedAnnotations;

    if (search) {
      const lower = search.toLowerCase();
      result = result.filter((item) => item.ann.name.toLowerCase().includes(lower));
    }

    if (typeFilter) {
      result = result.filter((item) => typeFilter.has(item.ann.type));
    }

    const dir = sortDir === 'asc' ? 1 : -1;
    result = [...result].sort((a, b) => {
      switch (sortKey) {
        case 'name':
          return dir * a.ann.name.localeCompare(b.ann.name);
        case 'type':
          return dir * a.ann.type.localeCompare(b.ann.type);
        case 'position':
        default:
          return dir * (a.ann.start - b.ann.start);
      }
    });

    return result;
  }, [indexedAnnotations, search, typeFilter, sortKey, sortDir]);

  filteredSortedRef.current = filteredSorted;

  const handleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(key);
        setSortDir('asc');
      }
    },
    [sortKey]
  );

  const handleRowSelect = useCallback(
    (originalIndex: number, annotation: Annotation) => {
      setSelectedIndex(originalIndex);
      setExpandedIndex(null);
      onAnnotationClick(annotation);
    },
    [onAnnotationClick]
  );

  const handleRowClick = useCallback(
    (originalIndex: number, annotation: Annotation) => {
      if (selectedIndex === originalIndex) {
        setExpandedIndex((prev) => (prev === originalIndex ? null : originalIndex));
      } else {
        handleRowSelect(originalIndex, annotation);
      }
    },
    [selectedIndex, handleRowSelect]
  );

  const handleRowDoubleClick = useCallback((originalIndex: number) => {
    setSelectedIndex(originalIndex);
    setExpandedIndex(originalIndex);
  }, []);

  const handleEditClick = useCallback((e: React.MouseEvent, originalIndex: number) => {
    e.stopPropagation();
    setExpandedIndex((prev) => (prev === originalIndex ? null : originalIndex));
  }, []);

  const handleSave = useCallback(
    async (originalIndex: number, data: AnnotationSavePayload) => {
      savedIndexRef.current = originalIndex;
      await onAnnotationSave(originalIndex, data);
      setExpandedIndex(null);
    },
    [onAnnotationSave]
  );

  const handleDelete = useCallback(
    async (originalIndex: number) => {
      await onAnnotationDelete(originalIndex);
      setExpandedIndex(null);
      setSelectedIndex(null);
    },
    [onAnnotationDelete]
  );

  const toggleTypeFilter = useCallback(
    (type: string) => {
      setTypeFilter((prev) => {
        if (!prev) {
          const next = new Set(presentTypes);
          next.delete(type);
          return next.size === 0 ? null : next;
        }
        const next = new Set(prev);
        if (next.has(type)) {
          next.delete(type);
        } else {
          next.add(type);
        }
        return next.size === presentTypes.length ? null : next.size === 0 ? null : next;
      });
    },
    [presentTypes]
  );

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const loadingStartRef = useRef<number | null>(null);

  useEffect(() => {
    if (plannotateStatus === 'loading') {
      loadingStartRef.current = Date.now();
      setElapsedSeconds(0);
      const interval = setInterval(() => {
        if (loadingStartRef.current) {
          setElapsedSeconds(Math.floor((Date.now() - loadingStartRef.current) / 1000));
        }
      }, 1000);
      return () => clearInterval(interval);
    } else {
      loadingStartRef.current = null;
      setElapsedSeconds(0);
    }
  }, [plannotateStatus]);

  const isStale = runVersion !== undefined && runVersion !== sequenceVersion;

  return (
    <div className="h-full flex flex-col">
      {}
      <div className="flex border-b border-border flex-shrink-0">
        <button
          role="tab"
          aria-selected={tab === 'annotations'}
          onClick={() => switchTab('annotations')}
          className={`flex-1 px-3 pt-2.5 pb-2 text-sm font-medium transition-colors border-b-2 ${
            tab === 'annotations'
              ? 'text-accent border-accent'
              : 'text-fg-muted hover:text-fg border-transparent'
          }`}
        >
          Annotations
        </button>
        <button
          role="tab"
          aria-selected={tab === 'plannotate'}
          onClick={() => switchTab('plannotate')}
          className={`flex-1 px-3 pt-2.5 pb-2 text-sm font-medium transition-colors border-b-2 ${
            tab === 'plannotate'
              ? 'text-accent border-accent'
              : hasReviewSession
                ? 'text-yellow-500/70 dark:text-yellow-400/70 hover:text-yellow-500 dark:hover:text-yellow-400 border-transparent'
                : 'text-fg-muted hover:text-fg border-transparent'
          }`}
        >
          {importedOutputName ? 'Import review' : 'pLannotate'}
          <span
            className={`ml-1.5 inline-block w-1.5 h-1.5 rounded-full ${
              hasReviewSession && tab !== 'plannotate'
                ? 'bg-yellow-500 dark:bg-yellow-400'
                : 'bg-transparent'
            }`}
          />
        </button>
      </div>

      {}
      {tab === 'annotations' && (
        <div className="flex-1 flex flex-col min-h-0">
          {}
          <div className="px-2 py-2 border-b border-border flex-shrink-0 flex items-center gap-2">
            <input
              type="text"
              placeholder="Search annotations..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="min-w-0 flex-1 px-2 py-1 text-sm border border-border rounded bg-bg focus:outline-none focus:ring-1 focus:ring-accent"
            />
            {onAnnotationAdd && !isAddingNew ? (
              <button
                data-testid="add-annotation-button"
                type="button"
                aria-label="Add Annotation"
                title={addAnnotationTitle}
                onClick={handleStartAddAnnotation}
                className="flex-shrink-0 px-2.5 py-1 text-sm font-medium rounded bg-green-600 text-white hover:bg-green-700 focus:outline-none focus:ring-1 focus:ring-green-500 disabled:opacity-50"
              >
                Add
              </button>
            ) : null}
            {onImportAnnotationOutput && (
              <button
                type="button"
                data-testid="import-annotation-output"
                onClick={onImportAnnotationOutput}
                disabled={isImportingAnnotationOutput}
                className="flex-shrink-0 px-2 py-1 text-sm rounded border border-border hover:bg-bg-subtle disabled:opacity-50"
                title="Review an existing JSON or GFF3 result without running an analysis"
              >
                {isImportingAnnotationOutput ? 'Reading…' : 'Import results'}
              </button>
            )}
          </div>

          {}
          <div
            className="grid items-center py-1 px-1 bg-bg-subtle border-b border-border text-xs text-fg-muted select-none flex-shrink-0"
            style={{ gridTemplateColumns: ANNOTATION_GRID }}
          >
            <span />
            <button
              data-testid="sort-by-name"
              className="text-left px-1 py-0.5 rounded hover:bg-accent/15 hover:text-fg font-medium cursor-pointer truncate"
              onClick={() => handleSort('name')}
            >
              Name
              {sortKey === 'name' ? (
                <span className="ml-1 text-accent">{sortDir === 'asc' ? '↑' : '↓'}</span>
              ) : (
                <span className="opacity-40 ml-1">↕</span>
              )}
            </button>
            <div ref={typeFilterRef} className="relative">
              <div
                className={`flex items-center gap-0.5 px-1 py-0.5 rounded ${
                  typeFilter ? 'bg-accent/10' : ''
                }`}
              >
                <button
                  data-testid="sort-by-type"
                  onClick={() => handleSort('type')}
                  className="hover:bg-accent/15 hover:text-fg rounded px-0.5 font-medium cursor-pointer truncate"
                >
                  Type
                  {sortKey === 'type' ? (
                    <span className="ml-1 text-accent">{sortDir === 'asc' ? '↑' : '↓'}</span>
                  ) : (
                    <span className="opacity-40 ml-1">↕</span>
                  )}
                </button>
                {typeFilter && (
                  <span className="text-[9px] text-accent tabular-nums">
                    {typeFilter.size}/{presentTypes.length}
                  </span>
                )}
                <button
                  data-testid="type-filter-button"
                  onClick={() => setShowTypeFilter((v) => !v)}
                  className="hover:bg-accent/15 rounded p-0.5 cursor-pointer flex-shrink-0"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    className={typeFilter ? 'text-accent' : 'opacity-50'}
                  >
                    <path d="M1 2a1 1 0 0 1 1-1h12a1 1 0 0 1 .8 1.6L10 9.5V14a1 1 0 0 1-.55.9l-2 1A1 1 0 0 1 6 15v-5.5L1.2 2.6A1 1 0 0 1 1 2z" />
                  </svg>
                </button>
                {typeFilter && (
                  <button
                    onClick={() => setTypeFilter(null)}
                    className="text-accent hover:text-fg hover:bg-accent/15 rounded p-0.5 cursor-pointer flex-shrink-0"
                    title="Clear filter"
                  >
                    <svg
                      width="8"
                      height="8"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                    >
                      <path d="M3 3l10 10M13 3L3 13" />
                    </svg>
                  </button>
                )}
              </div>
              {showTypeFilter && (
                <div className="absolute top-full left-0 mt-1 bg-bg border border-border rounded shadow-lg z-20 min-w-[140px]">
                  <button
                    onClick={() => {
                      setTypeFilter(null);
                      setShowTypeFilter(false);
                    }}
                    className="w-full text-left px-2 py-1 text-xs hover:bg-bg-subtle text-fg-muted font-medium border-b border-border"
                  >
                    Show all
                  </button>
                  {presentTypes.map((type) => (
                    <button
                      key={type}
                      data-testid={`type-filter-${type}`}
                      onClick={() => toggleTypeFilter(type)}
                      className="w-full text-left px-2 py-1 text-xs hover:bg-bg-subtle flex items-center gap-1.5"
                    >
                      <span
                        className={`w-3 h-3 rounded-sm border ${
                          !typeFilter || typeFilter.has(type)
                            ? 'bg-accent border-accent'
                            : 'border-border'
                        }`}
                      />
                      {type}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              data-testid="sort-by-position"
              className="text-left px-1 py-0.5 rounded hover:bg-accent/15 hover:text-fg font-medium cursor-pointer"
              onClick={() => handleSort('position')}
            >
              Pos
              {sortKey === 'position' ? (
                <span className="ml-1 text-accent">{sortDir === 'asc' ? '↑' : '↓'}</span>
              ) : (
                <span className="opacity-40 ml-1">↕</span>
              )}
            </button>
            <span className="flex items-center justify-center">
              <input
                type="checkbox"
                data-testid="annotation-visible-all"
                checked={hiddenAnnotationKeys.size === 0}
                ref={(el) => {
                  if (el)
                    el.indeterminate =
                      hiddenAnnotationKeys.size > 0 &&
                      hiddenAnnotationKeys.size < annotations.length;
                }}
                onChange={() => onSetAllAnnotationsVisible?.(hiddenAnnotationKeys.size > 0)}
                title="Show or hide all annotations in the viewer"
                aria-label="Toggle visibility of all annotations"
                className="w-3 h-3 cursor-pointer accent-gray-300 dark:accent-gray-600"
              />
            </span>
          </div>

          {}
          {isAddingNew && onAnnotationAdd && (
            <AnnotationAddForm
              key={`session-${draftSessionId ?? 0}`}
              allAnnotations={annotations}
              circular={circular}
              sequenceLength={sequenceLength}
              initialRange={pendingNewRange}
              initialDraft={pendingNewDraft}
              highlightSelectionRange={currentSelectionRange}
              onSave={async (annotation) => {
                await onAnnotationAdd(annotation);
                setIsAddingNew(false);
                clearPendingAddAnnotation();
              }}
              onCancel={cancelAddAnnotation}
              onDraftEdit={onPendingNewDraftChange}
            />
          )}

          {}
          <VirtualAnnotationList
            items={filteredSorted}
            emptyMessage={annotations.length === 0 ? 'No annotations' : 'No matching annotations'}
            selectedIndex={selectedIndex}
            expandedIndex={expandedIndex}
            scrollToOriginalIndex={scrollTargetIndex}
            onScrollHandled={handleScrollHandled}
            annotations={annotations}
            circular={circular}
            sequenceLength={sequenceLength}
            hiddenKeys={hiddenAnnotationKeys}
            onToggleVisibility={onToggleAnnotationVisibility ?? (() => {})}
            onRowClick={handleRowClick}
            onRowSelect={handleRowSelect}
            onRowDoubleClick={handleRowDoubleClick}
            onEditClick={handleEditClick}
            onSave={handleSave}
            onDelete={handleDelete}
            onCancelEdit={() => {
              const abandoned = expandedIndex;
              setExpandedIndex(null);
              if (abandoned !== null) onAnnotationEditCancel?.(abandoned);
            }}
          />
        </div>
      )}

      {}
      {tab === 'plannotate' && (
        <div className="flex-1 flex flex-col min-h-0">
          {importedOutputName && (
            <div className="px-3 py-2 text-xs text-fg-muted border-b border-border">
              <p>Imported from {importedOutputName}. No analysis was run.</p>
              <p>
                The exact sequence used for this result is unknown. Check the positions before
                applying.
              </p>
            </div>
          )}
          <div
            className={`flex-shrink-0 ${plannotateStatus === 'success' && !isStale ? '' : 'px-3 py-2'}`}
          >
            {}
            {isStale && plannotateStatus === 'success' && (
              <div className="mb-2 px-2 py-1.5 bg-yellow-500/10 border border-yellow-500/30 rounded text-xs text-yellow-600 dark:text-yellow-400">
                {importedOutputName ? (
                  <>
                    The document changed after this file was inspected. Import it again to review
                    the current document.
                  </>
                ) : (
                  <>
                    Sequence modified since last run. Results may be outdated.
                    <button
                      className="ml-2 underline font-medium disabled:opacity-50"
                      disabled={Boolean(plannotateUnavailableReason)}
                      onClick={runPlannotate}
                    >
                      Re-run
                    </button>
                  </>
                )}
              </div>
            )}

            {}
            {plannotateStatus === 'idle' && (
              <>
                <button
                  className="w-full px-3 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50"
                  disabled={Boolean(plannotateUnavailableReason)}
                  onClick={runPlannotate}
                >
                  Run pLannotate
                </button>
                <PlannotateRangeControl control={rangeControl} />
              </>
            )}

            {}
            {plannotateStatus === 'loading' && (
              <div className="flex justify-center py-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-fg-muted">Annotating...</span>
                  <PlannotateSpinner size={20} />
                  {elapsedSeconds > 0 && (
                    <span className="text-sm text-fg-muted tabular-nums whitespace-nowrap">
                      ({elapsedSeconds}s)
                    </span>
                  )}
                </div>
              </div>
            )}

            {}
            {plannotateStatus === 'error' && (
              <div>
                <div className="text-sm text-red-500 mb-2">
                  {plannotateError ? plannotateError : userMessage('failure.annotation-failed')}
                </div>
                <button
                  className="w-full px-3 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50"
                  disabled={Boolean(plannotateUnavailableReason)}
                  onClick={runPlannotate}
                >
                  Retry
                </button>
              </div>
            )}
          </div>

          {plannotateUnavailableReason && !importedOutputName && (
            <p role="status" className="px-3 py-2 text-xs text-fg-muted">
              {plannotateUnavailableReason}
            </p>
          )}

          {}
          {plannotateStatus === 'success' && reviewPanel && (
            <div className="flex-1 min-h-0 overflow-y-auto">{reviewPanel}</div>
          )}
        </div>
      )}
    </div>
  );
}
