import { toUserMessage } from '@waypoint/user-messages';
import { SavedMolecularStructures } from '../../compute/public/SavedMolecularStructures';
import { inspectionAlleleProvenance } from '../inspection-allele';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { translatedCdsMoleculeIdFromParts } from '@waypoint/workspace-editor';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from 'zustand';
import { LazyStructure3dPanel } from '../../page/public/embeds/structure3d/components/LazyStructure3dPanel';
import { useStructure3dStore } from '../../page/public/embeds/structure3d/store';
import type { Structure3dAttrs } from '../../page/public/embeds/structure3d/types';
import { useStructureRendererHostId } from '../../page/public/embeds/structure3d/agentStructureRenderers';
import { useCanvasStore } from '../../canvas/public/store';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { openSequenceDocument } from '../../document-opening/public/compat';
import { resolveSequenceDocumentById } from '../../sequence/public/sequence-document-repository';
import { useStructureDrawerStore } from '../state/use-structure-drawer-store';
import {
  useStructureLinkRegistry,
  type StructureLinkResidueTarget,
} from '../state/use-structure-link-registry';
import { useStructureResidueSessionRegistry } from '../state/structure-residue-session-registry';
import { StructureVariantContext } from './StructureVariantContext';
import type { ResidueMeasurement } from '../../page/public/embeds/structure3d/residueMeasurement';
import type { MolecularView } from '../../page/public/embeds/structure3d/molecularView';
import {
  inspectionProteinKey,
  openStructureInspection,
  type InspectionViewSettings,
} from '../structure-inspection';
import { ProteinPredictions } from '../../compute/public/ProteinPredictions';
import { loadProteinPrediction } from '../../compute/public/prediction-library';
import { predictionArtifactFromResult } from '../inspection-prediction';
import { StructureDrawerHeader } from './StructureDrawerHeader';
import { StructureCandidatePicker } from './StructureCandidatePicker';
import { NoStructurePlaceholder } from './NoStructurePlaceholder';
import { usePredictStructureStore } from '../../compute/public/predict-structure';
import { initializeInspectionScene } from '../inspection-scene';
import { StructureErrorState } from './StructureErrorState';
import { StructureLargeComplexState } from './StructureLargeComplexState';
import { candidateRowsForResolved, deriveResolvedForStructureCandidateId } from '../api/candidates';
import { resolverResultToStructureAttrs } from '../utils/to-structure-attrs';
import type { ResolverSource } from '../types/structure-drawer';
import { countCandidatesBySource } from './structure-candidate-ui';
import {
  attachStructureViewHandoffDestination,
  beginStructureViewHandoff,
  failStructureViewHandoff,
} from '../state/structure-view-handoff';

const STATUS_COPY: Record<string, string> = {
  idle: '',
  resolving: 'Resolving structure…',
  rendering: 'Loading structure…',
  ready: 'Ready',
  no_match: 'No match',
  error: 'Error',
};

let sourceSequenceNavigationRequestId = 0;

const RESOLUTION_STEP_COPY: Record<ResolverSource, string> = {
  saved_coordinates: 'Opening saved coordinates.',
  computed_coordinates: 'Opening predicted coordinates.',
  pdb_xref: 'Checking annotated PDB cross-references.',
  uniprot_xref: 'Checking UniProt cross-references and AlphaFold DB.',
  protein_sequence: 'Searching by exact protein sequence.',
  rcsb_sequence: 'Searching RCSB by polymer sequence.',
  protein_id: 'Checking NCBI protein identifiers.',
  refseq_xref: 'Checking RefSeq cross-references.',
  geneid_xref: 'Checking NCBI Gene identifiers.',
  locus_tag: 'Checking locus tag and organism matches.',
  gene_sequence_overlap: 'Checking gene sequence overlap.',
  gene_organism: 'Checking gene and organism matches.',
};

export interface StructureDrawerContentProps {
  retainLoadedView?: boolean;
  savedDocument?: import('../../molecular-documents/public/references').MolecularDocumentResolution;
  prediction?: import('../inspection-prediction').InspectionPredictionArtifact;

  store?: typeof useStructureDrawerStore;
  paneHost?: { tabId: string; panelId: string };
  viewSettings?: InspectionViewSettings;
  savedScene?: Pick<
    MolecularView,
    'coordinates' | 'source' | 'scene' | 'initialSnapshotIndex' | 'cameraSnapshot' | 'molecularData'
  >;
  measurements?: ResidueMeasurement[];
  activeMeasurementId?: string;
  onViewSettingsChange?: (candidateId: string | undefined, attrs: Structure3dAttrs) => void;

