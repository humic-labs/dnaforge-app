import {
  userEntityLabel,
  userMessage,
  userMessageWithValues,
  renderUserMessage,
  toOptionalUserMessage,
  type UserMessage,
} from '@waypoint/user-messages';
import { useCallback, useState, useRef, useEffect, useMemo } from 'react';
import type { VerificationTrack, StructuralRegion, Mutation } from '../types';
import { useVerificationStore } from '../store';
import { safeFocus } from '../../../shared/utils/safeFocus';
import { debugLog } from '../../../utils/debug-log';
import { getAlignmentEvidence } from '../utils/mutation-computation';
import { type MutationMarker } from '@waypoint/workspace-editor';
import {
  classifyPointMutation,
  classifyStructuralRegion,
  formatPointMutationChange,
  formatStructuralChange,
  getTypeBadgeStyle,
} from '../utils/mutation-display';

function anchorRefPositionBefore(gappedRef: string, columnStart: number): number {
  let refPos = 0;
  for (let col = 0; col < columnStart && col < gappedRef.length; col++) {
    if (gappedRef[col] !== '-') refPos++;
  }
  return refPos;
}

type UnifiedMutationRow =
  | {
      kind: 'point';
      id: string;

      sortColumn: number;

      column: number;

      endColumn: number;

      refPosition: number;

      refEndPosition: number;

      displayType: 'SNV' | 'MNV' | 'INS' | 'DEL';

      change: string;

      effect: Mutation['effect'] | undefined;

      originalIndex: number;

      anchorRefPosition?: number;

      insertionLength?: number;
    }
  | {
      kind: 'structural';
      id: string;

      sortColumn: number;

      column: number;

      endColumn: number;

      refPosition: number;

      refEndPosition: number;

      displayType: 'DEL' | 'INS' | 'DUP' | 'INV' | 'MIX';

      change: string;

      severity: 'high' | 'medium' | 'low';

      region: StructuralRegion;

      anchorRefPosition?: number;

      insertionLength?: number;
    };

