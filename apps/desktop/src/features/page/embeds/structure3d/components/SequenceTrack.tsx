'use client';

import {
  memo,
  useCallback,
  useMemo,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { ResidueBox } from './ResidueBox';
import type {
  ChainSequence,
  ResidueLocation,
  ResidueInteractionState,
  Structure3dColorMode,
  HighlightGroup,
  StructureSelectionGesture,
} from '../types';
import { getChainColorForSequenceChain, getDisplayChainId } from '../types';
import type {
  ModeledPolymerResidueDisplay,
  PolymerResidueDisplay,
  PolymerResidueDisplayProjection,
} from '../utils/polymerResidueDisplay';
import { residueLabelWidthCss } from '../utils/residueLabelLayout';
import { chainTitleColor, colorsForColoration } from '../utils/structureColoration';
import { getOperatorSuffix } from '../utils/molstarChainUtils';

interface SequenceTrackDetailControl {
  memberId: string;
  targetId: string;
  checked: boolean;
  label: string;
  roleLabel: string;
  groupLabel?: string;
  badges: string[];
  focusIndex: number;
  testId: string;
  onToggle: (chainInstanceId: string, visible: boolean, memberId: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}

export interface SequenceTrackProps {
  chain: ChainSequence;
  polymerResidueDisplay?: PolymerResidueDisplayProjection;
  colorMode: Structure3dColorMode;
  detailVisible?: boolean;
  chainColor?: string;
  displayColor?: string | undefined;
  displayChainId?: string | undefined;
  chainInstanceId?: string | undefined;
  memberId?: string | undefined;
  groupId?: string | undefined;
  groupLabel?: string | undefined;
  groupEvidence?: string | undefined;
  detailControl?: SequenceTrackDetailControl;
  headerEnd?: ReactNode;
  interactionState: ResidueInteractionState;
  highlightGroups?: HighlightGroup[];
  onHover: (residue: ResidueLocation | null) => void;
  onSelect: (
    residue: ResidueLocation,
    gesture: StructureSelectionGesture,
    orderedResidues: ReadonlyArray<ResidueLocation>
  ) => void;
  onSelectChain?: (
    residues: ReadonlyArray<ResidueLocation>,
    gesture: StructureSelectionGesture
  ) => void;
  collapsed?: boolean;
  collapseKey?: string;
  onToggleCollapse?: (collapseKey: string) => void;
  onToggleVisibility?: (chainInstanceId: string, visible: boolean) => void;
  visibilityMasked?: boolean;
}

export function residueLocationsForChain(chain: ChainSequence): ReadonlyArray<ResidueLocation> {
  return chain.residues.map((residue) => ({
    chain: chain.chainId,
    position: residue.position,
    labelCompId: residue.name3,
    ...(residue.labelSeqId !== undefined ? { labelSeqId: residue.labelSeqId } : {}),
    ...(chain.baseChain ? { baseChain: chain.baseChain } : {}),
    ...(chain.labelAsymId ? { labelAsymId: chain.labelAsymId } : {}),
    ...(chain.authAsymId ? { authAsymId: chain.authAsymId } : {}),
    ...(chain.entityId ? { entityId: chain.entityId } : {}),
    ...(chain.operator ? { operator: chain.operator } : {}),
    ...(chain.instanceId ? { instanceId: chain.instanceId } : {}),
    ...(chain.structureRef ? { structureRef: chain.structureRef } : {}),
    ...(chain.isPrimarySource !== undefined ? { isPrimarySource: chain.isPrimarySource } : {}),
  }));
}

export function residueLocationsForPolymerDisplay(
  chain: ChainSequence,
  projection: PolymerResidueDisplayProjection | undefined
): ReadonlyArray<ResidueLocation> {
  if (projection?.status !== 'mapped') return residueLocationsForChain(chain);
  return projection.entries.flatMap((entry) =>
    entry.coordinateStatus === 'modeled'
      ? [
          {
            ...entry.location,
            ...(chain.structureRef ? { structureRef: chain.structureRef } : {}),
            ...(chain.instanceId ? { instanceId: chain.instanceId } : {}),
            ...(chain.isPrimarySource !== undefined
              ? { isPrimarySource: chain.isPrimarySource }
              : {}),
          },
        ]
      : []
  );
}

const POLYMER_TYPE_LABELS: Record<NonNullable<ChainSequence['polymerType']>, string | undefined> = {
  protein: undefined,
  dna: 'DNA',
  rna: 'RNA',
  mixed: 'DNA/RNA',
  unknown: undefined,
};

function DisclosureChevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`h-3 w-3 text-fg-subtle transition-transform ${open ? 'rotate-90' : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
    </svg>
  );
}

function isInHighlightGroup(chainId: string, position: number, group: HighlightGroup): boolean {
  const chainSelection = group.selections.find((s) => s.chain === chainId);
  if (!chainSelection) return false;
  return chainSelection.ranges.some(([start, end]) => position >= start && position <= end);
}

function residueInteractionKeyForChain(
  residue: ResidueLocation | null | undefined,
  chainId: string
): string {
  if (!residue || residue.chain !== chainId) return '';
  return [
    residue.position,
    residue.compId ?? '',
    residue.operator ?? '',
    residue.baseChain ?? '',
    residue.labelAsymId ?? '',
    residue.authAsymId ?? '',
    residue.entityId ?? '',
    residue.labelSeqId ?? '',
    residue.structureRef ?? '',
    residue.instanceId ?? '',
  ].join(':');
}

function optionalResidueScopeMatches(left: string | undefined, right: string | undefined): boolean {
  return !left || !right || left === right;
}

function optionalResidueNumberScopeMatches(
  left: number | undefined,
  right: number | undefined
): boolean {
  return left === undefined || right === undefined || left === right;
}

function residueMatchesChainResidue(
  chain: ChainSequence,
  residue: ResidueLocation | null | undefined,
  chainResidue: ChainSequence['residues'][number]
): boolean {
  const position = chainResidue.position;
  if (!residue || residue.chain !== chain.chainId || residue.position !== position) return false;
  if (
    residue.structureRef
      ? residue.structureRef !== chain.structureRef
      : chain.isPrimarySource === false
  )
    return false;
  return (
    optionalResidueScopeMatches(residue.baseChain, chain.baseChain) &&
    optionalResidueScopeMatches(residue.labelAsymId, chain.labelAsymId) &&
    optionalResidueScopeMatches(residue.authAsymId, chain.authAsymId) &&
    optionalResidueScopeMatches(residue.entityId, chain.entityId) &&
    optionalResidueNumberScopeMatches(residue.labelSeqId, chainResidue.labelSeqId) &&
    optionalResidueScopeMatches(residue.operator, chain.operator) &&
    optionalResidueScopeMatches(residue.instanceId, chain.instanceId)
  );
}

function selectedInteractionKeyForChain(
  selected: readonly ResidueLocation[],
  chainId: string
): string {
  let key = '';
  for (const residue of selected) {
    if (residue.chain !== chainId) continue;
    key += `${residueInteractionKeyForChain(residue, chainId)}|`;
  }
  return key;
}

function interactionStateEqualForChain(
  chainId: string,
  prev: ResidueInteractionState,
  next: ResidueInteractionState
): boolean {
  return (
    residueInteractionKeyForChain(prev.hovered, chainId) ===
      residueInteractionKeyForChain(next.hovered, chainId) &&
    selectedInteractionKeyForChain(prev.selected, chainId) ===
      selectedInteractionKeyForChain(next.selected, chainId)
  );
}

function stringArraysEqual(prev: readonly string[], next: readonly string[]): boolean {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  return prev.every((value, index) => value === next[index]);
}

function detailControlsEqual(
  prev: SequenceTrackDetailControl | undefined,
  next: SequenceTrackDetailControl | undefined
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return false;
  return (
    prev.memberId === next.memberId &&
    prev.targetId === next.targetId &&
    prev.checked === next.checked &&
    prev.label === next.label &&
    prev.roleLabel === next.roleLabel &&
    prev.groupLabel === next.groupLabel &&
    prev.focusIndex === next.focusIndex &&
    prev.testId === next.testId &&
    prev.onToggle === next.onToggle &&
    stringArraysEqual(prev.badges, next.badges)
  );
}

function normalizedVisibleLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

function recordSequenceTrackRender(chainId: string) {
  if (typeof window === 'undefined') return;
  if (!import.meta.env.DEV && import.meta.env.MODE !== 'test') return;
  const testWindow = window as typeof window & {
    __WAYPOINT_SEQUENCE_TRACK_RENDER_DIAGNOSTICS__?: {
      total: number;
      byChain: Record<string, number>;
      events: Array<{ chainId: string; at: number }>;
    };
  };
  const current = testWindow.__WAYPOINT_SEQUENCE_TRACK_RENDER_DIAGNOSTICS__ ?? {
    total: 0,
    byChain: {},
    events: [],
  };
  current.total += 1;
  current.byChain[chainId] = (current.byChain[chainId] ?? 0) + 1;
  current.events = [...current.events, { chainId, at: performance.now() }].slice(-500);
  testWindow.__WAYPOINT_SEQUENCE_TRACK_RENDER_DIAGNOSTICS__ = current;
}

export function areSequenceTrackPropsEqual(
  prev: SequenceTrackProps,
  next: SequenceTrackProps
): boolean {
  const chainId = prev.chain.chainId;
  return (
    prev.chain === next.chain &&
    prev.polymerResidueDisplay === next.polymerResidueDisplay &&
    chainId === next.chain.chainId &&
    prev.colorMode === next.colorMode &&
    prev.detailVisible === next.detailVisible &&
    prev.chainColor === next.chainColor &&
    prev.displayColor === next.displayColor &&
    prev.displayChainId === next.displayChainId &&
    prev.chainInstanceId === next.chainInstanceId &&
    prev.memberId === next.memberId &&
    prev.groupId === next.groupId &&
    prev.groupLabel === next.groupLabel &&
    prev.groupEvidence === next.groupEvidence &&
    detailControlsEqual(prev.detailControl, next.detailControl) &&
    prev.highlightGroups === next.highlightGroups &&
    prev.collapsed === next.collapsed &&
    prev.collapseKey === next.collapseKey &&
    prev.onToggleCollapse === next.onToggleCollapse &&
    prev.onToggleVisibility === next.onToggleVisibility &&
    prev.visibilityMasked === next.visibilityMasked &&
    prev.onHover === next.onHover &&
    prev.onSelect === next.onSelect &&
    prev.onSelectChain === next.onSelectChain &&
    interactionStateEqualForChain(chainId, prev.interactionState, next.interactionState)
  );
}

export const SequenceTrack = memo(function SequenceTrack({
  chain,
  polymerResidueDisplay,
  colorMode,
  detailVisible = true,
  chainColor: resolvedChainColor,
  displayColor,
  displayChainId: resolvedDisplayChainId,
  chainInstanceId,
  memberId,
  groupId,
  groupLabel,
  groupEvidence,
  detailControl,
  headerEnd,
  interactionState,
  highlightGroups,
  onHover,
  onSelect,
  onSelectChain,
  collapsed = false,
  collapseKey,
  onToggleCollapse,
  onToggleVisibility,
  visibilityMasked = false,
}: SequenceTrackProps) {
  recordSequenceTrackRender(chain.chainId);

  const effectiveCollapseKey = collapseKey ?? chainInstanceId ?? chain.chainId;

  const { hovered, selected } = interactionState;
  const mappedPolymerDisplay =
    polymerResidueDisplay?.status === 'mapped' ? polymerResidueDisplay : undefined;
  const orderedResidues = useMemo<ReadonlyArray<ResidueLocation>>(
    () => residueLocationsForPolymerDisplay(chain, polymerResidueDisplay),
    [chain, polymerResidueDisplay]
  );
  const handleResidueSelect = useCallback(
    (residue: ResidueLocation, gesture: StructureSelectionGesture) => {
      onSelect(
        {
          ...residue,
          ...(chain.structureRef ? { structureRef: chain.structureRef } : {}),
          ...(chain.instanceId ? { instanceId: chain.instanceId } : {}),
          ...(chain.isPrimarySource !== undefined
            ? { isPrimarySource: chain.isPrimarySource }
            : {}),
        },
        gesture,
        orderedResidues
      );
    },
    [onSelect, orderedResidues, chain.structureRef, chain.instanceId, chain.isPrimarySource]
  );
  const handleResidueHover = useCallback(
    (residue: ResidueLocation | null) => {
      onHover(
        residue
          ? {
              ...residue,
              ...(chain.structureRef ? { structureRef: chain.structureRef } : {}),
              ...(chain.instanceId ? { instanceId: chain.instanceId } : {}),
              ...(chain.isPrimarySource !== undefined
                ? { isPrimarySource: chain.isPrimarySource }
                : {}),
            }
          : null
      );
    },
    [onHover, chain.structureRef, chain.instanceId, chain.isPrimarySource]
  );

  const isResidueHovered = useCallback(
    (residue: ChainSequence['residues'][number]) => {
      return residueMatchesChainResidue(chain, hovered, residue);
    },
    [hovered, chain]
  );

  const isResidueSelected = useCallback(
    (residue: ChainSequence['residues'][number]) => {
      return selected.some((r) => residueMatchesChainResidue(chain, r, residue));
    },
    [selected, chain]
  );

  const getHighlightGroup = useCallback(
    (position: number): HighlightGroup | undefined => {
      if (!highlightGroups) return undefined;
      return highlightGroups.find((group) => isInHighlightGroup(chain.chainId, position, group));
    },
    [highlightGroups, chain.chainId]
  );

  const isResidueInSelectionMask = useCallback(
    (residue: ChainSequence['residues'][number]) =>
      isResidueSelected(residue) || !!getHighlightGroup(residue.position),
    [getHighlightGroup, isResidueSelected]
  );

  const renderedResidueEntries: ReadonlyArray<PolymerResidueDisplay> | undefined =
    mappedPolymerDisplay?.entries;
  const modeledEntryInSelectionMask = useCallback(
    (entry: PolymerResidueDisplay | undefined): boolean =>
      !!entry &&
      entry.coordinateStatus === 'modeled' &&
      isResidueInSelectionMask(entry.coordinateResidue),
    [isResidueInSelectionMask]
  );
  const hasSelectionNeighborBefore = useCallback(
    (index: number) => {
      if (index === 0) return false;
      if (renderedResidueEntries) {
        return modeledEntryInSelectionMask(renderedResidueEntries[index - 1]);
      }
      return isResidueInSelectionMask(chain.residues[index - 1]);
    },
    [chain.residues, isResidueInSelectionMask, modeledEntryInSelectionMask, renderedResidueEntries]
  );

  const hasSelectionNeighborAfter = useCallback(
    (index: number) => {
      if (renderedResidueEntries) {
        if (index === renderedResidueEntries.length - 1) return false;
        return modeledEntryInSelectionMask(renderedResidueEntries[index + 1]);
      }
      if (index === chain.residues.length - 1) return false;
      return isResidueInSelectionMask(chain.residues[index + 1]);
    },
    [chain.residues, isResidueInSelectionMask, modeledEntryInSelectionMask, renderedResidueEntries]
  );

  const showChainColor = colorMode === 'chain' || colorMode === 'element';
  const chainColor = resolvedChainColor ?? getChainColorForSequenceChain(chain);
  const displayChainId = resolvedDisplayChainId ?? getDisplayChainId(chain);
  const chainIdentityLabel = `Chain ${displayChainId}`;
  const copyNumber = getOperatorSuffix(chain.operator ?? '');
  const sourceAndCopyLabel = [chain.sourceLabel, copyNumber ? `copy ${copyNumber}` : undefined]
    .filter(Boolean)
    .join(' · ');
  const visibilityChainLabel =
    chain.chainId === displayChainId ? displayChainId : `${displayChainId} (${chain.chainId})`;
  const visibleColor = chain.coloration
    ? chainTitleColor(chain.coloration)
    : (displayColor ?? (showChainColor && detailVisible ? chainColor : '#888888'));
  const detailLabel = detailControl?.label.trim() ?? '';
  const showDetailLabel =
    !!detailControl &&
    !!detailLabel &&
    normalizedVisibleLabel(detailLabel) !== normalizedVisibleLabel(chainIdentityLabel);
  const detailSummary = detailControl
    ? [showDetailLabel ? detailLabel : undefined, detailControl.roleLabel, ...detailControl.badges]
        .map((part) => part?.trim())
        .filter((part): part is string => !!part)
        .join(' | ')
    : undefined;
  const selectedResidueCount = chain.residues.reduce(
    (count, residue) => count + (isResidueSelected(residue) ? 1 : 0),
    0
  );
  const chainSelectionState =
    selectedResidueCount === 0
      ? 'none'
      : selectedResidueCount === chain.residues.length
        ? 'all'
        : 'partial';
  const polymerTypeLabel = POLYMER_TYPE_LABELS[chain.polymerType ?? 'unknown'];
  const residueCountLabel = mappedPolymerDisplay
    ? `${mappedPolymerDisplay.modeledCount} / ${mappedPolymerDisplay.polymerLength} modeled`
    : `${chain.residues.length}`;
  const hasNativeVisibility = chain.residues.some((residue) => !!residue.coloration);
  const drawnResidueCount = hasNativeVisibility
    ? chain.residues.filter((residue) => residue.coloration?.kind !== 'unrepresented').length
    : undefined;
  const visibilityLabel =
    drawnResidueCount === undefined || drawnResidueCount === chain.residues.length
      ? undefined
      : drawnResidueCount === 0
        ? 'Not drawn in 3D'
        : `${drawnResidueCount}/${chain.residues.length} drawn in 3D`;
  const visibilityState =
    drawnResidueCount === undefined || drawnResidueCount === chain.residues.length
      ? 'all'
      : drawnResidueCount === 0
        ? 'none'
        : 'partial';
  const visibilityAction = visibilityMasked
    ? 'Restore'
    : visibilityState === 'none'
      ? null
      : 'Hide';
  const handleChainSelect = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const gesture: StructureSelectionGesture = event.shiftKey
        ? 'range'
        : event.metaKey || event.ctrlKey
          ? 'toggle'
          : 'replace';
      onSelectChain?.(orderedResidues, gesture);
    },
    [onSelectChain, orderedResidues]
  );

  return (
    <div
      className="flex min-w-0 flex-col first:pt-0.5 last:pb-0.5"
      data-chain-color={visibleColor}
      data-coloration-kind={chain.coloration?.kind}
      data-drawn-colors={
        chain.coloration ? colorsForColoration(chain.coloration).join(',') : undefined
      }
      data-drawn-residue-count={drawnResidueCount}
      data-chain-instance-id={chainInstanceId}
      data-member-id={memberId}
      data-structure-ref={chain.structureRef}
      data-chain-group-id={groupId}
      data-chain-group-label={groupLabel}
      data-chain-group-evidence={groupEvidence}
      data-detail-state={detailVisible ? 'detail' : 'context'}
      data-collapsed={collapsed ? 'collapsed' : 'expanded'}
      data-testid={`chain-track-${chain.chainId}`}
      data-polymer-coverage-status={polymerResidueDisplay?.status}
      data-polymer-coverage-reason={
        polymerResidueDisplay?.status === 'unavailable' ? polymerResidueDisplay.reason : undefined
      }
    >
      <div
        className={`sticky top-0 z-20 flex min-h-7 min-w-0 items-center gap-2 bg-bg-subtle px-2.5 py-1 ${
          detailVisible ? 'text-fg' : 'text-fg-muted'
        }`}
        data-detail-summary={detailSummary}
        data-testid="chain-header"
        title={detailSummary}
      >
        <button
          type="button"
          onClick={() => onToggleCollapse?.(effectiveCollapseKey)}
          onPointerDown={(event) => event.stopPropagation()}
          className="-m-0.5 flex shrink-0 items-center justify-center rounded p-0.5 wp-interactive "
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} chain ${displayChainId} sequence`}
          data-testid={`chain-collapse-toggle-${chain.chainId}`}
        >
          <DisclosureChevron open={!collapsed} />
        </button>
        {detailControl ? (
          <input
            type="checkbox"
            checked={detailControl.checked}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => {
              event.stopPropagation();
              detailControl.onToggle(
                detailControl.targetId,
                event.target.checked,
                detailControl.memberId
              );
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              detailControl.onKeyDown?.(event);
            }}
            className="h-3.5 w-3.5 shrink-0 rounded border-border"
            style={{ accentColor: visibleColor }}
            data-chain-index={detailControl.focusIndex}
            data-testid={detailControl.testId}
            aria-label={`Show ${detailControl.label} in detail`}
          />
        ) : null}
        {onToggleVisibility && chainInstanceId ? (
          <button
            type="button"
            role="checkbox"
            disabled={!visibilityAction}
            aria-checked={visibilityState === 'partial' ? 'mixed' : visibilityState === 'all'}
            aria-label={
              visibilityAction
                ? `${visibilityAction} chain ${visibilityChainLabel}`
                : `Chain ${visibilityChainLabel} is not drawn in this view`
            }
            title={
              visibilityAction
                ? `${visibilityAction} chain ${visibilityChainLabel}`
                : `Chain ${visibilityChainLabel} is not drawn in this view`
            }
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onToggleVisibility(chainInstanceId, visibilityMasked);
            }}
            className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border-2 text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed"
            style={{
              borderColor: visibleColor ?? 'currentColor',
              backgroundColor:
                visibilityState === 'none' ? 'transparent' : (visibleColor ?? 'currentColor'),
            }}
            data-visibility-state={visibilityState}
            data-testid={`chain-visibility-toggle-${chain.chainId}`}
          >
            {visibilityState === 'partial' ? (
              <span
                aria-hidden="true"
                className="h-[2px] w-2 rounded-full bg-current text-white"
                data-testid={`chain-visibility-dash-${chain.chainId}`}
              />
            ) : visibilityState === 'all' ? (
              <svg
                aria-hidden="true"
                viewBox="0 0 12 12"
                className="h-2.5 w-2.5 text-white"
                fill="none"
              >
                <path
                  d="m2 6 2.5 2.5L10 3"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : null}
          </button>
        ) : (
          <span
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 rounded-sm border border-black/10"
            style={{
              backgroundColor:
                chain.coloration && chain.coloration.kind !== 'uniform'
                  ? 'transparent'
                  : visibleColor,
            }}
            data-testid={`chain-color-swatch-${chain.chainId}`}
          />
        )}
        {onSelectChain ? (
          <button
            type="button"
            onClick={handleChainSelect}
            className={`-mx-1 flex min-w-0 max-w-[60%] items-baseline gap-1.5 rounded px-1 text-left wp-interactive ${
              chainSelectionState === 'none' ? '' : 'bg-accent/10'
            }`}
            data-testid={`chain-selection-toggle-${chain.chainId}`}
            data-selection-state={chainSelectionState}
            aria-pressed={chainSelectionState === 'all'}
            aria-label={`Select all residues in chain ${displayChainId}`}
            title={`Select chain ${displayChainId}; Shift-click selects a contiguous chain range; Command/Control-click toggles this chain`}
          >
            <span
              className="shrink-0 py-0.5 text-[10px] font-semibold"
              style={{ color: visibleColor }}
            >
              {chainIdentityLabel}
            </span>
            {sourceAndCopyLabel ? (
              <span className="truncate text-[9px] text-fg-muted">{sourceAndCopyLabel}</span>
            ) : null}
            <span className="shrink-0 text-[8px] text-fg-subtle" title="residue count">
              {residueCountLabel}
            </span>
            {polymerTypeLabel ? (
              <span
                className="shrink-0 rounded-sm bg-bg-muted px-1 text-[8px] font-medium text-fg-muted"
                data-testid={`chain-polymer-type-${chain.chainId}`}
                title={`This chain is ${polymerTypeLabel}`}
              >
                {polymerTypeLabel}
              </span>
            ) : null}
            {showDetailLabel ? (
              <span
                className="min-w-0 truncate text-[10px] font-normal text-fg-muted"
                data-testid="chain-detail-label"
              >
                {detailLabel}
              </span>
            ) : null}
            {polymerResidueDisplay?.status === 'unavailable' ? (
              <span
                className="shrink-0 text-[8px] text-fg-subtle"
                title={`Full-polymer coordinate mapping unavailable: ${polymerResidueDisplay.reason}`}
              >
                Polymer mapping unavailable
              </span>
            ) : null}
          </button>
        ) : (
          <span
            className="flex min-w-0 max-w-[60%] items-baseline gap-1.5"
            data-testid="chain-primary-line"
          >
            <span
              className="shrink-0 py-0.5 text-[10px] font-semibold"
              style={{ color: visibleColor }}
            >
              {chainIdentityLabel}
            </span>
            <span className="shrink-0 text-[8px] text-fg-subtle" title="residue count">
              {residueCountLabel}
            </span>
            {polymerTypeLabel ? (
              <span
                className="shrink-0 rounded-sm bg-bg-muted px-1 text-[8px] font-medium text-fg-muted"
                data-testid={`chain-polymer-type-${chain.chainId}`}
                title={`This chain is ${polymerTypeLabel}`}
              >
                {polymerTypeLabel}
              </span>
            ) : null}
            {showDetailLabel ? (
              <span
                className="min-w-0 truncate text-[10px] font-normal text-fg-muted"
                data-testid="chain-detail-label"
              >
                {detailLabel}
              </span>
            ) : null}
            {polymerResidueDisplay?.status === 'unavailable' ? (
              <span
                className="shrink-0 text-[8px] text-fg-subtle"
                title={`Full-polymer coordinate mapping unavailable: ${polymerResidueDisplay.reason}`}
              >
                Polymer mapping unavailable
              </span>
            ) : null}
          </span>
        )}
        {visibilityLabel ? (
          <span
            className="ml-auto shrink-0 whitespace-nowrap rounded-sm bg-bg-muted px-1 py-0.5 text-[8px] font-medium text-fg-muted"
            data-testid={`chain-visibility-${chain.chainId}`}
            title="The sequence is present in the loaded coordinates; these residues have no visible 3D representation. Crossed-out letters are not drawn."
          >
            {visibilityLabel}
          </span>
        ) : null}
        <span className="min-w-0 flex-1" aria-hidden="true" />
        {headerEnd}
      </div>

      {!collapsed && (
        <>
          <div
            className="flex flex-wrap content-start gap-x-0 gap-y-2.5 px-2.5 pt-2.5 pb-1.5"
            data-testid="chain-sequence"
          >
            {mappedPolymerDisplay
              ? mappedPolymerDisplay.entries.map((entry, index) =>
                  entry.coordinateStatus === 'missing' ? (
                    <MissingResidueBox
                      key={`missing:${entry.polymerIndex}`}
                      chainId={chain.chainId}
                      polymerIndex={entry.polymerIndex}
                      oneLetterCode={entry.sourceOneLetterCode}
                      showPositionLabel={index === 0 || (index + 1) % 10 === 0}
                    />
                  ) : (
                    <ModeledResidueBox
                      key={`${entry.coordinateResidue.position}:${entry.coordinateResidue.labelSeqId ?? index}`}
                      entry={entry}
                      index={index}
                      chain={chain}
                      colorMode={colorMode}
                      chainColor={chainColor}
                      detailVisible={detailVisible}
                      isHovered={isResidueHovered(entry.coordinateResidue)}
                      isSelected={isResidueSelected(entry.coordinateResidue)}
                      highlightGroup={getHighlightGroup(entry.coordinateResidue.position)}
                      hasSelectionBefore={hasSelectionNeighborBefore(index)}
                      hasSelectionAfter={hasSelectionNeighborAfter(index)}
                      onHover={handleResidueHover}
                      onSelect={handleResidueSelect}
                    />
                  )
                )
              : chain.residues.map((residue, index) => {
                  const highlightGroup = getHighlightGroup(residue.position);

                  return (
                    <ResidueBox
                      key={`${residue.position}:${residue.labelSeqId ?? index}`}
                      residue={residue}
                      chainId={chain.chainId}
                      baseChain={chain.baseChain}
                      labelAsymId={chain.labelAsymId}
                      authAsymId={chain.authAsymId}
                      entityId={chain.entityId}
                      operator={chain.operator}
                      colorMode={colorMode}
                      chainColor={chainColor}
                      detailVisible={detailVisible}
                      isHovered={isResidueHovered(residue)}
                      isSelected={isResidueSelected(residue)}
                      isSelectionHighlighted={!!highlightGroup}
                      hasSelectionBefore={hasSelectionNeighborBefore(index)}
                      hasSelectionAfter={hasSelectionNeighborAfter(index)}
                      showPositionLabel={index === 0 || (index + 1) % 10 === 0}
                      onHover={handleResidueHover}
                      onSelect={handleResidueSelect}
                    />
                  );
                })}
          </div>
        </>
      )}
    </div>
  );
}, areSequenceTrackPropsEqual);