  onViewerReady?: (candidateId: string | undefined, attrs: Structure3dAttrs) => void;

  onCloseDrawer?: () => void;
}

export function StructureDrawerContent({
  onCloseDrawer,
  store = useStructureDrawerStore,
  paneHost,
  viewSettings,
  retainLoadedView,
  savedScene,
  savedDocument,
  prediction,
  measurements,
  activeMeasurementId,
  onViewSettingsChange,
  onViewerReady,
}: StructureDrawerContentProps = {}) {
  const viewerRendererHostId = useStructureRendererHostId(
    paneHost ? `pane:${paneHost.panelId}` : undefined
  );
  const panelMountStructureIdRef = useRef<string | null>(null);
  const activeHandoffIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const {
    status,
    resolved,
    error,
    request,
    currentStep,
    requestId,
    close,
    retry,
    handleViewerError,
    handleViewerSlow,
    markReady,
    previewCandidateId,
    committedCandidateId,
    candidatePickerOpen,
    isSlowLoad,
    previewCandidate,
    commitCandidate,
    cancelPreview,
    openCandidatePicker,
    closeCandidatePicker,
  } = useStore(
    store,
    useShallow((s) => ({
      status: s.status,
      resolved: s.resolved,
      error: s.error,
      request: s.request,
      currentStep: s.currentStep,
      requestId: s.requestId,
      close: s.close,
      retry: s.retry,
      handleViewerError: s.handleViewerError,
      handleViewerSlow: s.handleViewerSlow,
      markReady: s._markReady,
      previewCandidateId: s.previewCandidateId,
      committedCandidateId: s.committedCandidateId,
      candidatePickerOpen: s.candidatePickerOpen,
      isSlowLoad: s.isSlowLoad,
      previewCandidate: s.previewCandidate,
      commitCandidate: s.commitCandidate,
      cancelPreview: s.cancelPreview,
      openCandidatePicker: s.openCandidatePicker,
      closeCandidatePicker: s.closeCandidatePicker,
    }))
  );

  const structureLinkOwnerId = useMemo(
    () =>
      request?.entityId && (request.cdsBounds || request.residueMolecule)
        ? [structureLinkOwnerIdFromRequest(request), ...(paneHost ? [paneHost.tabId] : [])].join(
            '\u0000'
          )
        : undefined,
    [request, paneHost]
  );

  const handleViewerLoad = useCallback(
    (loadedStructureId: string) => {
      const current = store.getState();
      if (current.requestId !== requestId || current.status === 'error') return;
      useStructureResidueSessionRegistry
        .getState()
        .markPhase(loadedStructureId, 'interactive', undefined, structureLinkOwnerId);
      markReady(requestId);
    },
    [markReady, requestId, structureLinkOwnerId, store]
  );

  const handleViewerErrorForRequest = useCallback(
    (message: string) => {
      const structureId = panelMountStructureIdRef.current;
      if (structureId) {
        useStructureResidueSessionRegistry
          .getState()
          .markPhase(structureId, 'error', message, structureLinkOwnerId);
      }
      handleViewerError(message, requestId);
    },
    [handleViewerError, requestId, structureLinkOwnerId]
  );

  const handleViewerSlowForRequest = useCallback(() => {
    handleViewerSlow(requestId);
  }, [handleViewerSlow, requestId]);

  const handleClose = useCallback(() => {
    if (activeHandoffIdRef.current) {
      failStructureViewHandoff(activeHandoffIdRef.current, 'source drawer closed during handoff');
      activeHandoffIdRef.current = null;
    }
    close();
    onCloseDrawer?.();
  }, [close, onCloseDrawer]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (activeHandoffIdRef.current) {
        failStructureViewHandoff(
          activeHandoffIdRef.current,
          'source drawer unmounted during handoff'
        );
      }
    };
  }, []);

  const candidates = useMemo(
    () => (resolved ? candidateRowsForResolved(resolved) : []),
    [resolved]
  );
  const candidateCounts = useMemo(
    () => (candidates.length > 0 ? countCandidatesBySource(candidates) : null),
    [candidates]
  );
  const committedCandidate = useMemo(
    () => candidates.find((candidate) => candidate.id === committedCandidateId) ?? null,
    [candidates, committedCandidateId]
  );
  const selectedResolved = useMemo(() => {
    if (!resolved) return null;
    if (committedCandidate) {
      return deriveResolvedForStructureCandidateId(resolved, committedCandidateId) ?? resolved;
    }
    return candidates.length === 0 ? resolved : null;
  }, [candidates.length, committedCandidate, committedCandidateId, resolved]);
  const needsStructureSelection = useMemo(
    () =>
      (status === 'rendering' || status === 'ready') &&
      !!resolved &&
      !committedCandidate &&
      candidates.length > 0,
    [candidates.length, committedCandidate, resolved, status]
  );
  const canChooseDifferentCandidate = !!resolved && candidates.length > 1;
  const showCandidatePicker =
    !!resolved &&
    (status === 'rendering' ||
      status === 'ready' ||
      (status === 'error' && canChooseDifferentCandidate));

  const panelMount = useMemo(() => {
    if (selectedResolved == null) return null;
    const attrs = resolverResultToStructureAttrs(
      selectedResolved,
      request?.cdsLabel,
      request ?? undefined,
      {
        renderIntent: 'loaded',
        linkOwnerId: structureLinkOwnerId,
        logicalViewOwnerId: paneHost
          ? `${paneHost.tabId}:${request?.identityRequestKey ?? structureLinkOwnerId}`
          : (request?.identityRequestKey ?? structureLinkOwnerId),
      }
    );
    const mount = {
      ...attrs,
      attrs: {
        ...attrs.attrs,
        measurements,
        activeMeasurementId,
        alleleProvenance:
          savedScene?.source.allele ?? (request ? inspectionAlleleProvenance(request) : undefined),
        comparisonProvenance: savedScene?.source.comparison,
        predictionProvenance:
          savedScene?.source.prediction ??
          (prediction
            ? {
                provider: prediction.provider,
                toolId: prediction.toolId,
                remoteId: prediction.remoteId,
                jobRecordId: prediction.jobRecordId,
                proteinSequenceSha256: prediction.proteinSequenceSha256,
                coordinateSha256: prediction.sha256,
                metrics: prediction.metrics,
              }
            : undefined),
        ...(structureLinkOwnerId ? { structureLinkOwnerId } : {}),

        ...(paneHost ? { showSequenceViewer: false } : {}),
        ...(savedScene
          ? {
              source: 'file' as const,
              sourceId: savedScene.coordinates.text,
              coordinateFormat:
                savedScene.coordinates.format === 'bcif' ? ('bcif' as const) : undefined,
              coordinateSha256: savedScene.coordinates.sha256,
              coordinateModel: savedScene.source.coordinateModel,
              molViewSpec: savedScene.scene,
              molViewSpecSnapshotIndex: savedScene.initialSnapshotIndex,
              cameraSnapshot: savedScene.cameraSnapshot,
              molecularData: savedScene.molecularData,
              view: undefined,
            }
          : {}),
        ...(savedDocument
          ? {
              molecularDocumentId: savedDocument.saved.document.id,
              molecularDocumentReference: savedDocument.documentReference,
              molecularDocumentProjectId: savedDocument.documentReference.projectId,
              molecularDocumentPath: savedDocument.saved.path,
              molecularDocumentRevision: savedDocument.saved.revision,
              molecularDocumentSavedReferenceId: savedDocument.saved.document.currentReferenceId,
              molecularDocumentHistoricalRevisionId:
                savedDocument.documentReference.revisionId !==
                savedDocument.saved.document.currentReferenceId
                  ? savedDocument.documentReference.revisionId
                  : undefined,
              molViewSpecSavedReferenceId: savedDocument.documentReference.revisionId,
            }
          : {}),
      },
    };
    const registrationId = mount.attrs.structureViewIdentity?.structureViewId;
    const retained =
      retainLoadedView && registrationId
        ? useStructure3dStore.getState().expandedStructures[registrationId]?.data
        : undefined;
    if (
      retained?.molViewSpec &&
      retained.structureLinkOwnerId === structureLinkOwnerId &&
      retained.structureViewIdentity?.structureViewId === registrationId
    )
      mount.attrs = { ...mount.attrs, ...retained, measurements, activeMeasurementId };
    if (
      viewSettings &&
      viewSettings.candidateId === (committedCandidateId ?? undefined) &&
      (committedCandidateId ||
        (!!mount.attrs.structureViewIdentity?.structureViewId &&
          viewSettings.structureViewId === mount.attrs.structureViewIdentity.structureViewId))
    ) {
      return {
        ...mount,
        attrs: {
          ...mount.attrs,
          view:
            viewSettings.molViewSpec || savedScene
              ? undefined
              : (viewSettings.view ?? mount.attrs.view),
          molViewSpec: viewSettings.molViewSpec ?? mount.attrs.molViewSpec,
          molViewSpecSnapshotIndex:
            viewSettings.molViewSpecSnapshotIndex ?? mount.attrs.molViewSpecSnapshotIndex,
          cameraSnapshot: viewSettings.cameraSnapshot ?? mount.attrs.cameraSnapshot,
          showSequenceViewer: viewSettings.showSequenceViewer ?? mount.attrs.showSequenceViewer,
          molecularData: viewSettings.molecularData ?? mount.attrs.molecularData,
        },
      };
    }
    return mount;
  }, [
    selectedResolved,
    request,
    structureLinkOwnerId,
    paneHost,
    viewSettings,
    retainLoadedView,
    savedScene,
    savedDocument,
    prediction,
    measurements,
    activeMeasurementId,
    committedCandidateId,
  ]);
  panelMountStructureIdRef.current = panelMount?.structureId ?? null;

  const viewCallbacks = useMemo(
    () =>
      onViewSettingsChange
        ? {
            onUpdate: (attrs: Structure3dAttrs) => {
              if (store.getState().requestId === requestId)
                onViewSettingsChange(committedCandidateId ?? undefined, attrs);
            },
          }
        : undefined,
    [committedCandidateId, onViewSettingsChange, store, requestId]
  );

  useEffect(() => {
    if (!panelMount) return;
    const registrationId =
      panelMount.attrs.structureViewIdentity?.structureViewId ?? panelMount.structureId;
    const register = useStructure3dStore.getState().registerStructure;
    if (viewCallbacks) register(registrationId, panelMount.attrs, panelMount.label, viewCallbacks);
    else register(registrationId, panelMount.attrs, panelMount.label);
  }, [panelMount, viewCallbacks]);

  useEffect(() => {
    if (status !== 'ready' || !panelMount || !committedCandidateId || !onViewSettingsChange) return;
    const current = store.getState();
    if (
      current.requestId !== requestId ||
      current.resolved !== resolved ||
      current.committedCandidateId !== committedCandidateId ||
      current.status !== 'ready'
    )
      return;
    const registrationId =
      panelMount.attrs.structureViewIdentity?.structureViewId ?? panelMount.structureId;
    const attrs = useStructure3dStore.getState().expandedStructures[registrationId]?.data;
    if (
      attrs &&
      attrs.structureBinding?.bindingId === panelMount.attrs.structureBinding?.bindingId &&
      attrs.structureLinkOwnerId === structureLinkOwnerId
    )
      onViewSettingsChange(committedCandidateId, attrs);
  }, [
    status,
    panelMount,
    committedCandidateId,
    onViewSettingsChange,
    store,
    requestId,
    resolved,
    structureLinkOwnerId,
  ]);

  useEffect(() => {
    if (!resolved || !request?.entityId || !needsStructureSelection) return;
    const previewId = previewCandidateId ?? candidates[0]?.id ?? `request:${requestId}`;
    useStructureResidueSessionRegistry.getState().upsertSession({
      structureId: `pending:${requestId}:${previewId}`,
      ownerId: structureLinkOwnerId,
      requestId,
      sequenceDocumentId: request.entityId,
      phase: 'awaiting-candidate-commit',
    });
  }, [
    candidates,
    needsStructureSelection,
    previewCandidateId,
    request?.entityId,
    requestId,
    resolved,
    structureLinkOwnerId,
  ]);

  useEffect(() => {
    if (!panelMount || !request?.entityId) return;
    const { structureId } = panelMount;
    const residueTargets = residueTargetsFromStructureAttrs(panelMount.attrs);
    const cdsLabel = request.cdsLabel ?? '';
    const residueFeatureId = residueFeatureIdFromRequest(request);
    const bounds = request.cdsBounds;
    const residueMolecule =
      request.residueMolecule ??
      (bounds
        ? {
            moleculeId: translatedCdsMoleculeIdFromParts({
              referenceId: request.entityId,
              featureKey: residueFeatureId,
              start0: bounds.cdsStart,
              end0: bounds.cdsEnd,
              strand: bounds.strand,
            }),
            moleculeKind: 'translated-cds',
            label: cdsLabel,
          }
        : undefined);
    if (!residueMolecule) return;
    const entry = {
      structureId,
      bindingId: panelMount.attrs.structureBinding?.bindingId,
      structureViewId: panelMount.attrs.structureViewIdentity?.structureViewId,
      ownerId: structureLinkOwnerId,
      sequenceDocumentId: request.entityId,
      cdsLabel,
      cdsFeatureId: residueFeatureId,
      translation: request.translation,
      ...(bounds
        ? { cdsStart: bounds.cdsStart, cdsEnd: bounds.cdsEnd, strand: bounds.strand }
        : {}),
      residueTarget: residueTargets[0],
      residueTargets,
      residueMolecule,
    };
    useStructureLinkRegistry.getState().registerLink(entry);
    useStructureResidueSessionRegistry
      .getState()
      .unregisterSessionsForRequest(
        requestId,
        (session) =>
          session.ownerId === structureLinkOwnerId &&
          (session.phase === 'awaiting-candidate-commit' ||
            session.structureId.startsWith('pending:'))
      );
    useStructureResidueSessionRegistry.getState().upsertSession({
      structureId,
      bindingId: panelMount.attrs.structureBinding?.bindingId,
      structureViewId: panelMount.attrs.structureViewIdentity?.structureViewId,
      ownerId: structureLinkOwnerId,
      requestId,
      sequenceDocumentId: request.entityId,
      phase: status === 'ready' ? 'interactive' : status === 'error' ? 'error' : 'viewer-mounting',
      link: entry,
      ...(status === 'error' && error
        ? { failureReason: toUserMessage(error, 'structure.failed') }
        : {}),
    });
    return () => {
      useStructureResidueSessionRegistry
        .getState()
        .markPhase(structureId, 'drawer-unmounted', undefined, structureLinkOwnerId);
    };
  }, [
    panelMount,
    request?.cdsBounds,
    request?.entityId,
    request?.cdsLabel,
    request?.residueMolecule,
    request?.translation,
    requestId,
    status,
    error,
    structureLinkOwnerId,
  ]);

  const handleOpenInTab = useCallback(async () => {
    if (!panelMount) return;
    const canvas = useCanvasStore.getState();
    const structureViewId =
      panelMount.attrs.structureViewIdentity?.structureViewId ?? panelMount.structureId;
    const bindingId = panelMount.attrs.structureBinding?.bindingId ?? panelMount.structureId;
    const handoff = beginStructureViewHandoff({
      structureViewId,
      bindingId,
      sourceGeneration: requestId,
    });
    if (!handoff.created) return;
    activeHandoffIdRef.current = handoff.transactionId;
    setHandoffError(null);
    const destinationAttrs: Structure3dAttrs = {
      ...panelMount.attrs,
      structureViewHandoff: {
        transactionId: handoff.transactionId,
        structureViewId,
        bindingId,
        generation: handoff.generation,
      },
    };

    const sequenceTab = request?.entityId ? canvas.findTab('sequence', request.entityId) : null;
    const sourcePanelId =
      sequenceTab?.panelId ?? canvas.focusedPanelId ?? Object.keys(canvas.panels)[0];
    const placement = sourcePanelId
      ? canvas.openInOppositePanelDetailed(
          sourcePanelId,
          'structure',
          structureViewId,
          panelMount.label,
          destinationAttrs
        )
      : null;
    if (!placement) {
      failStructureViewHandoff(handoff.transactionId, 'No destination pane was available');
    } else {
      attachStructureViewHandoffDestination(handoff.transactionId, {
        tabId: placement.tabId,
        panelId: placement.targetPanelId,
        viewerInstanceId: `tab:${placement.tabId}`,
        createdTab: placement.createdTab,
        ...(placement.createdPanelId ? { createdPanelId: placement.createdPanelId } : {}),
      });
    }

    const completion = await handoff.completion;
    if (activeHandoffIdRef.current === handoff.transactionId) {
      activeHandoffIdRef.current = null;
    }
    if (completion.status === 'committed') {
      const { structureViewHandoff: _handoff, ...committedAttrs } = destinationAttrs;
      useCanvasStore
        .getState()
        .updateTab(completion.destination.panelId, completion.destination.tabId, {
          initialStructureAttrs: committedAttrs,
        });
      close();
      onCloseDrawer?.();
      return;
    }
    const destination = completion.destination;
    if (destination?.createdTab) {
      const latestCanvas = useCanvasStore.getState();
      latestCanvas.closeTab(destination.panelId, destination.tabId);
    }
    if (mountedRef.current) setHandoffError(toUserMessage(completion.reason, 'structure.failed'));
  }, [close, onCloseDrawer, panelMount, request, requestId]);

  const handleNavigateToSourceSequence = useCallback(async () => {
    const entityId = request?.entityId;
    const cdsBounds = request?.cdsBounds;
    if (!entityId || !cdsBounds) return;
    const canvas = useCanvasStore.getState();
    const applyNavigation = (target: { panelId: string; tabId: string }) => {
      canvas.focusPanel(target.panelId);
      canvas.setActiveTab(target.panelId, target.tabId);
      canvas.setTabViewState(target.panelId, target.tabId, {
        scrollPosition: cdsBounds.cdsStart + 1,
        highlightRange: {
          start: cdsBounds.cdsStart,
          end: cdsBounds.cdsEnd,
          ...(cdsBounds.cdsStart > cdsBounds.cdsEnd ? { wraps: true } : {}),
        },
        sequenceNavigationRequestId: ++sourceSequenceNavigationRequestId,
      });
    };

    const existing = canvas.findTab('sequence', entityId);
    if (existing) {
      applyNavigation(existing);
      return;
    }

    const roots = useWorkspaceStore.getState().folders.map((folder) => folder.path);
    const resolvedDocument = await resolveSequenceDocumentById(entityId, roots).catch(() => null);
    if (!resolvedDocument) return;
    const tabId = await openSequenceDocument(resolvedDocument.ref, {
      label: resolvedDocument.name ?? 'Sequence',
      strategy: { kind: 'smart' },
    });
    if (!tabId) return;
    for (const [panelId, panel] of Object.entries(useCanvasStore.getState().panels)) {
      if (panel.tabs.some((tab) => tab.id === tabId)) {
        applyNavigation({ panelId, tabId });
        return;
      }
    }
  }, [request]);

  const canNavigateToSourceSequence = !!request?.entityId && !!request.cdsBounds;
  const needsCandidateCommit = !!resolved && !committedCandidate && candidates.length > 0;
  const showCandidateChooser =
    showCandidatePicker && !!resolved && (candidatePickerOpen || needsCandidateCommit);
  const showCandidateChooserWithViewer = showCandidateChooser && !!panelMount;
  const renderingChainCount =
    committedCandidate?.metadata?.chainCount ??
    selectedResolved?.candidates?.find((c) => c.id === committedCandidateId)?.metadata
      ?.chainCount ??
    selectedResolved?.candidates?.[0]?.metadata?.chainCount;
  const slowLoadCopy =
    typeof renderingChainCount === 'number'
      ? `Rendering large structure (${renderingChainCount} chains)…`
      : 'Rendering large structure…';
  const viewerPanel =
    (status === 'rendering' || status === 'ready') && panelMount ? (
      <div className="relative h-full min-h-0" data-testid="structure-viewer-panel-frame">
        {}
        <LazyStructure3dPanel
          key={panelMount.attrs.structureViewIdentity?.structureViewId ?? panelMount.structureId}
          structureId={panelMount.structureId}
          structureViewId={panelMount.attrs.structureViewIdentity?.structureViewId}
          bindingId={panelMount.attrs.structureBinding?.bindingId}
          initialStructureAttrs={panelMount.attrs}
          structureLinkOwnerId={structureLinkOwnerId}
          viewerInstanceId={
            paneHost ? `tab:${paneHost.tabId}` : `drawer:${requestId}:${panelMount.structureId}`
          }
          rendererHostId={viewerRendererHostId}
          hideStructureHeader
          onError={handleViewerErrorForRequest}
          onSlowLoad={handleViewerSlowForRequest}
          loadRequestKey={JSON.stringify([requestId, committedCandidateId])}
          onLoad={() => {
            void (async () => {
              if (store.getState().requestId !== requestId) return;
              const registrationId =
                panelMount.attrs.structureViewIdentity?.structureViewId ?? panelMount.structureId;
              let attrs = useStructure3dStore.getState().expandedStructures[registrationId]?.data;
              if (attrs && paneHost && !attrs.molViewSpec)
                attrs = await initializeInspectionScene(
                  attrs,
                  viewerRendererHostId ?? `pane:${paneHost.panelId}`
                );
              if (store.getState().requestId !== requestId) return;
              handleViewerLoad(panelMount.structureId);
              if (attrs) {
                onViewSettingsChange?.(committedCandidateId ?? undefined, attrs);
                onViewerReady?.(committedCandidateId ?? undefined, attrs);
              }
            })().catch((error) =>
              handleViewerErrorForRequest(error instanceof Error ? error.message : String(error))
            );
          }}
        />
        {status === 'rendering' && (
          <div
            data-testid="structure-viewer-loading-shield"
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-bg/95 text-sm text-fg"
          >
            <div className="flex items-center gap-2 rounded border border-border bg-bg px-3 py-2 shadow-sm">
              <span
                className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-border border-t-accent"
                aria-hidden="true"
              />
              <span data-testid="structure-viewer-loading-copy">
                {isSlowLoad ? slowLoadCopy : 'Preparing interactive 3D viewer'}
              </span>
            </div>
          </div>
        )}
      </div>
    ) : null;
  const hasLighterSource = canChooseDifferentCandidate;
  const errorPanel =
    status === 'error' && error ? (
      error.code === 'large_complex' ? (
        <StructureLargeComplexState
          chainCount={renderingChainCount}
          hasLighterSource={hasLighterSource}
          onUseLighterSource={hasLighterSource ? openCandidatePicker : undefined}
          onOpenCandidatePicker={openCandidatePicker}
        />
      ) : (
        <StructureErrorState
          error={error}
          onRetry={canChooseDifferentCandidate ? openCandidatePicker : retry}
        />
      )
    ) : null;
  const candidatePickerPanel =
    showCandidateChooser && resolved ? (
      <StructureCandidatePicker
        resolved={resolved}
        committedCandidateId={committedCandidateId}
        previewCandidateId={previewCandidateId}
        expanded={candidatePickerOpen}
        fillAvailable
        onPreview={previewCandidate}
        onCommit={commitCandidate}
        onCancelPreview={cancelPreview}
        onClosePicker={closeCandidatePicker}
      />
    ) : null;

  return (
    <div data-testid="structure-drawer-content" className="flex h-full flex-col">
      <StructureDrawerHeader
        compact={!!paneHost}
        cdsLabel={request?.cdsLabel}
        resolved={selectedResolved}
        statusLabel={needsStructureSelection ? 'Choose structure' : (STATUS_COPY[status] ?? '')}
        candidateCounts={candidateCounts}
        selectedCandidate={committedCandidate}
        onClose={handleClose}
        onOpenInTab={!paneHost && selectedResolved && panelMount ? handleOpenInTab : undefined}
        closeLabel={paneHost ? 'Close protein pane' : undefined}
        onChangeStructure={
          committedCandidate && candidates.length > 1 && !candidatePickerOpen
            ? openCandidatePicker
            : undefined
        }
        onNavigateToSequence={
          canNavigateToSourceSequence ? handleNavigateToSourceSequence : undefined
        }
      />

      {!paneHost && request?.translation && (
        <SavedMolecularStructures
          molecule={{ kind: request.moleculeType ?? 'protein', sequence: request.translation }}
        />
      )}
      {!paneHost && request?.translation && (request.moleculeType ?? 'protein') === 'protein' && (
        <ProteinPredictions
          key={request.identityRequestKey ?? request.translation}
          sequence={request.translation}
          onUse={async (row) => {
            const result = await loadProteinPrediction(row.id, request.translation, row.chainId);
            if (store.getState().request !== request)
              throw new Error('The selected protein changed.');
            const prediction = predictionArtifactFromResult(row.id, row.chainId, result);
            const error = openStructureInspection(request, undefined, {
              prediction,
              attachedChainId: row.chainId,
              candidateId: `prediction:${prediction.jobRecordId}:${prediction.sha256}:${row.chainId}`,
            });
            if (error) throw new Error(error);
            onCloseDrawer?.();
          }}
        />
      )}
      {request?.variantContext && (
        <StructureVariantContext
          request={request}
          structureId={panelMount?.structureId}
          ownerId={structureLinkOwnerId}
          ready={status === 'ready'}
        />
      )}
      {handoffError && (
        <div
          role="alert"
          data-testid="structure-view-handoff-error"
          className="border-b border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          Could not open the structure pane: {toUserMessage(handoffError, 'structure.failed')}. The
          drawer remains active.
        </div>
      )}

      <div className="flex-1 overflow-hidden" data-testid="structure-drawer-body">
        {showCandidateChooserWithViewer ? (
          <div
            data-testid="structure-candidate-chooser-surface"
            data-layout="split-viewer"
            className="h-full min-h-0 overflow-hidden"
          >
            <div
              data-testid="structure-change-structure-layout"
              data-results-share="2"
              data-viewer-share="1"
              className="flex h-full min-h-0 flex-col overflow-hidden bg-bg"
            >
              <div
                data-testid="structure-change-results-pane"
                className="min-h-0 flex-[2_1_0] overflow-hidden border-b border-border"
              >
                {candidatePickerPanel}
              </div>
              <div
                data-testid="structure-change-viewer-pane"
                className="min-h-0 flex-[1_1_0] overflow-hidden bg-bg"
              >
                {viewerPanel != null ? viewerPanel : errorPanel}
              </div>
            </div>
          </div>
        ) : (
          <>
            {showCandidateChooser && (
              <div
                data-testid="structure-candidate-chooser-surface"
                data-layout="full-list"
                className="h-full min-h-0 overflow-hidden"
              >
                {candidatePickerPanel}
              </div>
            )}

            {status === 'idle' && <div data-testid="structure-drawer-idle" className="h-full" />}

            {status === 'resolving' && (
              <StructureResolvingState cdsLabel={request?.cdsLabel} currentStep={currentStep} />
            )}

            {viewerPanel}

            {status === 'no_match' && (
              <NoStructurePlaceholder
                moleculeType={request?.moleculeType ?? 'protein'}
                onPredictStructure={
                  request?.translation && (request.moleculeType ?? 'protein') === 'protein'
                    ? () =>
                        usePredictStructureStore.getState().open({
                          sequence: request.translation,
                          name: request.cdsLabel ?? 'Protein',
                          preferredRoot: request.sourceWorkspaceRoot ?? null,
                          ...(paneHost && request.entityId
                            ? {
                                inspectionTarget: {
                                  document_id: request.entityId,
                                  protein_key: inspectionProteinKey(request),
                                },
                              }
                            : {}),
                        })
                    : undefined
                }
              />
            )}

            {errorPanel}
          </>
        )}
      </div>
    </div>
  );
}

