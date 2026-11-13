'use client';
import { toUserMessage, userEntityLabel } from '@waypoint/user-messages';
import { colorKeysForThemes } from '../molstar/molViewSpecLegend';

import { stripDisplayExtension } from '@/utils/fileTypes';
import { useStructureAgentPrompt } from '../hooks/useStructureAgentPrompt';
import { MolecularPresentationControls } from './MolecularPresentationControls';
import { commitCurrentMolViewSpecCamera } from '../molstar/molViewSpec';
import { MolecularViewWorkspace } from './MolecularViewWorkspace';
import { molecularViewAttrs } from '../utils/molecularView';
import { useResetSelectionOnViewChange } from '../hooks/useResetSelectionOnViewChange';

import {
  startTransition,
  useMemo,
  useState,
  useCallback,
  useRef,
  useEffect,
  useLayoutEffect,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { LazyMolstarViewer } from '../LazyMolstarViewer';
import { useOptionalReferenceContext } from '../../../entity-ref/reference-context';
import { formatMolstarViewerDisplayError } from '../molstar-viewer-error';
import type { SequenceViewerProps } from './SequenceViewer';
import { StructureViewerFrame } from './StructureViewerFrame';
import { useNativeChainVisibility } from '../hooks/useNativeChainVisibility';
import { residueLocationsForChain } from './SequenceTrack';
import { useStructureLinkRegistry } from '../../../../structure-drawer/public/state/use-structure-link-registry';
import { polymerResidueDisplayProjectionsFromExtractedQueryChains } from '../utils/polymerResidueDisplay';
import { HoverTooltip } from './HoverTooltip';
import { ViewerControls } from './ViewerControls';
import { MolViewSpecColorControls } from './MolViewSpecColorControls';
import { AdvancedSettingsDrawer } from './AdvancedSettingsDrawer';
import { ContextMenu } from './ContextMenu';
import { StructureViewerOverlayControls } from './StructureViewerOverlayControls';
import {
  useSequenceData,
  useResidueHighlight,
  useSelectionSideChainOverlay,
  useMolstarInteraction,
  useClickDetection,
  useHoveredResidueName,
  useHighlightActions,
  useSavedSelectionProjections,
  useViewerSettings,
  useSavedSelectionEdit,
  useFocusClick,
  useSelectionActions,
  classifyMolstarCanvasPoint,
  residueAtMolstarCanvasPoint,
} from '../hooks';
import { useStructure3dStore, DEFAULT_INTERACTION_STATE } from '../store';
import { useShallow } from 'zustand/react/shallow';
import type {
  Structure3dAttrs,
  Structure3dSource,
  ResidueLocation,
  StructureSelectionGesture,
} from '../types';
import { SOURCE_CONFIGS, createStructureChainColoring } from '../types';
import { getMolstarPropsFromAttrs } from '../utils/molstarPropsUtils';
import { promoteScopedPdbSceneFromChains } from '../utils/scopedPdbSceneUpgrade';
import { createStructureRenderModel } from '../utils/structureRenderModel';
import { availableViewRecipesForStructure } from '../utils/viewRecipeAvailability';
import { focusStructureSceneMember } from '../utils/structureScene';
import { canonicalResidueLocationForStructureLink } from '../utils/residueSelectionBridge';
import { residueFromContextMenuTarget } from '../utils/contextMenuResidue';
import { buildStructureAskAiSelectionInput } from '../utils/structureAskAiInput';
import {
  advancedSettingsForStructureView,
  colorModeForStructureView,
  structureViewStateFromAttrs,
} from '../utils/viewRecipe';
import {
  chainMatchesScopes,
  filterHighlightGroupsForScopes,
  filterInteractionStateForScopes,
  filterLigandsForScopes,
  filterSequenceDataForScopes,
  scopedResidueOrNull,
} from '../utils/structureScope';
import { resolveStructureWorkspaceRoot } from '../utils/savedSelectionPersistence';
import { structureSourceIdentityKey } from '../utils/structureSourceIdentity';
import type { MolstarPlugin } from '../molstar';
import { useWorkspaceStore } from '../../../../../stores/workspaceStore';

export interface LoadedViewerProps {
  attrs: Structure3dAttrs;
  onUpdateAttrs: (attrs: Structure3dAttrs) => void;
  onReset?: () => void;

  structureId?: string;
}

const MIN_HEIGHT = 200;
const MAX_HEIGHT = 800;
const DEFAULT_HEIGHT = 300;

type PendingHoverUpdate = {
  residue: ResidueLocation | null;
  scheduledAt: number;
  lastUpdatedAt: number;
  frameId: number | null;
  timeoutId: number | null;
};

function recordHoverStateDiagnostic(
  residue: ResidueLocation | null,
  scheduledAt: number,
  lastUpdatedAt: number,
  flushedAt: number,
  setStartedAt: number,
  setEndedAt: number
) {
  if (typeof window === 'undefined') return;
  if (!import.meta.env.DEV && import.meta.env.MODE !== 'test') return;
  const testWindow = window as typeof window & {
    __WAYPOINT_STRUCTURE_HOVER_STATE__?: {
      last: {
        residue: ResidueLocation | null;
        scheduledAt: number;
        lastUpdatedAt: number;
        flushedAt: number;
        setStartedAt: number;
        setEndedAt: number;
        queueMs: number;
        setDurationMs: number;
      };
      events: Array<{
        residue: ResidueLocation | null;
        scheduledAt: number;
        lastUpdatedAt: number;
        flushedAt: number;
        setStartedAt: number;
        setEndedAt: number;
        queueMs: number;
        setDurationMs: number;
      }>;
    };
  };
  const event = {
    residue,
    scheduledAt,
    lastUpdatedAt,
    flushedAt,
    setStartedAt,
    setEndedAt,
    queueMs: flushedAt - scheduledAt,
    setDurationMs: setEndedAt - setStartedAt,
  };
  const current = testWindow.__WAYPOINT_STRUCTURE_HOVER_STATE__;
  testWindow.__WAYPOINT_STRUCTURE_HOVER_STATE__ = {
    last: event,
    events: [...(current?.events ?? []), event].slice(-100),
  };
}

export function LoadedViewer({ attrs, onUpdateAttrs, onReset, structureId }: LoadedViewerProps) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (attrsRef.current.error) {
      onUpdateAttrs({ ...attrsRef.current, error: undefined });
    }
  }, [onUpdateAttrs]);

  const [isLoaded, setIsLoaded] = useState(false);
  const [storySelectionRevision, setStorySelectionRevision] = useState(0);
  const [isResizing, setIsResizing] = useState(false);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);

  const [contextMenuTarget, setContextMenuTarget] = useState<ResidueLocation | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [plugin, setPlugin] = useState<MolstarPlugin | null>(null);
  const workspaceFolders = useWorkspaceStore((state) => state.folders);

  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const pendingHoverUpdateRef = useRef<PendingHoverUpdate | null>(null);

  const attrsRef = useRef(attrs);
  attrsRef.current = attrs;

  const stableStructureId = structureId || `structure-${attrs.sourceId || 'unknown'}`;
  const presentationAttrs =
    useStructure3dStore((state) => state.expandedStructures[stableStructureId]?.data) ?? attrs;
  const structureLinkOwnerId =
    attrs.structureBinding?.linkOwnerId ??
    (typeof attrs.structureLinkOwnerId === 'string' ? attrs.structureLinkOwnerId : undefined);
  const structureLink = useStructureLinkRegistry((state) =>
    state.getLink(stableStructureId, structureLinkOwnerId)
  );
  const interactionKey = attrs.structureBinding?.bindingId ?? stableStructureId;

  const interactionState = useStructure3dStore(
    useShallow((s) => s.interactionState[interactionKey] ?? DEFAULT_INTERACTION_STATE)
  );
  const setHovered = useStructure3dStore((s) => s.setHovered);
  const resetInteractionState = useStructure3dStore((s) => s.resetInteractionState);

  const viewerHeight = attrs.height ?? DEFAULT_HEIGHT;

  const source: Structure3dSource =
    attrs.source ||
    (attrs.pdbId ? 'pdb' : attrs.uniprotId ? 'alphafold' : attrs.url ? 'url' : 'pdb');

  const sourceId = attrs.sourceId || attrs.pdbId || attrs.uniprotId || attrs.url || '';

  const sourceConfig = SOURCE_CONFIGS[source];
  const effectiveView = useMemo(() => structureViewStateFromAttrs(attrs), [attrs]);
  const colorMode = colorModeForStructureView(effectiveView, attrs);
  const showWater = effectiveView.showWater;
  const spin = effectiveView.spin;
  const sideChains = effectiveView.residueVisualization?.sideChains ?? {};
  const activeViewId = effectiveView.activeRecipeId;
  const advancedSettings = advancedSettingsForStructureView(effectiveView);
  const viewRecipes = useMemo(() => availableViewRecipesForStructure(attrs), [attrs]);
  const focusableMembers = attrs.scene?.members ?? [];

  useNativeChainVisibility(plugin, isLoaded, effectiveView.hiddenChainInstanceIds);
  const structureData = useSequenceData(
    plugin,
    colorMode,
    isLoaded,
    attrs.molViewSpec,
    !!attrs.comparisonProvenance
  );
  const sequenceData = structureData?.chains ?? null;
  const chainColoring = useMemo(
    () => (sequenceData?.length ? createStructureChainColoring(sequenceData) : undefined),
    [sequenceData]
  );
  const scopedSequenceData = useMemo(
    () => filterSequenceDataForScopes(sequenceData, attrs),
    [sequenceData, attrs]
  );
  const polymerResidueDisplays = useMemo(() => {
    if (!sequenceData?.length || !structureLink?.translation) return undefined;
    return polymerResidueDisplayProjectionsFromExtractedQueryChains(
      attrs,
      sequenceData,
      structureLink.translation,
      {
        expectedSourceDigestSha256: attrs.structureBinding?.polymerRevision.sequenceDigestSha256,
      }
    );
  }, [attrs, sequenceData, structureLink?.translation]);
  const renderModel = useMemo(
    () =>
      scopedSequenceData?.length
        ? createStructureRenderModel({
            chains: scopedSequenceData,
            scene: attrs.scene,
            view: effectiveView,
            chainColoring,
          })
        : undefined,
    [scopedSequenceData, attrs.scene, effectiveView, chainColoring]
  );
  const ligandData = useMemo(
    () => filterLigandsForScopes(structureData?.ligands ?? [], attrs),
    [structureData?.ligands, attrs]
  );
  const scopedInteractionState = useMemo(
    () => filterInteractionStateForScopes(interactionState, attrs),
    [interactionState?.hovered, interactionState?.selected, attrs]
  );
  const notebookContext = useOptionalReferenceContext();
  const workspaceRoot = useMemo(
    () => resolveStructureWorkspaceRoot(workspaceFolders, attrs, notebookContext?.owningRoot),
    [workspaceFolders, attrs, notebookContext?.owningRoot]
  );
  const durableSelections = useSavedSelectionProjections(
    workspaceFolders,
    attrs.savedSelectionRefs,
    attrs.structureArtifactRef
  );
  const mergedHighlightGroups = useMemo(
    () => [...(attrs.highlightGroups ?? []), ...durableSelections.groups],
    [attrs.highlightGroups, durableSelections.groups]
  );
  const activeHighlightGroups = useMemo(() => {
    const durableIds = new Set((attrs.savedSelectionRefs ?? []).map((ref) => ref.selectionId));
    return mergedHighlightGroups.filter((group) => !durableIds.has(group.id));
  }, [attrs.savedSelectionRefs, mergedHighlightGroups]);
  const scopedHighlightGroups = useMemo(
    () =>
      filterHighlightGroupsForScopes(activeHighlightGroups, scopedSequenceData, attrs, ligandData),
    [activeHighlightGroups, scopedSequenceData, attrs, ligandData]
  );

  const hoveredResidueName3 = useHoveredResidueName(
    scopedInteractionState.hovered,
    scopedSequenceData
  );

  useResidueHighlight(plugin, scopedInteractionState, isLoaded, scopedHighlightGroups);
  useSelectionSideChainOverlay(
    plugin,
    scopedInteractionState.selected,
    isLoaded && sideChains.selection === true
  );

  const updateAttrs = useCallback(
    (updates: Partial<Structure3dAttrs>) => {
      const nextAttrs = { ...attrsRef.current, ...updates };
      attrsRef.current = nextAttrs;
      onUpdateAttrs(nextAttrs);
    },
    [onUpdateAttrs]
  );
  const getLatestAttrs = useCallback(() => attrsRef.current, []);

  const {
    handleSaveSelection,
    handleActivateHighlight,
    handleTargetHighlight,
    handleDeleteHighlight,
    handleRenameHighlight,
  } = useHighlightActions({
    highlightGroups: mergedHighlightGroups,
    plugin,
    structureId: stableStructureId,
    interactionKey,
    updateAttrs,
    attrs,
    chains: sequenceData ?? [],
    workspaceRoot,
    savedSelectionRefs: attrs.savedSelectionRefs,
  });

  const {
    handleSelectRecipe,
    handleColorModeChange,
    handleShowWaterChange,
    handleSpinChange,
    handleAdvancedSettingsChange,
    handleToggleDetailMember,
    handleToggleDetailChain,
    handleToggleChainVisibility,
    handleVisibleBackboneSideChainsChange,
  } = useViewerSettings({ attrs, getLatestAttrs, updateAttrs });

  const { handleResidueSelect, handleResiduesSelect } = useSavedSelectionEdit({
    highlightGroups: attrs.highlightGroups,
    structureId: interactionKey,
    updateAttrs,
  });
  const handleScopedResidueSelect = useCallback(
    (
      residue: ResidueLocation,
      gesture: StructureSelectionGesture,
      orderedResidues?: ReadonlyArray<ResidueLocation>
    ) => {
      const scopedResidue = scopedResidueOrNull(residue, attrsRef.current);
      if (!scopedResidue) return;
      const sourceInventory =
        orderedResidues ??
        (gesture === 'range'
          ? scopedSequenceData
              ?.filter((chain) => chain.chainId === residue.chain)
              .flatMap((chain) => residueLocationsForChain(chain))
          : undefined);
      const scopedInventory = sourceInventory
        ?.map((candidate) => scopedResidueOrNull(candidate, attrsRef.current))
        .filter((candidate): candidate is ResidueLocation => candidate !== null);
      if (scopedInventory) {
        handleResidueSelect(scopedResidue, gesture, scopedInventory);
      } else {
        handleResidueSelect(scopedResidue, gesture);
      }
    },
    [handleResidueSelect, scopedSequenceData]
  );
  const handleScopedResiduesSelect = useCallback(
    (residues: ReadonlyArray<ResidueLocation>, gesture: StructureSelectionGesture) => {
      const scopedResidues = residues
        .map((residue) => scopedResidueOrNull(residue, attrsRef.current))
        .filter((residue): residue is ResidueLocation => residue !== null);
      if (scopedResidues.length === 0) return;
      handleResiduesSelect(scopedResidues, gesture);
    },
    [handleResiduesSelect]
  );

  const rawHandleFocusClick = useFocusClick(plugin);
  const handleFocusClick: typeof rawHandleFocusClick = rawHandleFocusClick;

  const {
    handleClearSelection,
    handleClearUserSelection,
    handleCenterSelection,
    createContextCenterHandler,
  } = useSelectionActions({
    plugin,
    structureId: interactionKey,
    selectedResidues: scopedInteractionState.selected,
    highlightGroups: scopedHighlightGroups,
  });

  const molstarProps = useMemo(
    () => getMolstarPropsFromAttrs(source, attrs),
    [
      source,
      attrs.sourceId,
      attrs.providerIdentityKey,
      attrs.pdbId,
      attrs.pdbEntityId,
      attrs.labelAsymIds,
      attrs.authAsymIds,
      attrs.assemblyId,
      attrs.uniprotId,
      attrs.accession,
      attrs.fragment,
      attrs.version,
      attrs.modelId,
      attrs.url,
      attrs.scene,
    ]
  );
  const viewerSourceKey = useMemo(() => structureSourceIdentityKey(attrs), [attrs]);
  const previousViewerSourceKeyRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const previousViewerSourceKey = previousViewerSourceKeyRef.current;
    if (previousViewerSourceKey === viewerSourceKey) return;
    previousViewerSourceKeyRef.current = viewerSourceKey;
    setIsLoaded(false);
    setPlugin(null);
    if (previousViewerSourceKey !== null && previousViewerSourceKey !== viewerSourceKey) {
      resetInteractionState(interactionKey);
    }
  }, [interactionKey, viewerSourceKey, resetInteractionState]);

  const displayLabel = userEntityLabel(
    stripDisplayExtension(attrs.label || attrs.name || userEntityLabel(sourceId))
  );
  const title =
    attrs.title && stripDisplayExtension(attrs.title) !== displayLabel
      ? stripDisplayExtension(attrs.title)
      : undefined;
  const organism = attrs.organism;
  const description = attrs.description;
  const resolutionValue = attrs.resolution;
  const methodValue = attrs.method;

  const tooltipLines: string[] = [];
  if (title) tooltipLines.push(title);
  if (organism) tooltipLines.push(`Organism: ${organism}`);
  if (resolutionValue) tooltipLines.push(`Resolution: ${resolutionValue.toFixed(2)} Å`);
  if (methodValue) tooltipLines.push(`Method: ${methodValue}`);
  if (description) tooltipLines.push(`\n${description}`);
  const tooltipContent = tooltipLines.join('\n');

  const handleError = useCallback(
    (errorMessage: string) => {
      const displayError =
        formatMolstarViewerDisplayError(errorMessage) ??
        '3D structure rendering failed. Check diagnostics for details.';
      setError(toUserMessage(displayError, 'structure.failed'));
      onUpdateAttrs({ ...attrs, error: toUserMessage(displayError, 'structure.failed') });
    },
    [attrs, onUpdateAttrs]
  );

  const handleLoad = useCallback(() => {
    setIsLoaded(true);
    setError(null);
    if (attrs.error) {
      onUpdateAttrs({ ...attrs, error: undefined });
    }
  }, [attrs, onUpdateAttrs]);

  const handleRetry = useCallback(() => {
    setError(null);
    onReset?.();
  }, [onReset]);

  const handleCameraChange = useCallback(
    (snapshot: string) => {
      const latestAttrs =
        useStructure3dStore.getState().expandedStructures[stableStructureId]?.data ??
        attrsRef.current;
      if (latestAttrs.molViewSpec) return;
      onUpdateAttrs({
        ...latestAttrs,
        cameraSnapshot: snapshot,
        view: { ...structureViewStateFromAttrs(latestAttrs), cameraSnapshot: snapshot },
      });
    },
    [stableStructureId, onUpdateAttrs]
  );

  const handlePluginReady = useCallback((p: unknown) => {
    setPlugin(p as MolstarPlugin);
  }, []);

  const flushPendingHoverUpdate = useCallback(() => {
    const pending = pendingHoverUpdateRef.current;
    if (!pending) return;
    pendingHoverUpdateRef.current = null;
    const flushedAt = performance.now();
    const setStartedAt = performance.now();
    startTransition(() => {
      setHovered(interactionKey, pending.residue);
    });
    const setEndedAt = performance.now();
    recordHoverStateDiagnostic(
      pending.residue,
      pending.scheduledAt,
      pending.lastUpdatedAt,
      flushedAt,
      setStartedAt,
      setEndedAt
    );
  }, [interactionKey, setHovered]);

  const handleResidueHover = useCallback(
    (residue: ResidueLocation | null) => {
      const scopedResidue = scopedResidueOrNull(residue, attrsRef.current);

      const now = performance.now();
      const pending = pendingHoverUpdateRef.current;
      if (pending) {
        pending.residue = scopedResidue;
        pending.lastUpdatedAt = now;
        return;
      }

      const nextPending: PendingHoverUpdate = {
        residue: scopedResidue,
        scheduledAt: now,
        lastUpdatedAt: now,
        frameId: null,
        timeoutId: null,
      };
      pendingHoverUpdateRef.current = nextPending;

      nextPending.frameId = window.requestAnimationFrame(() => {
        nextPending.frameId = null;
        nextPending.timeoutId = window.setTimeout(() => {
          nextPending.timeoutId = null;
          flushPendingHoverUpdate();
        }, 0);
      });
    },
    [flushPendingHoverUpdate]
  );

  useEffect(() => {
    return () => {
      const pending = pendingHoverUpdateRef.current;
      if (!pending) return;
      if (pending.frameId !== null) {
        window.cancelAnimationFrame(pending.frameId);
      }
      if (pending.timeoutId !== null) {
        window.clearTimeout(pending.timeoutId);
      }
      pendingHoverUpdateRef.current = null;
    };
  }, []);

  const handleFocusMemberChange = useCallback(
    (memberId: string) => {
      const scene = attrsRef.current.scene;
      if (!scene) return;
      const nextScene = focusStructureSceneMember(scene, memberId);
      if (nextScene === scene) return;
      onUpdateAttrs({ ...attrsRef.current, scene: nextScene });
    },
    [onUpdateAttrs]
  );

  useEffect(() => {
    const promoted = promoteScopedPdbSceneFromChains(attrsRef.current, sequenceData);
    if (!promoted) return;
    onUpdateAttrs(promoted);
  }, [sequenceData, attrs.sourceId, attrs.providerIdentityKey, attrs.scene, onUpdateAttrs]);

  const canonicalContextResidue = useCallback(
    (residue: ResidueLocation | null | undefined): ResidueLocation | null => {
      const scopedResidue = scopedResidueOrNull(residue ?? null, attrsRef.current);
      if (!scopedResidue) return null;
      return structureLink
        ? (canonicalResidueLocationForStructureLink(structureLink, scopedResidue) ?? scopedResidue)
        : scopedResidue;
    },
    [structureLink]
  );

  const openContextMenu = useCallback(
    (
      position: { x: number; y: number },
      explicitTarget: ResidueLocation | null | undefined,
      materializeTarget: boolean
    ) => {
      const target = canonicalContextResidue(explicitTarget);
      const liveSelection = filterInteractionStateForScopes(
        useStructure3dStore.getState().interactionState[interactionKey],
        attrsRef.current
      ).selected;
      if (materializeTarget && liveSelection.length === 0 && target) {
        handleScopedResidueSelect(target, 'replace');
      }
      setContextMenuPos(position);
      setContextMenuTarget(target);
    },
    [canonicalContextResidue, handleScopedResidueSelect, interactionKey]
  );

  const handleRightClick = useCallback(
    (position: { x: number; y: number; target: EventTarget | null }) => {
      const target = residueAtMolstarCanvasPoint(plugin, position.target, position.x, position.y);
      openContextMenu({ x: position.x, y: position.y }, target, true);
    },
    [openContextMenu, plugin]
  );

  const handleViewerContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const element = event.target instanceof Element ? event.target : null;
      if (element?.closest('[data-testid="structure-context-menu"]')) return;
      event.preventDefault();
      event.stopPropagation();
      if (element?.tagName === 'CANVAS') return;
      openContextMenu(
        { x: event.clientX, y: event.clientY },
        residueFromContextMenuTarget(event.target),
        true
      );
    },
    [openContextMenu]
  );

  const handleCloseContextMenu = useCallback(() => {
    setContextMenuPos(null);
    setContextMenuTarget(null);
  }, []);

  const handleContextCenterSelection = createContextCenterHandler(contextMenuTarget);

  const askAiResidues = useMemo<ResidueLocation[]>(
    () => scopedInteractionState.selected,
    [scopedInteractionState.selected]
  );
  const askAiInput = useMemo(
    () =>
      buildStructureAskAiSelectionInput({
        structureId: stableStructureId,
        data: attrs,
        structureLink,
        residues: askAiResidues,
        chains: scopedSequenceData,
        view: effectiveView,
      }),
    [askAiResidues, attrs, effectiveView, scopedSequenceData, stableStructureId, structureLink]
  );
  const agentPrompt = useStructureAgentPrompt({
    rootRef: containerRef,
    structureViewId: stableStructureId,
    attrs,
    selectionInput: askAiInput,
    selectedCount: scopedInteractionState.selected.length,
    workspaceRoot,
    enabled: isLoaded,
  });
  useResetSelectionOnViewChange(
    attrs.molViewSpec,
    attrs.molViewSpecSnapshotIndex,
    activeViewId,
    stableStructureId,
    handleClearUserSelection,
    isLoaded
  );

  const handleAskAI = useCallback(() => {
    if (!askAiInput) return;
    void agentPrompt.ask();
  }, [askAiInput, agentPrompt.ask]);

  const clickHandlers = useClickDetection({
    onRightClick: handleRightClick,
    onBlankPrimaryCanvasClick: handleClearSelection,
    classifyPrimaryCanvasClick: ({ target, clientX, clientY }) =>
      classifyMolstarCanvasPoint(plugin, target, clientX, clientY),
    hasHoveredResidue: !!scopedInteractionState.hovered,
    getHasHoveredResidue: () =>
      !!filterInteractionStateForScopes(
        useStructure3dStore.getState().interactionState[interactionKey],
        attrsRef.current
      ).hovered,
  });

  useMolstarInteraction(
    plugin,
    {
      onHover: handleResidueHover,
      onClick: handleScopedResidueSelect,
      onFocusClick: handleFocusClick,
      shouldHandleResidue: (residue) => chainMatchesScopes(residue, attrsRef.current),
    },
    isLoaded
  );

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      const startY = e.clientY;
      const startHeight = viewerHeight;

      const handleMouseMove = (e: MouseEvent) => {
        const delta = e.clientY - startY;
        const newHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeight + delta));
        onUpdateAttrs({ ...attrsRef.current, height: newHeight });
      };

      const handleMouseUp = () => {
        setIsResizing(false);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        resizeCleanupRef.current = null;
      };

      resizeCleanupRef.current = () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [viewerHeight, onUpdateAttrs]
  );

  useEffect(() => {
    return () => {
      if (resizeCleanupRef.current) {
        resizeCleanupRef.current();
        resizeCleanupRef.current = null;
      }
    };
  }, []);

  const sequence: SequenceViewerProps = {
    chains: scopedSequenceData ?? [],
    sequenceStatus: error
      ? 'unavailable'
      : !structureData
        ? isLoaded
          ? 'unavailable'
          : 'loading'
        : undefined,
    polymerResidueDisplays,
    ligands: ligandData,
    colorMode,
    chainColoring,
    renderModel,
    scene: attrs.scene,
    view: effectiveView,
    onToggleDetailMember: handleToggleDetailMember,
    onToggleDetailChain: handleToggleDetailChain,
    onToggleChainVisibility: handleToggleChainVisibility,
    interactionState: scopedInteractionState,
    highlightGroups: scopedHighlightGroups,
    onHover: handleResidueHover,
    onSelect: handleScopedResidueSelect,
    onSelectChain: handleScopedResiduesSelect,
  };

  if (error) {
    return (
      <StructureViewerFrame
        sequence={sequence}
        sequenceKey={viewerSourceKey}
        className="relative select-none"
        ref={containerRef}
        data-structure-agent-host={stableStructureId}
      >
        <div className="min-h-[120px] flex flex-col items-center justify-center gap-3 p-4 bg-error/5 rounded-md">
          <div className="text-sm text-error">{toUserMessage(error, 'structure.failed')}</div>
          <div className="flex gap-2">
            <button
              onClick={handleRetry}
              className="px-3 py-1.5 text-xs bg-bg-subtle border border-border rounded hover:bg-bg-muted transition-colors"
            >
              Try different ID
            </button>
          </div>
        </div>
      </StructureViewerFrame>
    );
  }

  return (
    <StructureViewerFrame
      sequence={sequence}
      sequenceKey={viewerSourceKey}
      header={
        <>
          {}
          <div className="flex items-center justify-between gap-2 text-sm mb-1">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span
                className={`px-2 py-0.5 rounded text-xs font-medium shrink-0 ${sourceConfig.badgeColor}`}
              >
                View
              </span>
              <span className="text-fg-muted font-mono text-xs shrink-0">{displayLabel}</span>
              {title && (
                <span className="text-xs text-fg cursor-help" title={tooltipContent}>
                  {title}
                </span>
              )}
              {organism && !title && <span className="text-xs text-fg-muted">{organism}</span>}
            </div>
            <button
              onClick={handleRetry}
              className="text-xs text-fg-muted hover:text-fg transition-colors shrink-0"
              title="Change structure"
            >
              Edit
            </button>
          </div>
        </>
      }
      className="relative select-none"
      ref={containerRef}
      data-structure-agent-host={stableStructureId}
      onContextMenuCapture={handleViewerContextMenu}
    >
      {}
      <MolecularViewWorkspace>
        {}
        <div
          data-molecular-view-viewport
          className="min-w-0 flex-1 rounded-md overflow-hidden bg-bg-muted relative"
          style={{ height: viewerHeight }}
          {...clickHandlers}
        >
          <LazyMolstarViewer
            molViewSpec={presentationAttrs.molViewSpec}
            molViewSpecAssets={presentationAttrs.molViewSpecAssets}
            molViewSpecSnapshotIndex={presentationAttrs.molViewSpecSnapshotIndex}
            molViewSpecSelectionRevision={storySelectionRevision}
            key={viewerSourceKey}
            {...molstarProps}
            deferWhileScrolling
            viewerInstanceId={structureId ? `embed:${structureId}` : undefined}
            height={viewerHeight}
            view={effectiveView}
            scene={attrs.scene}
            chainColoring={chainColoring}
            renderModel={renderModel}
            sourceColorContext={attrs}
            cameraSnapshot={attrs.cameraSnapshot}
            onCameraChange={handleCameraChange}
            onError={handleError}
            onLoad={handleLoad}
            onPluginReady={handlePluginReady}
          />
          {}
          <HoverTooltip
            hovered={scopedInteractionState.hovered}
            residueName3={hoveredResidueName3}
          />
          <StructureViewerOverlayControls
            interactionState={scopedInteractionState}
            colorKeys={colorKeysForThemes(structureData?.colorLegends ?? [], attrs)}
            highlightGroups={mergedHighlightGroups}
            selectionLoadErrors={durableSelections.errors}
            onActivateSelection={handleActivateHighlight}
            onTargetSavedSelection={handleTargetHighlight}
            onRenameSelection={handleRenameHighlight}
            onDeleteSelection={handleDeleteHighlight}
            onSaveSelection={handleSaveSelection}
            onClearSelection={handleClearSelection}
            onCenterSelection={handleCenterSelection}
            isSettingsOpen={isAdvancedOpen}
            settingsTriggerRef={settingsTriggerRef}
            onToggleSettings={() => setIsAdvancedOpen(!isAdvancedOpen)}
            onAskAgent={() => void agentPrompt.ask()}
            presentationControls={
              <MolecularPresentationControls
                structureId={stableStructureId}
                attrs={presentationAttrs}
                plugin={plugin}
                ready={isLoaded}
                onSelect={(index) => {
                  handleClearSelection();
                  updateAttrs({
                    molViewSpec: presentationAttrs.molViewSpec,
                    molViewSpecSnapshotIndex: index,
                    cameraSnapshot: undefined,
                  });
                  setStorySelectionRevision((value) => value + 1);
                }}
                onRestore={(reference, view) => {
                  handleClearSelection();
                  updateAttrs({
                    ...molecularViewAttrs(stableStructureId, view, undefined, reference.id),
                    ...(presentationAttrs.molecularViewSnapshot
                      ? { molecularViewSnapshot: view }
                      : {}),
                  });
                  setStorySelectionRevision((value) => value + 1);
                }}
              />
            }
            agentDisabled={!isLoaded}
            agentBusy={agentPrompt.busy}
            agentError={agentPrompt.error}
          />
          {}
          <AdvancedSettingsDrawer
            returnFocusTarget={settingsTriggerRef.current}
            isOpen={isAdvancedOpen}
            onClose={() => setIsAdvancedOpen(false)}
            settings={advancedSettings}
            onSettingsChange={handleAdvancedSettingsChange}
            framingDisabled={!isLoaded || !plugin}
            onUseCurrentFraming={
              presentationAttrs.molViewSpec
                ? () => {
                    if (!plugin || !isLoaded) return;
                    const framing = commitCurrentMolViewSpecCamera(plugin);
                    updateAttrs({
                      molViewSpec: framing.scene,
                      molViewSpecSnapshotIndex: framing.initialSnapshotIndex,
                      cameraSnapshot: framing.cameraSnapshot,
                    });
                  }
                : undefined
            }
            primaryControls={
              presentationAttrs.molViewSpec ? (
                <MolViewSpecColorControls
                  plugin={isLoaded ? plugin : null}
                  scene={presentationAttrs.molViewSpec}
                  index={presentationAttrs.molViewSpecSnapshotIndex ?? 0}
                  source={attrs}
                  getLatestAttrs={getLatestAttrs}
                  updateAttrs={updateAttrs}
                />
              ) : (
                <ViewerControls
                  colorMode={colorMode}
                  showWater={showWater}
                  spin={spin}
                  source={attrs}
                  layout="sidebar"
                  activeRecipeId={activeViewId}
                  viewRecipes={viewRecipes}
                  scene={attrs.scene}
                  view={effectiveView}
                  focusableMembers={focusableMembers}
                  highlightGroups={mergedHighlightGroups}
                  selectionLoadErrors={durableSelections.errors}
                  sideChains={sideChains}
                  onColorModeChange={handleColorModeChange}
                  onShowWaterChange={handleShowWaterChange}
                  onSpinChange={handleSpinChange}
                  onVisibleBackboneSideChainsChange={handleVisibleBackboneSideChainsChange}
                  onSelectRecipe={handleSelectRecipe}
                  onFocusMemberChange={handleFocusMemberChange}
                />
              )
            }
          />
          {}
          <ContextMenu
            position={contextMenuPos}
            onClose={handleCloseContextMenu}
            targetResidue={contextMenuTarget}
            selectedResidues={scopedInteractionState.selected}
            onCenterSelection={handleContextCenterSelection}
            onAskAI={askAiInput ? handleAskAI : undefined}
          />
        </div>
      </MolecularViewWorkspace>

      {}
      <div
        className={`h-2 cursor-ns-resize flex items-center justify-center group ${
          isResizing ? 'bg-accent/20' : 'hover:bg-bg-muted'
        }`}
        onMouseDown={handleResizeStart}
      >
        <div
          className={`w-8 h-1 rounded-full transition-colors ${
            isResizing ? 'bg-accent' : 'bg-border group-hover:bg-fg-muted'
          }`}
        />
      </div>
    </StructureViewerFrame>
  );
}