function MissingResidueBox({
  chainId,
  polymerIndex,
  oneLetterCode,
  showPositionLabel,
}: {
  chainId: string;
  polymerIndex: number;
  oneLetterCode: string;
  showPositionLabel: boolean;
}) {
  const polymerPosition = polymerIndex + 1;
  const label = `Residue ${polymerPosition} ${oneLetterCode} is not modeled in this structure`;
  return (
    <div
      role="note"
      aria-label={label}
      title={label}
      className="relative flex h-5 cursor-help select-none items-center justify-center border-b border-dotted border-fg-subtle/70 font-mono text-[10px] text-fg-subtle opacity-60"
      style={{ width: residueLabelWidthCss(oneLetterCode) }}
      data-testid={`missing-residue-${chainId}-${polymerPosition}`}
      data-coordinate-status="missing"
      data-polymer-index={polymerIndex}
      data-source-residue-name={oneLetterCode}
    >
      {showPositionLabel ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 select-none whitespace-nowrap text-[7px] leading-none text-fg-subtle"
          style={{ top: '-7px' }}
        >
          {polymerPosition}
        </span>
      ) : null}
      <span aria-hidden="true">{oneLetterCode}</span>
    </div>
  );
}

function ModeledResidueBox({
  entry,
  index,
  chain,
  colorMode,
  chainColor,
  detailVisible,
  isHovered,
  isSelected,
  highlightGroup,
  hasSelectionBefore,
  hasSelectionAfter,
  onHover,
  onSelect,
}: {
  entry: ModeledPolymerResidueDisplay;
  index: number;
  chain: ChainSequence;
  colorMode: Structure3dColorMode;
  chainColor: string;
  detailVisible: boolean;
  isHovered: boolean;
  isSelected: boolean;
  highlightGroup: HighlightGroup | undefined;
  hasSelectionBefore: boolean;
  hasSelectionAfter: boolean;
  onHover: (residue: ResidueLocation | null) => void;
  onSelect: (residue: ResidueLocation, gesture: StructureSelectionGesture) => void;
}) {
  return (
    <ResidueBox
      residue={entry.coordinateResidue}
      displayOneLetterCode={entry.sourceOneLetterCode}
      displayPosition={entry.polymerIndex + 1}
      polymerIndex={entry.polymerIndex}
      identityRelation={entry.identityRelation}
      chainId={chain.chainId}
      baseChain={chain.baseChain}
      labelAsymId={chain.labelAsymId}
      authAsymId={chain.authAsymId}
      entityId={chain.entityId}
      operator={chain.operator}
      colorMode={colorMode}
      chainColor={chainColor}
      detailVisible={detailVisible}
      isHovered={isHovered}
      isSelected={isSelected}
      isSelectionHighlighted={!!highlightGroup}
      hasSelectionBefore={hasSelectionBefore}
      hasSelectionAfter={hasSelectionAfter}
      showPositionLabel={index === 0 || (index + 1) % 10 === 0}
      onHover={onHover}
      onSelect={onSelect}
    />
  );
}