function StructureResolvingState({
  cdsLabel,
  currentStep,
}: {
  cdsLabel?: string;
  currentStep: ResolverSource | null;
}) {
  return (
    <div
      data-testid="structure-drawer-resolving"
      className="h-full bg-bg px-3 py-4 text-xs text-fg-muted"
    >
      <div className="rounded-md border border-border bg-bg-subtle p-3">
        <div className="flex items-center gap-2">
          <span
            data-testid="structure-drawer-loading-spinner"
            className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-border border-t-accent"
            aria-hidden="true"
          />
          <span className="text-sm font-medium text-fg">Finding matching structure</span>
        </div>
        {cdsLabel && (
          <div data-testid="structure-drawer-loading-target" className="mt-1 truncate font-mono">
            {cdsLabel}
          </div>
        )}
        <div data-testid="structure-drawer-loading-step" className="mt-2">
          {currentStep
            ? RESOLUTION_STEP_COPY[currentStep]
            : 'Checking PDB, AlphaFold DB, and UniProt records.'}
        </div>
        <div className="mt-3 space-y-2" aria-hidden="true">
          <div className="h-2 w-11/12 rounded bg-bg-muted" />
          <div className="h-2 w-8/12 rounded bg-bg-muted" />
          <div className="h-2 w-10/12 rounded bg-bg-muted" />
        </div>
      </div>
    </div>
  );
}

