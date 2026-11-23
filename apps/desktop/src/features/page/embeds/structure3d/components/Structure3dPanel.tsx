'use client';
import { hasStructureCodingBounds } from '../../../../structure-drawer/public/state/use-structure-link-registry';

import {
  useCallback,
  useState,
  useLayoutEffect,
  useEffect,
  useRef,
  useMemo,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { matchesShortcut } from '@waypoint/ui-components/keyboard';
import { safeFocus } from '../../../../../shared/utils/safeFocus';
import { useStructure3dStore, DEFAULT_INTERACTION_STATE } from '../store';
import {
  useHoveredResidueStore,
  type HoveredResidueKey,
} from '../../../../structure-drawer/public/state/hovered-residue-store';
import {
  getWorkspaceResidueSelectionsStore,
  getWorkspaceResidueSelectionsStoreVersion,
  subscribeWorkspaceResidueSelectionsStores,
} from '../../../../structure-drawer/public/state/selected-codon-registry';
import {
  useHoveredCodonStore,
  useResidueSelectionsStore,
  type HoveredCodonKey,
  type ResidueSelection,
} from '@waypoint/workspace-editor';
import { useStructureLinkRegistry } from '../../../../structure-drawer/public/state/use-structure-link-registry';
import { useStructureResidueSessionRegistry } from '../../../../structure-drawer/public/state/structure-residue-session-registry';
import { useSyncExternalStore } from 'react';
import {
  createDeferredStructureHoverSync,
  decideOutboundWrite,
  decideInboundDispatch,
  type InboundHoverOwner,
  shouldClearInboundHover,
  isInboundHoverProjection,
  shouldClearOnUnmount,
} from '../hooks/residue-hover-bridge';
import { useShallow } from 'zustand/react/shallow';
import { LazyMolstarViewer } from '../LazyMolstarViewer';
import type { SequenceViewerProps } from './SequenceViewer';
import { StructureViewerFrame } from './StructureViewerFrame';
import { useStructureColorLegend } from '../hooks/useStructureColorLegend';
import { useNativeChainVisibility } from '../hooks/useNativeChainVisibility';
import { residueLocationsForChain } from './SequenceTrack';
import { HoverTooltip } from './HoverTooltip';
import { ViewerControls } from './ViewerControls';
import { AdvancedSettingsDrawer } from './AdvancedSettingsDrawer';
import { useAdvancedSettingsDrawerState } from '../advancedSettingsDrawerState';
import { ContextMenu } from './ContextMenu';
import { StructureViewerOverlayControls } from './StructureViewerOverlayControls';
import {
  useSequenceData,
  useStructureAgentPrompt,
  useResetSelectionOnViewChange,
  useStructureReferenceTarget,
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
import type {
  Structure3dAttrs,
  Structure3dSource,
  ResidueLocation,
  HighlightGroup,
  StructureSelectionGesture,
} from '../types';
import { SOURCE_CONFIGS, createStructureChainColoring } from '../types';
import { getMolstarPropsFromAttrs } from '../utils/molstarPropsUtils';
import { promoteScopedPdbSceneFromChains } from '../utils/scopedPdbSceneUpgrade';
import { createStructureRenderModel } from '../utils/structureRenderModel';
import { availableViewRecipesForStructure } from '../utils/viewRecipeAvailability';
import { focusStructureSceneMember } from '../utils/structureScene';
import {
  applyStructureSelectionIntentToResidueSelections,
  canonicalResidueLocationForStructureLink,
  codingDnaRangeForStructureResidue,
  residueLocationsKey,
  residueSelectionsToStructureResidues,
  sameResidueLocations,
} from '../utils/residueSelectionBridge';
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
import { residueTargetsFromExtractedQueryChains } from '../utils/structureLinkTargets';
import { polymerResidueDisplayProjectionsFromExtractedQueryChains } from '../utils/polymerResidueDisplay';
import { residueFromContextMenuTarget } from '../utils/contextMenuResidue';
import { buildStructureAskAiSelectionInput } from '../utils/structureAskAiInput';
import type { MolstarPlugin } from '../molstar';
import { resolveStructureWorkspaceRoot } from '../utils/savedSelectionPersistence';
import {
  structureHeaderText,
  structureKeyOverrideForAttrs,
  structureSourceIdentityKey,
} from '../utils/structureSourceIdentity';
import { useWorkspaceStore } from '../../../../../stores/workspaceStore';
import { MeasurementLegend } from './MeasurementLegend';
import { MolecularDataControls } from './MolecularDataControls';
import { MolViewSpecColorControls } from './MolViewSpecColorControls';
import { ViewRecipeDropdown } from './ViewRecipeDropdown';
import { useProteinExtensionView } from '../hooks/useProteinExtensionView';
import { MolecularPresentationControls } from './MolecularPresentationControls';
import { commitCurrentMolViewSpecCamera } from '../molstar/molViewSpec';
import { MolecularViewWorkspace } from './MolecularViewWorkspace';
import { molecularViewAttrs } from '../utils/molecularView';

const EMPTY_RESIDUE_SELECTIONS: ReadonlyArray<ResidueSelection> = Object.freeze([]);
const EMPTY_RESIDUE_SELECTIONS_SNAPSHOT = () => EMPTY_RESIDUE_SELECTIONS;

export interface Structure3dPanelProps {
  structureId: string;

  structureViewId?: string;

  bindingId?: string;

  initialStructureAttrs?: Structure3dAttrs;

  structureData?: string | Uint8Array;

  structureDataFormat?: 'pdb' | 'mmcif';

  extraHighlightGroups?: ReadonlyArray<HighlightGroup>;

  onError?: (message: string) => void;

  onSlowLoad?: () => void;

  onLoad?: () => void | Promise<void>;

  loadRequestKey?: string;

  viewerInstanceId?: string;

  rendererHostId?: string;

  structureLinkOwnerId?: string;

  hideStructureHeader?: boolean;

  headerAccessory?: ReactNode;

  navigationAccessory?: ReactNode;
}

export function Structure3dPanel({
  structureId,
  structureViewId,
  bindingId,
  initialStructureAttrs,
  structureData: coordinateData,
  structureDataFormat,
  extraHighlightGroups,
  onError,
  onSlowLoad,
  onLoad,
  loadRequestKey,
  viewerInstanceId,
  rendererHostId,
  structureLinkOwnerId,
  hideStructureHeader = false,
  headerAccessory,
  navigationAccessory,
}: Structure3dPanelProps) {
  const registrationId = structureViewId ?? structureId;
  const agentRootRef = useRef<HTMLDivElement>(null);
  const viewerContainerRef = useRef<HTMLDivElement>(null);
  const structure = useStructure3dStore((state) => state.expandedStructures[registrationId]);
  const updateStructureData = useStructure3dStore((state) => state.updateStructureData);
  const workspaceFolders = useWorkspaceStore((state) => state.folders);

  useLayoutEffect(() => {
    if (!initialStructureAttrs) return;
    const structureStore = useStructure3dStore.getState();
    if (structureStore.expandedStructures[registrationId]) return;
    structureStore.registerStructure(
      registrationId,
      initialStructureAttrs,
      initialStructureAttrs.label ?? structureId
    );
  }, [initialStructureAttrs, registrationId, structureId]);

  const [retryCount, setRetryCount] = useState(0);
  useEffect(() => {
    if (!structure && retryCount < 3) {
      const timer = setTimeout(() => setRetryCount((c) => c + 1), 100);
      return () => clearTimeout(timer);
    }
  }, [structure, retryCount]);

  const interactionKey =
    bindingId ??
    initialStructureAttrs?.structureBinding?.bindingId ??
    structure?.data.structureBinding?.bindingId ??
    structureId;
  const interactionState = useStructure3dStore(
    useShallow((state) => state.interactionState[interactionKey] ?? DEFAULT_INTERACTION_STATE)
  );
  const setHovered = useStructure3dStore((state) => state.setHovered);
  const setSelected = useStructure3dStore((state) => state.setSelected);
  const resetInteractionState = useStructure3dStore((state) => state.resetInteractionState);
  const [plugin, setPlugin] = useState<MolstarPlugin | null>(null);
  const [storySelectionRevision, setStorySelectionRevision] = useState(0);
  const [isLoaded, setIsLoaded] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);

  const [contextMenuTarget, setContextMenuTarget] = useState<ResidueLocation | null>(null);
  const [localAdvancedOpen, setLocalAdvancedOpen] = useState(false);
  const storedAdvancedOpen = useAdvancedSettingsDrawerState((state) =>
    viewerInstanceId ? Boolean(state.open[viewerInstanceId]) : false
  );
  const isAdvancedOpen = viewerInstanceId ? storedAdvancedOpen : localAdvancedOpen;
  const setIsAdvancedOpen = useCallback(
    (open: boolean) => {
      if (viewerInstanceId)
        useAdvancedSettingsDrawerState.getState().setOpen(viewerInstanceId, open);
      else setLocalAdvancedOpen(open);
    },
    [viewerInstanceId]
  );
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);

  const structureDataRef = useRef<Structure3dAttrs | undefined>(structure?.data);
  structureDataRef.current = structure?.data;

  const currentData = structure?.data;

  const effectiveStructureLinkOwnerId =
    structureLinkOwnerId ?? stringAttr(currentData?.structureLinkOwnerId);
  const effectiveView = useMemo(
    () => (currentData ? structureViewStateFromAttrs(currentData) : undefined),
    [currentData]
  );
  const colorMode = effectiveView ? colorModeForStructureView(effectiveView, currentData) : 'chain';
  const showWater = effectiveView?.showWater ?? false;
  const spin = effectiveView?.spin ?? false;
  const sideChains = effectiveView?.residueVisualization?.sideChains ?? {};
  const activeViewId = effectiveView?.activeRecipeId ?? null;
  const advancedSettings = effectiveView ? advancedSettingsForStructureView(effectiveView) : {};
  const source = (currentData?.source || 'pdb') as Structure3dSource;
  const molstarProps = useMemo(
    () =>
      coordinateData
        ? {
            structureData: coordinateData,
            structureDataFormat,
            coordinateModel: currentData?.coordinateModel,
          }
        : currentData
          ? getMolstarPropsFromAttrs(source, currentData)
          : {},
    [source, currentData, coordinateData, structureDataFormat]
  );
  const viewRecipes = useMemo(() => availableViewRecipesForStructure(currentData), [currentData]);
  const focusableMembers = currentData?.scene?.members ?? [];
  const liveStructureLink = useStructureLinkRegistry((state) =>
    state.getLink(structureId, effectiveStructureLinkOwnerId)
  );
  const structureLink = liveStructureLink;

  useNativeChainVisibility(plugin, isLoaded, effectiveView?.hiddenChainInstanceIds);
  const structureData = useSequenceData(
    plugin,
    colorMode,
    isLoaded,
    currentData?.molViewSpec,
    !!currentData?.comparisonProvenance
  );
  const {
    namedColorGroups,
    colorLegends,
    colorKeys,
    handleSelectNamedColorGroup,
    handleFocusNamedColorGroup,
  } = useStructureColorLegend({
    plugin,
    isLoaded,
    currentData,
    effectiveView,
    structureData,
    source,
  });
  const sequenceData = structureData?.chains ?? null;
  const chainColoring = useMemo(
    () => (sequenceData?.length ? createStructureChainColoring(sequenceData) : undefined),
    [sequenceData]
  );
  const scopedSequenceData = useMemo(
    () => filterSequenceDataForScopes(sequenceData, currentData),
    [sequenceData, currentData]
  );
  const polymerResidueDisplays = useMemo(() => {
    if (!currentData || !sequenceData?.length || !structureLink?.translation) return undefined;
    return polymerResidueDisplayProjectionsFromExtractedQueryChains(
      currentData,
      sequenceData,
      structureLink.translation,
      {
        expectedSourceDigestSha256:
          currentData.structureBinding?.polymerRevision.sequenceDigestSha256,
      }
    );
  }, [currentData, sequenceData, structureLink?.translation]);
  const renderModel = useMemo(
    () =>
      scopedSequenceData?.length
        ? createStructureRenderModel({
            chains: scopedSequenceData,
            scene: currentData?.scene,
            view: effectiveView,
            chainColoring,
          })
        : undefined,
    [scopedSequenceData, currentData?.scene, effectiveView, chainColoring]
  );
  const ligandData = useMemo(
    () => filterLigandsForScopes(structureData?.ligands ?? [], currentData),
    [structureData?.ligands, currentData]
  );
  const scopedInteractionState = useMemo(
    () => filterInteractionStateForScopes(interactionState, currentData),
    [interactionState, currentData]
  );

  useEffect(() => {
    if (!structureLink || !currentData || !sequenceData?.length) return;
    const activeLink = useStructureLinkRegistry
      .getState()
      .getLink(structureId, effectiveStructureLinkOwnerId);
    if (!activeLink || activeLink.sequenceDocumentId !== structureLink.sequenceDocumentId) return;
    const residueTargets = residueTargetsFromExtractedQueryChains(
      currentData,
      sequenceData,
      activeLink.translation
    );
    if (residueTargets.length === 0) return;
    const updatedLink = {
      ...activeLink,
      residueTarget: residueTargets[0],
      residueTargets,
    };
    useStructureLinkRegistry.getState().registerLink(updatedLink);
    useStructureResidueSessionRegistry
      .getState()
      .refreshSessionLink(structureId, activeLink.ownerId, updatedLink);
  }, [currentData, sequenceData, structureId, structureLink, effectiveStructureLinkOwnerId]);

  const hoveredResidueName3 = useHoveredResidueName(
    scopedInteractionState.hovered,
    scopedSequenceData
  );

  const workspaceRoot = useMemo(
    () => (currentData ? resolveStructureWorkspaceRoot(workspaceFolders, currentData) : null),
    [workspaceFolders, currentData]
  );
  const durableSelections = useSavedSelectionProjections(
    workspaceFolders,
    currentData?.savedSelectionRefs,
    currentData?.structureArtifactRef
  );
  const mergedHighlightGroups = useMemo(
    () => [
      ...(currentData?.highlightGroups ?? []),
      ...durableSelections.groups,
      ...(extraHighlightGroups ?? []),
    ],
    [currentData?.highlightGroups, durableSelections.groups, extraHighlightGroups]
  );
  const activeHighlightGroups = useMemo(() => {
    const durableIds = new Set(
      (currentData?.savedSelectionRefs ?? []).map((ref) => ref.selectionId)
    );
    return mergedHighlightGroups.filter((group) => !durableIds.has(group.id));
  }, [currentData?.savedSelectionRefs, mergedHighlightGroups]);
  const scopedHighlightGroups = useMemo(
    () =>
      filterHighlightGroupsForScopes(
        activeHighlightGroups,
        scopedSequenceData,
        currentData,
        ligandData
      ),
    [activeHighlightGroups, scopedSequenceData, currentData, ligandData]
  );
  useResidueHighlight(plugin, scopedInteractionState, isLoaded, scopedHighlightGroups);
  useSelectionSideChainOverlay(
    plugin,
    scopedInteractionState.selected,
    isLoaded && sideChains.selection === true
  );

  const hoveredResidueCrossStore = useHoveredResidueStore();
  const hoveredResidueCrossSync = useMemo(
    () =>
      hoveredResidueCrossStore
        ? createDeferredStructureHoverSync<HoveredResidueKey>(hoveredResidueCrossStore)
        : null,
    [hoveredResidueCrossStore]
  );
  const lastInboundHoverRef = useRef<InboundHoverOwner | null>(null);
  useEffect(() => () => hoveredResidueCrossSync?.dispose(), [hoveredResidueCrossSync]);

  const hoveredCodonCrossStore = useHoveredCodonStore();
  const hoveredCodonCrossSync = useMemo(
    () =>
      hoveredCodonCrossStore
        ? createDeferredStructureHoverSync<HoveredCodonKey>(hoveredCodonCrossStore)
        : null,
    [hoveredCodonCrossStore]
  );
  useEffect(() => () => hoveredCodonCrossSync?.dispose(), [hoveredCodonCrossSync]);

  const publishPointerHover = useCallback(
    (hovered: ResidueLocation | null | undefined) => {
      const residue = decideOutboundWrite(hovered, structureId);
      const sharedResidue = hoveredResidueCrossStore?.getSnapshot();
      if (residue || !sharedResidue || sharedResidue.structureId === structureId) {
        hoveredResidueCrossSync?.schedule(residue);
      }
      if (!hoveredCodonCrossSync) return;
      let next: HoveredCodonKey | null = null;
      if (residue) {
        const link = structureLink;
        if (!link) {
          hoveredCodonCrossSync.schedule(null);
          return;
        }
        const codingRange = codingDnaRangeForStructureResidue(link, residue);
        if (!codingRange) {
          hoveredCodonCrossSync.schedule(null);
          return;
        }
        next = {
          start: codingRange.start,
          end: codingRange.end,
          strand: codingRange.strand,

          source: 'structure',
        };
      }
      hoveredCodonCrossSync.schedule(next);
    },
    [
      structureId,
      hoveredResidueCrossStore,
      hoveredResidueCrossSync,
      hoveredCodonCrossStore,
      hoveredCodonCrossSync,
      structureLink,
    ]
  );

  useEffect(() => {
    if (
      isInboundHoverProjection(
        structureId,
        scopedInteractionState.hovered,
        lastInboundHoverRef.current
      )
    ) {
      hoveredResidueCrossSync?.dispose();
      hoveredCodonCrossSync?.dispose();
      return;
    }
    publishPointerHover(scopedInteractionState.hovered);
  }, [
    scopedInteractionState.hovered,
    structureId,
    hoveredResidueCrossSync,
    hoveredCodonCrossSync,
    publishPointerHover,
  ]);

  const NOOP_SUBSCRIBE = (): (() => void) => () => {};
  const NULL_SNAPSHOT = (): HoveredResidueKey | null => null;
  const hoveredResidueFromStore = useSyncExternalStore(
    hoveredResidueCrossStore ? hoveredResidueCrossStore.subscribe : NOOP_SUBSCRIBE,
    hoveredResidueCrossStore ? hoveredResidueCrossStore.getSnapshot : NULL_SNAPSHOT
  );
  useEffect(() => {
    const local = useStructure3dStore.getState().interactionState[interactionKey]?.hovered;
    const dispatch = decideInboundDispatch(hoveredResidueFromStore, structureId, local);
    if (dispatch) {
      if (!chainMatchesScopes(dispatch, structureDataRef.current)) {
        setHovered(interactionKey, null);
        return;
      }
      lastInboundHoverRef.current = { structureId, residue: dispatch };
      setHovered(interactionKey, dispatch);
      return;
    }
    if (
      shouldClearInboundHover(
        hoveredResidueFromStore,
        structureId,
        local,
        lastInboundHoverRef.current
      )
    ) {
      lastInboundHoverRef.current = null;
      setHovered(interactionKey, null);
    }
  }, [hoveredResidueFromStore, interactionKey, structureId, setHovered]);

  useEffect(() => {
    return () => {
      if (!hoveredResidueCrossStore) return;
      if (shouldClearOnUnmount(hoveredResidueCrossStore.getSnapshot(), structureId)) {
        hoveredResidueCrossStore.set(null);
      }
    };
  }, [hoveredResidueCrossStore, structureId]);

  useEffect(() => {
    return () => {
      if (!hoveredCodonCrossStore) return;
      const cur = hoveredCodonCrossStore.getSnapshot();
      if (!cur) return;
      const link = useStructureLinkRegistry
        .getState()
        .getLink(structureId, effectiveStructureLinkOwnerId);
      if (!link) return;
      if (
        hasStructureCodingBounds(link) &&
        cur.start >= link.cdsStart &&
        cur.end <= link.cdsEnd &&
        cur.strand === link.strand
      ) {
        hoveredCodonCrossStore.set(null);
      }
    };
  }, [hoveredCodonCrossStore, structureId, effectiveStructureLinkOwnerId]);

  const residueSelectionsContextStore = useResidueSelectionsStore();
  const residueSelectionStoreRegistryVersion = useSyncExternalStore(
    subscribeWorkspaceResidueSelectionsStores,
    getWorkspaceResidueSelectionsStoreVersion
  );
  const residueSelectionsCrossStore = useMemo(() => {
    void residueSelectionStoreRegistryVersion;
    if (residueSelectionsContextStore) return residueSelectionsContextStore;
    if (!structureLink?.sequenceDocumentId) return null;
    return getWorkspaceResidueSelectionsStore(structureLink.sequenceDocumentId);
  }, [
    residueSelectionsContextStore,
    residueSelectionStoreRegistryVersion,
    structureLink?.sequenceDocumentId,
  ]);
  const residueSelectionsFromStore = useSyncExternalStore(
    residueSelectionsCrossStore ? residueSelectionsCrossStore.subscribe : NOOP_SUBSCRIBE,
    residueSelectionsCrossStore
      ? residueSelectionsCrossStore.getSnapshot
      : EMPTY_RESIDUE_SELECTIONS_SNAPSHOT
  );
  const lastInboundSelectionKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!residueSelectionsCrossStore) return;
    if (!structureLink) return;
    const link = useStructureLinkRegistry
      .getState()
      .getLink(structureId, effectiveStructureLinkOwnerId);
    if (!link || link.sequenceDocumentId !== structureLink.sequenceDocumentId) return;
    const nextSelected = residueSelectionsToStructureResidues({
      structureId,
      link,
      selections: residueSelectionsFromStore,
      residueInventory: scopedSequenceData?.flatMap(residueLocationsForChain),
    }).filter((residue) => chainMatchesScopes(residue, structureDataRef.current));
    const nextKey = residueLocationsKey(nextSelected);
    lastInboundSelectionKeyRef.current = nextKey;

    const localSelected =
      useStructure3dStore.getState().interactionState[interactionKey]?.selected ?? [];
    if (sameResidueLocations(localSelected, nextSelected)) return;

    setSelected(interactionKey, nextSelected, nextSelected.length > 0 ? undefined : null);
  }, [
    residueSelectionsCrossStore,
    residueSelectionsFromStore,
    setSelected,
    interactionKey,
    structureId,
    structureLink,
    scopedSequenceData,
    effectiveStructureLinkOwnerId,
  ]);

  useEffect(() => {
    if (!residueSelectionsCrossStore) return;
    if (!structureLink) return;
    const publishSelection = () => {
      const link = useStructureLinkRegistry
        .getState()
        .getLink(structureId, effectiveStructureLinkOwnerId);
      if (!link || link.sequenceDocumentId !== structureLink.sequenceDocumentId) return;
      const currentSelected = filterInteractionStateForScopes(
        useStructure3dStore.getState().interactionState[interactionKey],
        structureDataRef.current
      ).selected;
      if (lastInboundSelectionKeyRef.current === residueLocationsKey(currentSelected)) return;
      const next = applyStructureSelectionIntentToResidueSelections({
        structureId,
        link,
        currentSelections: residueSelectionsCrossStore.getSnapshot(),
        selectedResidues: currentSelected,
      });
      residueSelectionsCrossStore.set(next);
    };
    publishSelection();
    return useStructure3dStore.subscribe((state, previous) => {
      if (
        state.interactionState[interactionKey]?.selected !==
        previous.interactionState[interactionKey]?.selected
      )
        publishSelection();
    });
  }, [
    interactionKey,
    structureId,
    residueSelectionsCrossStore,
    structureLink,
    effectiveStructureLinkOwnerId,
  ]);

  const handleUpdateAttrs = useCallback(
    (attrs: Structure3dAttrs) => {
      updateStructureData(registrationId, attrs);
    },
    [registrationId, updateStructureData]
  );

  useEffect(() => {
    if (!currentData) return;
    const promoted = promoteScopedPdbSceneFromChains(currentData, sequenceData);
    if (!promoted) return;
    handleUpdateAttrs(promoted);
  }, [currentData, sequenceData, handleUpdateAttrs]);

  const updateAttrs = useCallback(
    (updates: Partial<Structure3dAttrs>) => {
      if (structureDataRef.current) {
        const nextAttrs = { ...structureDataRef.current, ...updates };
        structureDataRef.current = nextAttrs;
        handleUpdateAttrs(nextAttrs);
      }
    },
    [handleUpdateAttrs]
  );
  const getLatestStructureAttrs = useCallback(() => structureDataRef.current, []);

  const {
    handleSaveSelection,
    handleActivateHighlight,
    handleTargetHighlight,
    handleDeleteHighlight,
    handleRenameHighlight,
  } = useHighlightActions({
    highlightGroups: mergedHighlightGroups,
    plugin,
    structureId,
    structureViewId: registrationId,
    interactionKey,
    updateAttrs,
    attrs: currentData,
    chains: sequenceData ?? [],
    workspaceRoot,
    savedSelectionRefs: currentData?.savedSelectionRefs,
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
  } = useViewerSettings({
    attrs: structure?.data,
    getLatestAttrs: getLatestStructureAttrs,
    updateAttrs,
  });

  const { handleResidueSelect, handleResiduesSelect } = useSavedSelectionEdit({
    highlightGroups: structure?.data?.highlightGroups,
    structureId: interactionKey,
    updateAttrs,
  });
  const handleScopedResidueSelect = useCallback(
    (
      residue: ResidueLocation,
      gesture: StructureSelectionGesture,
      orderedResidues?: ReadonlyArray<ResidueLocation>
    ) => {
      const scopedResidue = scopedResidueOrNull(residue, structureDataRef.current);
      if (!scopedResidue) return;
      const canonicalResidue = structureLink
        ? (canonicalResidueLocationForStructureLink(structureLink, scopedResidue) ?? scopedResidue)
        : scopedResidue;
      const sourceInventory =
        orderedResidues ??
        (gesture === 'range'
          ? scopedSequenceData
              ?.filter((chain) => chain.chainId === residue.chain)
              .flatMap((chain) => residueLocationsForChain(chain))
          : undefined);
      const canonicalInventory = sourceInventory
        ?.map((candidate) => {
          const scopedCandidate = scopedResidueOrNull(candidate, structureDataRef.current);
          if (!scopedCandidate) return null;
          return structureLink
            ? (canonicalResidueLocationForStructureLink(structureLink, scopedCandidate) ??
                scopedCandidate)
            : scopedCandidate;
        })
        .filter((candidate): candidate is ResidueLocation => candidate !== null);
      if (canonicalInventory) {
        handleResidueSelect(canonicalResidue, gesture, canonicalInventory);
      } else {
        handleResidueSelect(canonicalResidue, gesture);
      }
    },
    [handleResidueSelect, scopedSequenceData, structureLink]
  );
  const handleScopedResiduesSelect = useCallback(
    (residues: ReadonlyArray<ResidueLocation>, gesture: StructureSelectionGesture) => {
      const canonicalResidues = residues
        .map((residue) => {
          const scopedResidue = scopedResidueOrNull(residue, structureDataRef.current);
          if (!scopedResidue) return null;
          return structureLink
            ? (canonicalResidueLocationForStructureLink(structureLink, scopedResidue) ??
                scopedResidue)
            : scopedResidue;
        })
        .filter((residue): residue is ResidueLocation => residue !== null);
      if (canonicalResidues.length === 0) return;
      handleResiduesSelect(canonicalResidues, gesture);
    },
    [handleResiduesSelect, structureLink]
  );

  const rawHandleFocusClick = useFocusClick(plugin);
  const handleFocusClick: typeof rawHandleFocusClick = rawHandleFocusClick;

  const {
    handleClearSelection,
    handleClearUserSelection,
    handleResetCamera,
    handleCenterSelection,
    createContextCenterHandler,
  } = useSelectionActions({
    plugin,
    structureId: interactionKey,
    selectedResidues: scopedInteractionState.selected,
    highlightGroups: scopedHighlightGroups,
  });
  const restoreReferenceView = useCallback(() => {
    handleClearSelection();

    setStorySelectionRevision((value) => value + 1);
  }, [handleClearSelection]);
  useStructureReferenceTarget(
    registrationId,
    plugin,
    isLoaded,
    currentData,
    scopedSequenceData ?? [],
    restoreReferenceView
  );

  const handleStructureKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;

      if (
        target?.closest(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [data-testid="structure-context-menu"]'
        )
      )
        return;
      if (
        target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
      )
        return;
      const selectAll = matchesShortcut(event, ['cmd', 'a']);
      const clear =
        event.key === 'Escape' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey;
      const copy = matchesShortcut(event, ['cmd', 'c']);
      if (!selectAll && !clear && !copy) return;

      event.preventDefault();
      event.stopPropagation();
      if (selectAll) {
        handleScopedResiduesSelect(
          scopedSequenceData?.flatMap(residueLocationsForChain) ?? [],
          'replace'
        );
      } else if (clear) {
        if (contextMenuPos !== null) {
          setContextMenuPos(null);
          setContextMenuTarget(null);
        } else {
          handleClearSelection();
        }
      }
    },
    [handleScopedResiduesSelect, scopedSequenceData, handleClearSelection, contextMenuPos]
  );

  const handleCanvasKeyboardFocus = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !(event.target instanceof HTMLCanvasElement)) return;
    event.currentTarget.dataset.pointerFocus = 'true';
    safeFocus(event.currentTarget, { preventScroll: true });
  }, []);

  const handlePluginReady = useCallback((p: unknown) => {
    setPlugin(p as MolstarPlugin);
  }, []);

  const handleResidueHover = useCallback(
    (residue: ResidueLocation | null) => {
      hoveredResidueCrossSync?.dispose();
      hoveredCodonCrossSync?.dispose();
      lastInboundHoverRef.current = null;
      const scoped = scopedResidueOrNull(residue, structureDataRef.current);

      publishPointerHover(scoped);
      setHovered(interactionKey, scoped);
    },
    [
      interactionKey,
      structureId,
      setHovered,
      publishPointerHover,
      hoveredResidueCrossSync,
      hoveredCodonCrossSync,
    ]
  );

  const handleFocusMemberChange = useCallback(
    (memberId: string) => {
      const data = structureDataRef.current;
      const scene = data?.scene;
      if (!data || !scene) return;
      const nextScene = focusStructureSceneMember(scene, memberId);
      if (nextScene === scene) return;
      handleUpdateAttrs({ ...data, scene: nextScene });
    },
    [handleUpdateAttrs]
  );

  const canonicalContextResidue = useCallback(
    (residue: ResidueLocation | null): ResidueLocation | null => {
      const scopedResidue = scopedResidueOrNull(residue, structureDataRef.current);
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
      const liveInteractionState = filterInteractionStateForScopes(
        useStructure3dStore.getState().interactionState[interactionKey],
        structureDataRef.current
      );

      const target = canonicalContextResidue(
        explicitTarget === undefined ? liveInteractionState.hovered : explicitTarget
      );
      if (materializeTarget && liveInteractionState.selected.length === 0 && target) {
        setSelected(interactionKey, [target], target);
      }
      setContextMenuTarget(target);
      setContextMenuPos(position);
    },
    [canonicalContextResidue, interactionKey, setSelected]
  );

  const handleRightClick = useCallback(
    (position: { x: number; y: number; target: EventTarget | null }) => {
      const canvasResidue = residueAtMolstarCanvasPoint(
        plugin,
        position.target,
        position.x,
        position.y
      );
      openContextMenu({ x: position.x, y: position.y }, canvasResidue, true);
    },
    [openContextMenu, plugin]
  );

  const handlePanelContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const element = event.target instanceof Element ? event.target : null;
      if (element?.closest('[data-testid="structure-context-menu"]')) return;
      event.preventDefault();
      event.stopPropagation();

      if (element?.tagName === 'CANVAS') return;

      const domResidue = residueFromContextMenuTarget(event.target);
      openContextMenu({ x: event.clientX, y: event.clientY }, domResidue ?? null, true);
    },
    [openContextMenu]
  );

  const handleCloseContextMenu = useCallback(() => {
    setContextMenuPos(null);
    setContextMenuTarget(null);
  }, []);

  const handlePanelPrimaryPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button > 0 || contextMenuPos === null) return;
      const element = event.target instanceof Element ? event.target : null;
      if (element?.closest('[data-testid="structure-context-menu"]')) return;
      handleCloseContextMenu();
    },
    [contextMenuPos, handleCloseContextMenu]
  );

  const handleContextCenterSelection = createContextCenterHandler(contextMenuTarget);

  const askAiResidues = useMemo<ResidueLocation[]>(
    () => scopedInteractionState.selected,
    [scopedInteractionState.selected]
  );
  const askAiInput = useMemo(
    () =>
      buildStructureAskAiSelectionInput({
        structureId: registrationId,
        data: structureDataRef.current,
        structureLink,
        residues: askAiResidues,
        chains: scopedSequenceData,
        view: effectiveView,
      }),
    [askAiResidues, effectiveView, scopedSequenceData, registrationId, structureLink]
  );

  const agentPrompt = useStructureAgentPrompt({
    rootRef: agentRootRef,
    structureViewId: registrationId,
    attrs: currentData,
    selectionInput: askAiInput,
    selectedCount: scopedInteractionState.selected.length,
    workspaceRoot,
    enabled: isLoaded,
  });
  useResetSelectionOnViewChange(
    currentData?.molViewSpec,
    currentData?.molViewSpecSnapshotIndex,
    activeViewId,
    registrationId,
    handleClearUserSelection,
    isLoaded
  );

  const handleAskAI = useCallback(() => {
    if (!askAiInput) return;
    void agentPrompt.ask();
  }, [askAiInput, agentPrompt.ask]);

  const handleBlankPrimaryCanvasClick = useCallback(() => {
    handleClearSelection();
    handleResetCamera();
  }, [handleClearSelection, handleResetCamera]);

  const clickHandlers = useClickDetection({
    onRightClick: handleRightClick,
    onBlankPrimaryCanvasClick: handleBlankPrimaryCanvasClick,
    classifyPrimaryCanvasClick: ({ target, clientX, clientY }) =>
      classifyMolstarCanvasPoint(plugin, target, clientX, clientY),
    hasHoveredResidue: !!scopedInteractionState.hovered,
    getHasHoveredResidue: () =>
      !!filterInteractionStateForScopes(
        useStructure3dStore.getState().interactionState[interactionKey],
        structureDataRef.current
      ).hovered,
  });

  const handleLoad = useCallback(() => {
    void (async () => {
      await onLoad?.();
      setIsLoaded(true);
    })().catch((error) => onError?.(error instanceof Error ? error.message : String(error)));
  }, [onLoad, onError]);

  useMolstarInteraction(
    plugin,
    {
      onHover: handleResidueHover,
      onClick: handleScopedResidueSelect,
      onFocusClick: handleFocusClick,
      shouldHandleResidue: (residue) => chainMatchesScopes(residue, structureDataRef.current),
    },
    isLoaded
  );

  const viewerSourceKey = useMemo(
    () => (structure?.data ? structureSourceIdentityKey(structure.data) : ''),
    [structure?.data]
  );
  const proteinExtensions = useProteinExtensionView(
    isLoaded ? plugin : null,
    JSON.stringify([
      workspaceRoot,
      registrationId,
      currentData?.structureArtifactRef?.coordinateDigestSha256,
      viewerSourceKey,
    ])
  );
  const previousViewerSourceKeyRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const previousViewerSourceKey = previousViewerSourceKeyRef.current;
    if (previousViewerSourceKey === viewerSourceKey) return;
    previousViewerSourceKeyRef.current = viewerSourceKey;
    setIsLoaded(false);
    setPlugin(null);
    if (previousViewerSourceKey) {
      resetInteractionState(interactionKey);
    }
  }, [viewerSourceKey, interactionKey, resetInteractionState]);

  const sequence: SequenceViewerProps = {
    chains: structure ? (scopedSequenceData ?? []) : [],
    sequenceStatus: !structure
      ? retryCount < 3
        ? 'loading'
        : 'unavailable'
      : !structureData
        ? isLoaded
          ? 'unavailable'
          : 'loading'
        : undefined,
    polymerResidueDisplays: structure ? polymerResidueDisplays : undefined,
    ligands: structure ? ligandData : undefined,
    colorMode,
    chainColoring: structure ? chainColoring : undefined,
    renderModel: structure ? renderModel : undefined,
    scene: currentData?.scene,
    view: effectiveView,
    onToggleDetailMember: handleToggleDetailMember,
    onToggleDetailChain: handleToggleDetailChain,
    onToggleChainVisibility: handleToggleChainVisibility,
    interactionState: scopedInteractionState,
    highlightGroups: scopedHighlightGroups,
    onHover: handleResidueHover,
    onSelect: handleScopedResidueSelect,
    onSelectChain: handleScopedResiduesSelect,
    onKeyDownCapture: handleStructureKeyDown,
  };

  if (!structure) {
    return (
      <StructureViewerFrame
        sequence={sequence}
        sequenceKey={viewerSourceKey}
        className="h-full flex flex-col bg-bg select-none"
      >
        <div className="flex-1 flex items-center justify-center p-4 text-fg-muted">
          {retryCount < 3 ? (
            <div className="text-sm">Loading structure...</div>
          ) : (
            <div className="text-center">
              <div className="text-4xl mb-2">🔬</div>
              <div className="text-sm">Structure not found</div>
              <div className="text-xs mt-1">The structure may have been removed.</div>
            </div>
          )}
        </div>
      </StructureViewerFrame>
    );
  }

  const { data } = structure;
  const activeMeasurement = data.measurements?.find((item) => item.id === data.activeMeasurementId);
  const activeMolecularDataLayer = data.molecularData?.layers.find(
    (layer) => layer.id === data.molecularData?.activeLayerId
  );
  const sourceConfig = SOURCE_CONFIGS[source];
  const renderedView = effectiveView ?? structureViewStateFromAttrs(data);

  const { label: headerLabel, title: headerTitle } = structureHeaderText(data);
  return (
    <StructureViewerFrame
      sequence={sequence}
      sequenceKey={viewerSourceKey}
      header={
        <>
          {}
          {!hideStructureHeader && (
            <div
              data-testid="structure-3d-panel-header"
              className="flex items-center justify-between px-4 py-1.5 bg-bg"
            >
              <div className="flex items-center gap-3">
                <span
                  className={`px-2 py-0.5 rounded text-xs font-medium ${sourceConfig.badgeColor}`}
                >
                  View
                </span>
                <span className="text-sm font-medium">{headerLabel}</span>
                {headerTitle && <span className="text-xs text-fg-muted">{headerTitle}</span>}
              </div>
              <div className="flex items-center gap-3">
                {data.organism && <span className="text-xs text-fg-muted">{data.organism}</span>}
                {headerAccessory}
              </div>
            </div>
          )}

          {navigationAccessory}
        </>
      }
      ref={agentRootRef}
      data-structure-agent-host={registrationId}
      data-testid="structure-3d-panel"
      data-structure-id={structureId}
      data-render-state={isLoaded ? 'loaded' : 'loading'}
      className="h-full flex flex-col bg-bg select-none"
      onContextMenuCapture={handlePanelContextMenu}
      onPointerDownCapture={handlePanelPrimaryPointerDownCapture}
    >
      {activeMeasurement && (
        <div className="shrink-0 border-t border-border px-3 py-1">
          <MeasurementLegend measurement={activeMeasurement} compact />
        </div>
      )}

      <MolecularViewWorkspace className="flex-1">
        <div
          data-molecular-view-viewport
          className="flex-1 relative min-h-0 min-w-0 outline-none"
          ref={viewerContainerRef}
          data-testid="structure-canvas-focus-surface"
          tabIndex={0}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              delete event.currentTarget.dataset.pointerFocus;
          }}
          onKeyDownCapture={handleStructureKeyDown}
          {...clickHandlers}
          onPointerDownCapture={(event) => {
            handleCanvasKeyboardFocus(event);
            clickHandlers.onPointerDownCapture(event);
          }}
        >
          <LazyMolstarViewer
            key={viewerSourceKey}
            {...molstarProps}
            structureKeyOverride={
              currentData ? structureKeyOverrideForAttrs(currentData) : undefined
            }
            viewerInstanceId={viewerInstanceId ?? `structure-panel:${structureId}`}
            rendererHostId={rendererHostId}
            fillContainer
            view={renderedView}
            molViewSpec={data.molViewSpec}
            molViewSpecAssets={data.molViewSpecAssets}
            molViewSpecSnapshotIndex={data.molViewSpecSnapshotIndex}
            molViewSpecSelectionRevision={storySelectionRevision}
            scene={data.scene}
            chainColoring={chainColoring}
            renderModel={renderModel}
            sourceColorContext={data}
            scrollZoom
            cameraSnapshot={data.cameraSnapshot}
            onCameraChange={(snapshot) => {
              if (data.molViewSpec) return;
              if (
                renderedView.renderIntent === 'preview' ||
                renderedView.activeRecipeId === 'query-in-complex-preview'
              )
                return;

              const latestData =
                useStructure3dStore.getState().expandedStructures[registrationId]?.data ?? data;
              if (latestData.molViewSpec) return;
              const latestView = structureViewStateFromAttrs(latestData);
              handleUpdateAttrs({
                ...latestData,
                cameraSnapshot: snapshot,
                view: { ...latestView, cameraSnapshot: snapshot },
              });
            }}
            onPluginReady={handlePluginReady}
            onLoad={handleLoad}
            loadRequestKey={loadRequestKey}
            onError={onError}
            onSlowLoad={onSlowLoad}
          />

          <HoverTooltip
            hovered={scopedInteractionState.hovered}
            residueName3={hoveredResidueName3}
          />
          <StructureViewerOverlayControls
            interactionState={scopedInteractionState}
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
                structureId={registrationId}
                attrs={data}
                plugin={plugin}
                ready={isLoaded && !proteinExtensions.active && !proteinExtensions.pending}
                extensionActive={Boolean(proteinExtensions.active || proteinExtensions.pending)}
                onSelect={(index) => {
                  handleClearSelection();
                  updateAttrs({ molViewSpecSnapshotIndex: index, cameraSnapshot: undefined });
                  setStorySelectionRevision((value) => value + 1);
                }}
                onRestore={(reference, view) => {
                  handleClearSelection();
                  updateAttrs({
                    ...molecularViewAttrs(registrationId, view, undefined, reference.id),
                    ...(data.molecularViewSnapshot ? { molecularViewSnapshot: view } : {}),
                  });
                  setStorySelectionRevision((value) => value + 1);
                }}
              />
            }
            agentDisabled={!isLoaded}
            agentBusy={agentPrompt.busy}
            agentError={agentPrompt.error}
            legends={colorLegends}
            colorKeys={colorKeys}
            namedGroups={namedColorGroups}
            onSelectNamedGroup={plugin && isLoaded ? handleSelectNamedColorGroup : undefined}
            onFocusNamedGroup={plugin && isLoaded ? handleFocusNamedColorGroup : undefined}
          />

          <AdvancedSettingsDrawer
            returnFocusTarget={settingsTriggerRef.current}
            isOpen={isAdvancedOpen}
            onClose={() => setIsAdvancedOpen(false)}
            settings={advancedSettings}
            onSettingsChange={handleAdvancedSettingsChange}
            framingDisabled={!isLoaded || !plugin}
            onUseCurrentFraming={
              data.molViewSpec
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
              <>
                <MolecularDataControls
                  structureViewId={registrationId}
                  attrs={data}
                  ready={isLoaded}
                />
                {activeMolecularDataLayer ? null : data.molViewSpec ? (
                  <>
                    {proteinExtensions.available && (
                      <ViewRecipeDropdown
                        activeRecipeId="native-scene"
                        activeRecipeNameFallback="Scene"
                        recipes={[]}
                        onSelectRecipe={() => {}}
                        layout="sidebar"
                        extensions={proteinExtensions}
                      />
                    )}
                    <MolViewSpecColorControls
                      plugin={isLoaded ? plugin : null}
                      scene={data.molViewSpec}
                      index={data.molViewSpecSnapshotIndex ?? 0}
                      source={currentData ?? source}
                      getLatestAttrs={getLatestStructureAttrs}
                      updateAttrs={updateAttrs}
                    />
                  </>
                ) : (
                  <ViewerControls
                    proteinExtensions={proteinExtensions.available ? proteinExtensions : undefined}
                    colorMode={colorMode}
                    showWater={showWater}
                    spin={spin}
                    source={currentData ?? source}
                    layout="sidebar"
                    activeRecipeId={activeViewId}
                    viewRecipes={viewRecipes}
                    scene={currentData?.scene}
                    view={renderedView}
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
                )}
              </>
            }
          />

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
    </StructureViewerFrame>
  );
}

function stringAttr(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