export function TrackMutationsPanel({
  track,
  mutationMarkers,
  selectedMutationIndex: _selectedMutationIndex,
  onSelectMutation,
  documentId,
  curationMode,
  sessionId,
  onInspectProteinContext,
  proteinContextBlockedReason,
  followProteinContext = false,
  inspectedMutationId,
  onClearProteinContext,
}: {
  track: VerificationTrack;

  mutationMarkers: MutationMarker[];

  selectedMutationIndex: number | null;
  onSelectMutation: (index: number | null) => void;

  documentId: string;

  curationMode?: boolean;

  sessionId?: string;
  onInspectProteinContext?: (mutation: Mutation, track: VerificationTrack) => string | undefined;
  proteinContextBlockedReason?: UserMessage;
  followProteinContext?: boolean;
  inspectedMutationId?: string;
  onClearProteinContext?: (reason: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const mutations = track.mutations;
  const analysis = track.structuralAnalysis;
  const evidence = useMemo(
    () =>
      getAlignmentEvidence(
        track.alignment?.alignedReference ?? '',
        track.alignment?.alignedQuery ?? '',
        track.alignment?.referenceLength
      ),
    [track.alignment]
  );
  const evidenceWarning = !evidence.complete ? (
    <div
      data-testid="alignment-evidence-warning"
      className="border-b border-border px-4 py-3 text-sm text-fg-muted"
    >
      <div className="font-medium text-fg">Incomplete sequence</div>
      {evidence.total > 0 ? (
        <p>
          {evidence.unresolved} of {evidence.total} reference bases are unsequenced or ambiguous.
          This clone cannot be fully verified.
        </p>
      ) : (
        <p>No aligned sequence is available to verify this clone.</p>
      )}
      {evidence.ambiguousInsertions > 0 && (
        <p>{evidence.ambiguousInsertions} inserted bases are also ambiguous.</p>
      )}
    </div>
  ) : null;
  const toggleMutationChecked = useVerificationStore((s) => s.toggleMutationChecked);

  const navigateToMutation = useCallback(
    (navigateToColumn: number, highlightStart: number, highlightEnd: number) => {
      const position = navigateToColumn + 1;
      const highlightRange = { start: highlightStart, end: highlightEnd };
      debugLog('[TrackMutationsPanel] navigateToMutation:', {
        navigateToColumn,
        highlightStart,
        highlightEnd,
        documentId,
      });
      useVerificationStore
        .getState()
        .navigateToPosition(documentId, position, highlightRange, track.id);
    },
    [documentId, track.id]
  );

  const ROW_HEIGHT = 24;
  const BUFFER_ROWS = 5;

  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(256);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [proteinContextError, setProteinContextError] = useState<UserMessage | undefined>();
  useEffect(() => {
    if (inspectedMutationId) setSelectedRowId(inspectedMutationId);
  }, [inspectedMutationId]);

  const previousTrackId = useRef(track.id);
  useEffect(() => {
    if (previousTrackId.current === track.id) return;
    previousTrackId.current = track.id;
    setSelectedRowId(null);
    setProteinContextError(undefined);
    if (followProteinContext)
      onClearProteinContext?.(
        userMessageWithValues('alignment.selectMutationFrom', {
          clone: userEntityLabel(track.label),
        })
      );
  }, [track.id, track.label, followProteinContext, onClearProteinContext]);

  useEffect(() => {
    if (followProteinContext && proteinContextBlockedReason) {
      onClearProteinContext?.(proteinContextBlockedReason);
    }
  }, [followProteinContext, proteinContextBlockedReason, onClearProteinContext]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let timeoutId: ReturnType<typeof setTimeout>;
    const updateHeight = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        setContainerHeight(container.clientHeight || 256);
      }, 50);
    };
    setContainerHeight(container.clientHeight || 256);

    const observer = new ResizeObserver(updateHeight);
    observer.observe(container);
    return () => {
      clearTimeout(timeoutId);
      observer.disconnect();
    };
  }, []);

  const VISIBLE_ROWS = Math.ceil(containerHeight / ROW_HEIGHT) + BUFFER_ROWS * 2;

  const unifiedRows = useMemo(() => {
    const rows: UnifiedMutationRow[] = [];
    const structuralRegions = analysis?.structuralRegions ?? [];
    const pointMutationIndicesSet = new Set(
      analysis?.pointMutationIndices ?? mutations.map((_, i) => i)
    );

    const gappedRef = track.alignment?.alignedReference;
    for (const region of structuralRegions) {
      const isStructuralInsertion = region.refStart == null;
      const anchor =
        isStructuralInsertion && gappedRef
          ? anchorRefPositionBefore(gappedRef, region.columnStart)
          : undefined;

      rows.push({
        kind: 'structural',
        id: region.id,
        sortColumn: region.columnStart,
        column: region.columnStart,
        endColumn: (() => {
          const exclusiveEnd = region.columnEnd;
          if (!gappedRef || isStructuralInsertion) return exclusiveEnd - 1;
          let col = exclusiveEnd - 1;
          while (col > region.columnStart && gappedRef[col] === '-') {
            col--;
          }
          return col;
        })(),
        refPosition: region.refStart ?? anchor ?? 0,
        refEndPosition: region.refEnd ?? anchor ?? 0,
        displayType: classifyStructuralRegion(region.type),
        change: formatStructuralChange(region, mutations),
        severity: region.severity,
        region,
        anchorRefPosition: anchor,
        insertionLength: isStructuralInsertion ? region.lengthColumns : undefined,
      });
    }

    for (let i = 0; i < mutations.length; i++) {
      if (!pointMutationIndicesSet.has(i)) continue;
      const mutation = mutations[i];
      const marker = mutationMarkers[i];
      if (!marker) continue;

      const isIns = mutation.type === 'insertion';
      const insLength = isIns ? mutation.length || mutation.alternateBase?.length || 1 : undefined;

      rows.push({
        kind: 'point',
        id: mutation.id,
        sortColumn: marker.column,
        column: marker.column,
        endColumn: marker.endColumn ?? marker.column,
        refPosition: mutation.position,
        refEndPosition: isIns ? mutation.position : mutation.position + (mutation.length || 1) - 1,
        displayType: classifyPointMutation(mutation),
        change: formatPointMutationChange(mutation),
        effect: mutation.effect,
        originalIndex: i,

        anchorRefPosition: isIns ? mutation.position - 1 : undefined,
        insertionLength: insLength,
      });
    }

    rows.sort((a, b) => a.sortColumn - b.sortColumn);
    return rows;
  }, [mutations, mutationMarkers, analysis, track.alignment]);

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS);
  const endIndex = Math.min(unifiedRows.length, startIndex + VISIBLE_ROWS);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const selectedUnifiedIndex = useMemo(() => {
    if (!selectedRowId) return -1;
    return unifiedRows.findIndex((row) => row.id === selectedRowId);
  }, [unifiedRows, selectedRowId]);

  useEffect(() => {
    if (selectedUnifiedIndex >= 0 && containerRef.current) {
      const rowTop = selectedUnifiedIndex * ROW_HEIGHT;
      const rowBottom = rowTop + ROW_HEIGHT;
      const viewTop = containerRef.current.scrollTop;
      const viewBottom = viewTop + containerHeight;

      if (rowTop < viewTop) {
        containerRef.current.scrollTop = rowTop;
      } else if (rowBottom > viewBottom) {
        containerRef.current.scrollTop = rowBottom - containerHeight;
      }

      const renderedIndex = selectedUnifiedIndex - startIndex;
      if (renderedIndex >= 0 && renderedIndex < rowRefs.current.length) {
        safeFocus(rowRefs.current[renderedIndex]);
      }
    }
  }, [selectedUnifiedIndex, startIndex, containerHeight]);

  const inspectRow = useCallback(
    (row: UnifiedMutationRow) => {
      if (!proteinContextBlockedReason) navigateToMutation(row.column, row.column, row.endColumn);
      const error =
        proteinContextBlockedReason ??
        (row.kind === 'point'
          ? onInspectProteinContext?.(mutations[row.originalIndex], track)
          : userMessage('alignment.groupedProteinMapping'));
      setProteinContextError(toOptionalUserMessage(error, 'alignment.failed'));
      if (error) onClearProteinContext?.(error);
    },
    [
      mutations,
      track,
      proteinContextBlockedReason,
      onInspectProteinContext,
      onClearProteinContext,
      navigateToMutation,
    ]
  );

  const selectRow = useCallback(
    (row: UnifiedMutationRow | null) => {
      setSelectedRowId(row?.id ?? null);
      setProteinContextError(undefined);
      onSelectMutation(row?.kind === 'point' ? row.originalIndex : null);
      if (!followProteinContext) return;
      if (row) inspectRow(row);
      else
        onClearProteinContext?.(
          userMessageWithValues('alignment.selectMutationFrom', {
            clone: userEntityLabel(track.label),
          })
        );
    },
    [onSelectMutation, followProteinContext, inspectRow, onClearProteinContext, track.label]
  );

  const navigateToRow = useCallback(
    (row: UnifiedMutationRow, column = row.column) => {
      selectRow(row);

      if (!followProteinContext || proteinContextBlockedReason || column !== row.column)
        navigateToMutation(column, row.column, row.endColumn);
    },
    [selectRow, followProteinContext, proteinContextBlockedReason, navigateToMutation]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, rowIndex: number) => {
      const maxIndex = unifiedRows.length - 1;

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          const nextIndex = Math.min(rowIndex + 1, maxIndex);
          const nextRow = unifiedRows[nextIndex];
          if (nextRow) {
            selectRow(nextRow);
          }
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          const prevIndex = Math.max(rowIndex - 1, 0);
          const prevRow = unifiedRows[prevIndex];
          if (prevRow) {
            selectRow(prevRow);
          }
          break;
        }
        case 'Home':
          e.preventDefault();
          if (unifiedRows[0]) {
            selectRow(unifiedRows[0]);
          }
          break;
        case 'End':
          e.preventDefault();
          if (unifiedRows[maxIndex]) {
            selectRow(unifiedRows[maxIndex]);
          }
          break;
        case 'Enter': {
          e.preventDefault();
          const row = unifiedRows[rowIndex];
          if (row) {
            navigateToRow(row);
          }
          break;
        }
        case ' ': {
          e.preventDefault();
          if (!curationMode || !sessionId) break;
          const spaceRow = unifiedRows[rowIndex];
          if (spaceRow?.kind === 'point') {
            toggleMutationChecked(documentId, sessionId, track.id, spaceRow.id);
          }
          break;
        }
        case 'Escape':
          e.preventDefault();
          selectRow(null);
          break;
      }
    },
    [
      unifiedRows,
      selectRow,
      navigateToRow,
      curationMode,
      sessionId,
      toggleMutationChecked,
      documentId,
      track.id,
    ]
  );

  const handleRowClick = (row: UnifiedMutationRow) => {
    navigateToRow(row);
  };

  const handleRowDoubleClick = (row: UnifiedMutationRow) => {
    debugLog('[TrackMutationsPanel] Row double-clicked:', {
      row,
      column: row.column,
      endColumn: row.endColumn,
      timestamp: new Date().toISOString(),
    });
    navigateToRow(row);
  };

  if (unifiedRows.length === 0) {
    return (
      <div className="px-4 py-3 text-center">
        {evidenceWarning}
        {evidence.complete &&
          track.mutations.length === 0 &&
          track.alignment.identity === 100 &&
          !proteinContextBlockedReason && (
            <div className="text-green-400 mb-1">✓ Perfect match</div>
          )}
        <div className="text-sm text-fg-muted">
          {track.mutations.length > 0
            ? 'Mutation details are unavailable. Re-run this alignment.'
            : evidence.complete
              ? 'No mutations detected'
              : 'No confirmed mutations in resolved sequence'}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {evidenceWarning}
      {onInspectProteinContext && selectedUnifiedIndex >= 0 && (
        <div className="border-b border-border px-3 py-2 text-xs">
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-fg wp-interactive disabled:opacity-50"
            disabled={!!proteinContextBlockedReason}
            title={proteinContextBlockedReason}
            onClick={() => inspectRow(unifiedRows[selectedUnifiedIndex])}
          >
            View protein context
          </button>
          {proteinContextBlockedReason && (
            <p className="mt-1 text-fg-muted">{proteinContextBlockedReason}</p>
          )}
          {proteinContextError && (
            <p role="alert" className="mt-1 text-fg-muted">
              {renderUserMessage(proteinContextError)}
            </p>
          )}
        </div>
      )}
      {}
      <div
        className="grid items-center px-3 py-1.5 border-b border-border/50 text-[11px] font-medium text-fg-muted flex-shrink-0 bg-bg-subtle"
        style={{
          gridTemplateColumns: curationMode ? '20px 90px 44px 64px 1fr' : '90px 44px 64px 1fr',
          gap: '0 6px',
        }}
      >
        {curationMode && <span />}
        <span>Position</span>
        <span>Type</span>
        <span>Change</span>
        <span>Effect</span>
      </div>

      {}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto relative"
        onScroll={handleScroll}
        role="listbox"
        aria-label="Mutations"
      >
        {}
        <div style={{ height: unifiedRows.length * ROW_HEIGHT }} />
        {}
        <div
          className="absolute top-0 left-0 right-0"
          style={{ transform: `translateY(${startIndex * ROW_HEIGHT}px)` }}
        >
          {unifiedRows.slice(startIndex, endIndex).map((row, i) => {
            const globalIndex = startIndex + i;
            const isSelected = row.id === selectedRowId;
            const isRange = row.column !== row.endColumn;

            return (
              <div
                key={row.id}
                ref={(el) => {
                  rowRefs.current[i] = el;
                }}
                role="option"
                aria-selected={isSelected}
                tabIndex={isSelected ? 0 : -1}
                onClick={() => handleRowClick(row)}
                onDoubleClick={() => handleRowDoubleClick(row)}
                onKeyDown={(e) => handleKeyDown(e, globalIndex)}
                className={`grid items-center px-3 cursor-pointer text-xs outline-none border-l-2 select-none ${
                  isSelected
                    ? 'bg-accent/10 border-l-accent'
                    : 'border-l-transparent wp-interactive'
                }`}
                style={{
                  height: ROW_HEIGHT,
                  gridTemplateColumns: curationMode
                    ? '20px 90px 44px 64px 1fr'
                    : '90px 44px 64px 1fr',
                  gap: '0 6px',
                }}
              >
                {}
                {curationMode && row.kind === 'point' && (
                  <span
                    className="flex items-center justify-center cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (sessionId) {
                        toggleMutationChecked(documentId, sessionId, track.id, row.id);
                      }
                    }}
                  >
                    {(track.checkedMutations ?? []).includes(row.id) ? (
                      <span className="text-green-400">&#9745;</span>
                    ) : (
                      <span className="text-fg-muted">&#9744;</span>
                    )}
                  </span>
                )}
                {}
                {curationMode && row.kind !== 'point' && <span />}

                {}
                <span className="font-mono text-[11px] text-fg-muted flex items-center gap-0.5 overflow-hidden">
                  {row.insertionLength != null ? (
                    <>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          navigateToRow(row);
                        }}
                        className="px-0.5 rounded bg-bg-subtle wp-interactive"
                        title={`Go to insertion site (after ref pos ${row.anchorRefPosition})`}
                      >
                        {row.anchorRefPosition ?? 0}
                      </button>
                      <span className="text-fg-muted/60">^</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          navigateToRow(row, row.endColumn);
                        }}
                        className="px-0.5 rounded bg-bg-subtle wp-interactive"
                        title={`Go to end of ${row.insertionLength}bp insertion`}
                      >
                        +{row.insertionLength}bp
                      </button>
                    </>
                  ) : isRange ? (
                    <>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          navigateToRow(row);
                        }}
                        className="px-0.5 rounded bg-bg-subtle wp-interactive"
                        title={`Go to position ${row.refPosition}`}
                      >
                        {row.refPosition}
                      </button>
                      <span>–</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          navigateToRow(row, row.endColumn);
                        }}
                        className="px-0.5 rounded bg-bg-subtle wp-interactive"
                        title={`Go to position ${row.refEndPosition}`}
                      >
                        {row.refEndPosition}
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        navigateToRow(row);
                      }}
                      className="px-0.5 rounded bg-bg-subtle wp-interactive"
                      title={`Go to position ${row.refPosition}`}
                    >
                      {row.refPosition}
                    </button>
                  )}
                </span>

                {}
                <span
                  className="px-1 py-px rounded text-[10px] font-medium text-center w-fit"
                  style={getTypeBadgeStyle(
                    row.displayType,
                    row.kind === 'structural' ? row.severity : undefined
                  )}
                >
                  {row.displayType}
                </span>

                {}
                <span className="font-mono text-[11px] overflow-hidden leading-none">
                  {row.change.includes(' / ') ? (
                    <span className="flex flex-col gap-0 -my-px">
                      {row.change.split(' / ').map((part, pi) => (
                        <span
                          key={pi}
                          className={part.startsWith('+') ? 'text-green-500' : 'text-red-400'}
                        >
                          {part}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="truncate block">{row.change}</span>
                  )}
                </span>

                {}
                <span className="text-[11px] truncate min-w-0">
                  {row.kind === 'point' && row.effect ? (
                    <span className="flex items-center gap-1">
                      <span
                        className={
                          row.effect.classification === 'frameshift' ||
                          row.effect.classification === 'nonsense'
                            ? 'text-red-400'
                            : row.effect.classification === 'readthrough'
                              ? 'text-orange-400'
                              : row.effect.classification === 'synonymous'
                                ? 'text-green-400'
                                : row.effect.classification === 'intergenic'
                                  ? 'text-fg-muted'
                                  : 'text-yellow-400'
                        }
                      >
                        {row.effect.aminoAcidChange && (
                          <span className="font-mono">{row.effect.aminoAcidChange} </span>
                        )}
                        {row.effect.classification === 'synonymous'
                          ? 'silent'
                          : row.effect.classification === 'intergenic'
                            ? 'non-coding'
                            : row.effect.classification?.replace(/_/g, ' ')}
                      </span>
                      {row.effect.featureName && (
                        <span className="text-fg-muted">· {row.effect.featureName}</span>
                      )}
                    </span>
                  ) : row.kind === 'structural' ? (
                    <span className="text-fg-muted">{row.region.type.replace(/_/g, ' ')}</span>
                  ) : (
                    <span className="text-fg-muted">—</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