function residueTargetsFromStructureAttrs(attrs: Structure3dAttrs): StructureLinkResidueTarget[] {
  const labelAsymIds = tokens(attrs.labelAsymIds);
  const authAsymIds = tokens(attrs.authAsymIds);
  const entityId = attrs.pdbEntityId?.trim() || undefined;

  const maxLength = Math.max(labelAsymIds.length, authAsymIds.length);
  if (maxLength > 0) {
    const targets: StructureLinkResidueTarget[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < maxLength; index += 1) {
      const labelAsymId = labelAsymIds[index];
      const authAsymId = authAsymIds[index];
      const chain = authAsymId ?? labelAsymId;
      if (!chain) continue;
      const target: StructureLinkResidueTarget = {
        chain,
        ...(labelAsymId ? { baseChain: labelAsymId, labelAsymId } : {}),
        ...(authAsymId ? { authAsymId } : {}),
        ...(entityId ? { entityId } : {}),
        residues: [],
      };
      const key = [
        target.chain,
        target.baseChain ?? '',
        target.labelAsymId ?? '',
        target.authAsymId ?? '',
        target.entityId ?? '',
      ].join('\u0000');
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(target);
    }
    if (targets.length > 0) return targets;
  }

  return [];
}

function residueFeatureIdFromRequest(request: {
  cdsLabel?: string;
  hints?: { locusTag?: string; geneName?: string };
  residueMolecule?: { label?: string };
}): string {
  return (
    request.residueMolecule?.label?.trim() ||
    request.hints?.locusTag?.trim() ||
    request.hints?.geneName?.trim() ||
    request.cdsLabel?.trim() ||
    ''
  );
}

function structureLinkOwnerIdFromRequest(request: {
  entityId?: string;
  cdsLabel?: string;
  translation: string;
  cdsBounds?: { cdsStart: number; cdsEnd: number; strand: 1 | -1 };
  residueMolecule?: { moleculeId: string; moleculeKind: string; label?: string };
  hints?: { locusTag?: string; geneName?: string };
}): string {
  if (request.residueMolecule?.moleculeKind === 'protein')
    return ['protein', request.entityId ?? '', request.residueMolecule.moleculeId].join('\u0000');
  const featureId = residueFeatureIdFromRequest(request);
  const bounds = request.cdsBounds;
  return [
    'translated-cds',
    request.entityId ?? '',
    featureId,
    bounds?.cdsStart ?? '',
    bounds?.cdsEnd ?? '',
    bounds?.strand ?? '',
    request.translation.length,
  ].join('\u0000');
}

function tokens(values: readonly string[] | undefined): string[] {
  return values?.map((value) => value.trim()).filter(Boolean) ?? [];
}
