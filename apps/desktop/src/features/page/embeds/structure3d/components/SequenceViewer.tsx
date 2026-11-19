'use client';

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { residueLocationsForChain, SequenceTrack } from './SequenceTrack';
import { ResidueBox } from './ResidueBox';
import { useOverflowYWhenNeeded } from '../hooks/useOverflowYWhenNeeded';
import type {
  ChainSequence,
  ResidueLocation,
  ResidueInteractionState,
  Structure3dColorMode,
  HighlightGroup,
  LigandInfo,
  StructureScene,
  StructureViewState,
  StructureChainColoring,
  StructureSelectionGesture,
} from '../types';
import { createStructureChainColoring } from '../types';
import {
  createStructureRenderModel,
  type StructureRenderModel,
} from '../utils/structureRenderModel';
import {
  structureMemberChainBadgesForChain,
  structureMemberDisplayLabelForChain,
  structureMemberRoleLabel,
} from '../utils/structureMemberLabels';
import {
  structureChainDisplayKey,
  type PolymerChainResidueDisplay,
} from '../utils/polymerResidueDisplay';

export interface SequenceViewerProps {
  chains: ChainSequence[];

  polymerResidueDisplays?: ReadonlyArray<PolymerChainResidueDisplay>;

  ligands?: LigandInfo[];

  colorMode: Structure3dColorMode;

  chainColoring?: StructureChainColoring;

  renderModel?: StructureRenderModel | undefined;

  scene?: StructureScene;

  view?: StructureViewState;

  onToggleDetailMember?: (memberId: string, visible: boolean) => void;

  onToggleDetailChain?: (
    chainInstanceId: string,
    visible: boolean,
    currentVisibleChainInstanceIds: readonly string[]
  ) => void;

  onToggleChainVisibility?: (chainInstanceId: string, visible: boolean) => void;

  interactionState: ResidueInteractionState;

  highlightGroups?: HighlightGroup[];

  onHover: (residue: ResidueLocation | null) => void;

  onSelect: (
    residue: ResidueLocation,
    gesture: StructureSelectionGesture,
    orderedResidues?: ReadonlyArray<ResidueLocation>
  ) => void;

  onSelectChain?: (
    residues: ReadonlyArray<ResidueLocation>,
    gesture: StructureSelectionGesture
  ) => void;

  onKeyDownCapture?: (event: KeyboardEvent<HTMLDivElement>) => void;
  sequenceStatus?: 'loading' | 'unavailable';
}

export const DEFAULT_CHAIN_TABLE_HEIGHT_PX = 280;
export const MIN_CHAIN_TABLE_HEIGHT_PX = 48;
export const MAX_CHAIN_TABLE_HEIGHT_PX = 480;

export const HIGH_CHAIN_COUNT_COLLAPSE_THRESHOLD = 24;

export const INITIAL_RESIDUE_MOUNT_LIMIT = 1500;

export const INITIAL_EXPANDED_CHAIN_RESIDUE_LIMIT = 600;
const CHAIN_TABLE_KEYBOARD_STEP_PX = 16;

function clampChainTableHeight(heightPx: number): number {
  return Math.min(
    MAX_CHAIN_TABLE_HEIGHT_PX,
    Math.max(MIN_CHAIN_TABLE_HEIGHT_PX, Math.round(heightPx))
  );
}

export const SequenceViewer = memo(function SequenceViewer({
  chains,
  polymerResidueDisplays,
  ligands,
  colorMode,
  chainColoring,
  renderModel,
  scene,
  view,
  onToggleDetailMember,
  onToggleDetailChain,
  onToggleChainVisibility,
  interactionState,
  highlightGroups,
  onHover,
  onSelect,
  onSelectChain,
  onKeyDownCapture,
  sequenceStatus,
}: SequenceViewerProps) {
  const [chainTableHeightPx, setChainTableHeightPx] = useState(DEFAULT_CHAIN_TABLE_HEIGHT_PX);
  const [automaticHeight, setAutomaticHeight] = useState(true);
  const chainTableRef = useRef<HTMLDivElement>(null);
  const resizeDragRef = useRef<{ startY: number; startHeightPx: number } | null>(null);

  const visibleHighlightGroups = useMemo(
    () => highlightGroups?.filter((g) => g.visible !== false),
    [highlightGroups]
  );
  const showDetailControls =
    !!scene && (scene.members ?? []).filter((member) => member.kind !== 'water').length > 1;
  const resolvedChainColoring = useMemo(
    () => chainColoring ?? createStructureChainColoring(chains),
    [chainColoring, chains]
  );
  const resolvedRenderModel = useMemo(
    () =>
      renderModel ??
      createStructureRenderModel({
        chains,
        scene,
        view,
        chainColoring: resolvedChainColoring,
      }),
    [chains, scene, view, renderModel, resolvedChainColoring]
  );
  const displayRows = resolvedRenderModel.chainRows;
  const chainTableOverflowsY = useOverflowYWhenNeeded(
    chainTableRef,
    `${displayRows.length}:${chainTableHeightPx}`
  );
  const polymerResidueDisplayByChainKey = useMemo(
    () =>
      new Map(
        polymerResidueDisplays?.map((display) => [display.chainKey, display.projection] as const) ??
          []
      ),
    [polymerResidueDisplays]
  );
  const displayRowsRef = useRef(displayRows);
  displayRowsRef.current = displayRows;
  const chainSelectionAnchorIndexRef = useRef<number | null>(null);
  const handleChainSelection = useCallback(
    (
      rowIndex: number,
      rowResidues: ReadonlyArray<ResidueLocation>,
      gesture: StructureSelectionGesture
    ) => {
      if (!onSelectChain) return;
      if (gesture !== 'range') {
        chainSelectionAnchorIndexRef.current = rowIndex;
        onSelectChain(rowResidues, gesture);
        return;
      }

      const rows = displayRowsRef.current;
      const rawAnchorIndex = chainSelectionAnchorIndexRef.current;
      if (rawAnchorIndex === null) {
        chainSelectionAnchorIndexRef.current = rowIndex;
        onSelectChain(rowResidues, 'replace');
        return;
      }
      const anchorIndex =
        rawAnchorIndex >= 0 && rawAnchorIndex < rows.length ? rawAnchorIndex : rowIndex;
      const startIndex = Math.min(anchorIndex, rowIndex);
      const endIndex = Math.max(anchorIndex, rowIndex);
      const rangeResidues = rows
        .slice(startIndex, endIndex + 1)
        .flatMap((row) => residueLocationsForChain(row.chain));
      onSelectChain(rangeResidues, 'range');
    },
    [onSelectChain]
  );
  const chainSelectionHandlers = useMemo(
    () =>
      displayRows.map(
        (_, rowIndex) =>
          (residues: ReadonlyArray<ResidueLocation>, gesture: StructureSelectionGesture) =>
            handleChainSelection(rowIndex, residues, gesture)
      ),
    [displayRows, handleChainSelection]
  );
  const visibleChainInstanceIds = useMemo(
    () => displayRows.filter((row) => row.detailVisible).map((row) => row.chainInstanceId),
    [displayRows]
  );
  const visibleChainInstanceIdsRef = useRef(visibleChainInstanceIds);

  useEffect(() => {
    visibleChainInstanceIdsRef.current = visibleChainInstanceIds;
  }, [visibleChainInstanceIds]);

  const collapseKeys = useMemo(
    () => displayRows.map((row) => row.chainInstanceId ?? row.chain.chainId),
    [displayRows]
  );
  const defaultCollapsedKeys = useMemo(() => {
    const residueCounts = displayRows.map((row) => {
      const projection = polymerResidueDisplayByChainKey.get(structureChainDisplayKey(row.chain));
      return projection?.status === 'mapped'
        ? projection.entries.length
        : row.chain.residues.length;
    });
    const highChainCount = collapseKeys.length >= HIGH_CHAIN_COUNT_COLLAPSE_THRESHOLD;
    const overResidueBudget =
      residueCounts.reduce((sum, count) => sum + count, 0) > INITIAL_RESIDUE_MOUNT_LIMIT;
    if (!highChainCount && !overResidueBudget) return new Set<string>();
    const firstChainFits =
      !highChainCount && residueCounts[0] <= INITIAL_EXPANDED_CHAIN_RESIDUE_LIMIT;
    return new Set(collapseKeys.filter((_, index) => !firstChainFits || index > 0));
  }, [collapseKeys, displayRows, polymerResidueDisplayByChainKey]);
  const [collapseOverrides, setCollapseOverrides] = useState<ReadonlyMap<string, boolean>>(
    () => new Map()
  );
  const collapsedChainIds = useMemo(
    () =>
      new Set(
        collapseKeys.filter((key) => collapseOverrides.get(key) ?? defaultCollapsedKeys.has(key))
      ),
    [collapseKeys, collapseOverrides, defaultCollapsedKeys]
  );
  const toggleChainCollapsed = useCallback(
    (collapseKey: string) => {
      setCollapseOverrides((prev) => {
        const next = new Map(prev);
        next.set(collapseKey, !(prev.get(collapseKey) ?? defaultCollapsedKeys.has(collapseKey)));
        return next;
      });
    },
    [defaultCollapsedKeys]
  );
  const allChainsCollapsed =
    collapseKeys.length > 0 && collapseKeys.every((key) => collapsedChainIds.has(key));
  const toggleAllChainsCollapsed = useCallback(() => {
    setCollapseOverrides((prev) => {
      const next = new Map(prev);
      for (const key of collapseKeys) next.set(key, !allChainsCollapsed);
      return next;
    });
  }, [collapseKeys, allChainsCollapsed]);

  const handleDetailControlToggle = useCallback(
    (chainInstanceId: string, visible: boolean, memberId: string) => {
      if (onToggleDetailChain) {
        onToggleDetailChain(chainInstanceId, visible, visibleChainInstanceIdsRef.current);
        return;
      }
      onToggleDetailMember?.(memberId, visible);
    },
    [onToggleDetailChain, onToggleDetailMember]
  );

  const resizeChainTable = useCallback((nextHeightPx: number) => {
    setAutomaticHeight(false);
    setChainTableHeightPx(clampChainTableHeight(nextHeightPx));
  }, []);
  const visibleChainTableHeight = useCallback(
    () => chainTableRef.current?.getBoundingClientRect().height || chainTableHeightPx,
    [chainTableHeightPx]
  );

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!Number.isFinite(event.clientY)) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      resizeDragRef.current = {
        startY: event.clientY,
        startHeightPx: visibleChainTableHeight(),
      };
    },
    [visibleChainTableHeight]
  );

  const handleResizeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        event.preventDefault();
        resizeChainTable(visibleChainTableHeight() + CHAIN_TABLE_KEYBOARD_STEP_PX);
        return;
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        event.preventDefault();
        resizeChainTable(visibleChainTableHeight() - CHAIN_TABLE_KEYBOARD_STEP_PX);
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        resizeChainTable(MIN_CHAIN_TABLE_HEIGHT_PX);
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        resizeChainTable(MAX_CHAIN_TABLE_HEIGHT_PX);
      }
    },
    [visibleChainTableHeight, resizeChainTable]
  );

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = resizeDragRef.current;
      if (!drag) return;
      if (!Number.isFinite(event.clientY)) return;
      resizeChainTable(drag.startHeightPx + event.clientY - drag.startY);
    };

    const handlePointerUp = () => {
      resizeDragRef.current = null;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [resizeChainTable]);

  const highlightGroupsByChain = useMemo(() => {
    if (!visibleHighlightGroups?.length) return new Map<string, HighlightGroup[]>();
    const groupsByChain = new Map<string, HighlightGroup[]>();
    for (const group of visibleHighlightGroups) {
      for (const selection of group.selections) {
        const current = groupsByChain.get(selection.chain);
        if (current) {
          current.push(group);
        } else {
          groupsByChain.set(selection.chain, [group]);
        }
      }
    }
    return groupsByChain;
  }, [visibleHighlightGroups]);

  const moveDetailFocus = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const displayRows = displayRowsRef.current;
    const chainIndex = Number(event.currentTarget.dataset.chainIndex);
    if (!Number.isInteger(chainIndex)) return;
    const nextIndex =
      event.key === 'ArrowDown'
        ? Math.min(displayRows.length - 1, chainIndex + 1)
        : Math.max(0, chainIndex - 1);
    const next = event.currentTarget
      .closest('[data-testid="structure-chain-table"]')
      ?.querySelector<HTMLInputElement>(
        `[data-testid="structure-detail-chain-${displayRows[nextIndex].chain.chainId}"]`
      );
    next?.focus();
  }, []);

  const chainTableToolbar =
    displayRows.length > 1 ? (
      <span
        data-testid="structure-chain-table-toolbar"
        className="flex shrink-0 items-center gap-2 text-[9px] text-fg-subtle"
      >
        <span>{displayRows.length} chains</span>
        <button
          type="button"
          onClick={toggleAllChainsCollapsed}
          onPointerDown={(event) => event.stopPropagation()}
          className="rounded px-1.5 py-0.5 font-medium text-fg-muted wp-interactive "
          data-testid="structure-chain-collapse-all"
          aria-pressed={allChainsCollapsed}
        >
          {allChainsCollapsed ? 'Expand all' : 'Collapse all'}
        </button>
      </span>
    ) : undefined;

  return (
    <div
      role="region"
      aria-label="Structure sequence"
      className="relative flex min-h-12 shrink-0 flex-col bg-bg-subtle"
      style={{ maxHeight: automaticHeight ? '35%' : undefined }}
      data-testid="structure-sequence-viewer"
    >
      <div data-testid="structure-sequence-horizontal-rule" className="h-px bg-border" />

      <div
        data-testid="structure-chain-table"
        ref={chainTableRef}
        tabIndex={onKeyDownCapture ? 0 : undefined}
        onKeyDownCapture={onKeyDownCapture}
        data-overflow-y={chainTableOverflowsY ? 'auto' : 'none'}
        className={`min-h-0 ${chainTableOverflowsY ? 'overflow-y-auto' : 'overflow-y-clip'} divide-y divide-border/30 border-b border-border select-none ${onKeyDownCapture ? 'outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent' : ''}`}
        style={{ maxHeight: chainTableHeightPx, scrollbarWidth: 'thin' }}
      >
        {displayRows.length === 0 && (
          <div
            role={sequenceStatus === 'unavailable' ? 'alert' : 'status'}
            className="px-3 py-3 text-xs text-fg-muted"
          >
            {sequenceStatus === 'loading'
              ? 'Loading sequence…'
              : sequenceStatus === 'unavailable'
                ? 'The sequence could not be read from this structure.'
                : 'This structure has no polymer sequence.'}
          </div>
        )}
        {displayRows.map((row, index) => {
          const { chain, member } = row;
          const detailVisible = row.detailVisible;
          const detailControl =
            showDetailControls &&
            member &&
            chain.isPrimarySource !== false &&
            (onToggleDetailChain || onToggleDetailMember)
              ? {
                  memberId: member.memberId,
                  targetId: row.chainInstanceId,
                  checked: detailVisible,
                  label: structureMemberDisplayLabelForChain(member, chain),
                  roleLabel: structureMemberRoleLabel(member, scene?.queryAnchor.memberId),
                  groupLabel: row.groupLabel,
                  badges: structureMemberChainBadgesForChain(member, chain),
                  focusIndex: index,
                  testId: `structure-detail-chain-${chain.chainId}`,
                  onToggle: handleDetailControlToggle,
                  onKeyDown: moveDetailFocus,
                }
              : undefined;

          return (
            <SequenceTrack
              key={row.chainInstanceId}
              chain={chain}
              polymerResidueDisplay={
                chain.isPrimarySource === false
                  ? undefined
                  : polymerResidueDisplayByChainKey.get(structureChainDisplayKey(chain))
              }
              colorMode={colorMode}
              detailVisible={detailVisible}
              chainColor={row.detailColor}
              displayColor={detailVisible ? row.detailColor : resolvedRenderModel.contextColor}
              displayChainId={row.displayChainId}
              chainInstanceId={row.chainInstanceId}
              memberId={row.memberId}
              groupId={row.groupId}
              groupLabel={row.groupLabel}
              groupEvidence={row.groupEvidence}
              detailControl={detailControl}
              headerEnd={index === 0 ? chainTableToolbar : undefined}
              interactionState={interactionState}
              highlightGroups={
                chain.isPrimarySource === false
                  ? undefined
                  : highlightGroupsByChain.get(chain.chainId)
              }
              collapseKey={row.chainInstanceId ?? chain.chainId}
              collapsed={collapsedChainIds.has(row.chainInstanceId ?? chain.chainId)}
              onToggleCollapse={toggleChainCollapsed}
              onToggleVisibility={onToggleChainVisibility}
              visibilityMasked={view?.hiddenChainInstanceIds?.includes(row.chainInstanceId)}
              onHover={onHover}
              onSelect={onSelect}
              onSelectChain={onSelectChain ? chainSelectionHandlers[index] : undefined}
            />
          );
        })}

        {}
        {ligands && ligands.length > 0 && (
          <div className="py-1 first:pt-0.5 last:pb-0.5">
            <div className="flex items-center gap-2 px-2 mb-0.5">
              <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-amber-500/20 text-amber-600">
                Ligands
              </span>
              <span className="text-[8px] text-fg-subtle">
                {ligands.length} molecule{ligands.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div
              className="overflow-x-auto flex gap-px px-2 pb-2"
              style={{ scrollbarWidth: 'thin' }}
            >
              {ligands.map((ligand, idx) => {
                const isHovered =
                  (interactionState.hovered?.structureRef
                    ? interactionState.hovered.structureRef === ligand.structureRef
                    : ligand.isPrimarySource !== false) &&
                  interactionState.hovered?.chain === ligand.chainId &&
                  interactionState.hovered?.position === ligand.position &&
                  interactionState.hovered?.compId === ligand.name;
                const isSelected = interactionState.selected.some(
                  (r) =>
                    (r.structureRef
                      ? r.structureRef === ligand.structureRef
                      : ligand.isPrimarySource !== false) &&
                    r.chain === ligand.chainId &&
                    r.position === ligand.position &&
                    r.compId === ligand.name
                );

                const ligandHighlight =
                  ligand.isPrimarySource === false
                    ? undefined
                    : visibleHighlightGroups?.find((g) => {
                        const chainSelection = g.selections.find((s) => s.chain === ligand.chainId);
                        if (!chainSelection) return false;
                        return chainSelection.ranges.some(
                          ([start, end]) => ligand.position >= start && ligand.position <= end
                        );
                      });
                const isLigandInSelectionMask = (candidate: (typeof ligands)[number]) => {
                  const activelySelected = interactionState.selected.some(
                    (residue) =>
                      (residue.structureRef
                        ? residue.structureRef === candidate.structureRef
                        : candidate.isPrimarySource !== false) &&
                      residue.chain === candidate.chainId &&
                      residue.position === candidate.position &&
                      residue.compId === candidate.name
                  );
                  const savedSelected =
                    candidate.isPrimarySource !== false &&
                    visibleHighlightGroups?.some((group) => {
                      const chainSelection = group.selections.find(
                        (selection) => selection.chain === candidate.chainId
                      );
                      return chainSelection?.ranges.some(
                        ([start, end]) => candidate.position >= start && candidate.position <= end
                      );
                    });
                  return activelySelected || !!savedSelected;
                };

                const handleLigandHover = (residue: ResidueLocation | null) => {
                  if (residue) {
                    onHover({
                      ...residue,
                      compId: ligand.name,
                      baseChain: ligand.baseChain,
                      labelAsymId: ligand.labelAsymId,
                      authAsymId: ligand.authAsymId,
                      entityId: ligand.entityId,
                      operator: ligand.operator,
                      structureRef: ligand.structureRef,
                      instanceId: ligand.instanceId,
                      isPrimarySource: ligand.isPrimarySource,
                    });
                  } else {
                    onHover(null);
                  }
                };

                const handleLigandSelect = (
                  residue: ResidueLocation,
                  gesture: StructureSelectionGesture
                ) => {
                  const scopedResidue = {
                    ...residue,
                    compId: ligand.name,
                    baseChain: ligand.baseChain,
                    labelAsymId: ligand.labelAsymId,
                    authAsymId: ligand.authAsymId,
                    entityId: ligand.entityId,
                    operator: ligand.operator,
                    structureRef: ligand.structureRef,
                    instanceId: ligand.instanceId,
                    isPrimarySource: ligand.isPrimarySource,
                  };
                  onSelect(scopedResidue, gesture, [scopedResidue]);
                };

                const hasSelectionBefore = idx > 0 && isLigandInSelectionMask(ligands[idx - 1]);
                const hasSelectionAfter =
                  idx < ligands.length - 1 && isLigandInSelectionMask(ligands[idx + 1]);

                return (
                  <ResidueBox
                    key={`${ligand.chainId}-${ligand.position}-${ligand.name}-${idx}`}
                    entryKind="ligand"
                    residue={{
                      position: ligand.position,
                      name: ligand.name,
                      name3: ligand.name,
                      coloration: ligand.coloration,
                    }}
                    chainId={ligand.chainId}
                    baseChain={ligand.baseChain}
                    labelAsymId={ligand.labelAsymId}
                    authAsymId={ligand.authAsymId}
                    entityId={ligand.entityId}
                    operator={ligand.operator}
                    colorMode={colorMode}
                    isHovered={isHovered}
                    isSelected={isSelected}
                    isSelectionHighlighted={!!ligandHighlight}
                    hasSelectionBefore={hasSelectionBefore}
                    hasSelectionAfter={hasSelectionAfter}
                    onHover={handleLigandHover}
                    onSelect={handleLigandSelect}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>
      <div
        role="separator"
        aria-label="Resize chain sequence table"
        aria-orientation="horizontal"
        aria-valuemin={MIN_CHAIN_TABLE_HEIGHT_PX}
        aria-valuemax={MAX_CHAIN_TABLE_HEIGHT_PX}
        aria-valuenow={chainTableHeightPx}
        tabIndex={0}
        data-testid="structure-chain-table-resize-handle"
        className="group flex h-2 shrink-0 cursor-row-resize items-center justify-center border-b border-border bg-bg-subtle hover:bg-bg-muted focus:outline-none focus:ring-1 focus:ring-accent"
        onPointerDown={handleResizePointerDown}
        onKeyDown={handleResizeKeyDown}
      >
        <span className="h-px w-8 rounded bg-border-hover group-hover:bg-fg-subtle" />
      </div>
    </div>
  );
});
