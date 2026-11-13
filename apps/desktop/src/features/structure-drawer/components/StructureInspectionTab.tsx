import { toUserMessage, userToolLabel } from '@waypoint/user-messages';
import { loadCatalogStructure } from '../../compute/public/molecular-catalog';
import { canonicalEncodedMolecule } from '../../../shared/encoded-molecule';
import { SavedMolecularStructures } from '../../compute/public/SavedMolecularStructures';
import { attachCatalogToInspection } from '../inspection-catalog';
import {
  InspectionProteinProducts,
  AlleleProteinAwaitingStructure,
} from './InspectionProteinProducts';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useCanvasStore } from '../../canvas/public/store';
import { useStore } from 'zustand';
import { useSidecarStatus } from '../../../hooks/use-sidecar-status';
import { inspectionProteinKey, type StructureInspection } from '../structure-inspection';
import type { Structure3dAttrs } from '../../page/public/embeds/structure3d/types';
import {
  getStructureInspectionSession,
  isPinnedInspectionViewLoaded,
} from '../state/structure-inspection-sessions';
import { candidateRowsForResolved } from '../api/candidates';
import { focusInspectionSelection, loadInspectionDocument } from '../inspection-scene';
import type { MolecularView } from '../../page/public/embeds/structure3d/molecularView';
import { loadInspectionComparison, type InspectionScene } from '../inspection-comparison';
import { InspectionMeasurements } from './InspectionMeasurements';
import { InspectionExport } from './InspectionExport';
import { applyInspectionMeasurement } from '../apply-inspection-measurement';
import { StructureDrawerContent } from './StructureDrawerContent';
import { loadInspectionPrediction, reuseInspectionPrediction } from '../inspection-prediction';
import { ProteinPredictions } from '../../compute/public/ProteinPredictions';
import { coordinateDigest } from '../../page/public/embeds/structure3d/molecularView';
import {
  getWorkspaceResidueSelectionsStore,
  getWorkspaceResidueSelectionsStoreVersion,
  subscribeWorkspaceResidueSelectionsStores,
} from '../state/selected-codon-registry';
import { textCoordinates } from '../../../shared/binary-coordinates';

export function StructureInspectionTab({
  inspection,
  tabId,
  panelId,
}: {
  inspection: StructureInspection;
  tabId: string;
  panelId: string;
}) {
  const proteinKey = inspectionProteinKey(inspection.request);
  const store = useMemo(
    () => getStructureInspectionSession(tabId, proteinKey),
    [tabId, proteinKey]
  );
  const keepsLoadedView = isPinnedInspectionViewLoaded(
    store,
    inspection.savedViewReferenceId,
    inspection.viewSettings?.structureViewId
  );
  const nativeReady = useStore(store, (state) => state.status === 'ready');
  const sidecarStatus = useSidecarStatus();
  const savedViewCandidateId = inspection.savedViewReferenceId ? inspection.candidateId : undefined;
  const latestAttrs = useRef<Structure3dAttrs | null>(null);
  const [savedScene, setSavedScene] = useState<{
    id: string;
    view: MolecularView;
    document: Awaited<ReturnType<typeof loadInspectionDocument>>;
  } | null>(null);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [applyingMeasurement, setApplyingMeasurement] = useState(false);
  const [predictionCoordinates, setPredictionCoordinates] = useState<{
    artifact: StructureInspection['prediction'];
    coordinates: Awaited<ReturnType<typeof loadInspectionPrediction>>;
  } | null>(null);
  const [catalogCoordinates, setCatalogCoordinates] = useState<{
    ref: NonNullable<StructureInspection['catalogSource']>;
    text: string;
    format: 'pdb' | 'cif';
    sha256: string;
    chainId: string;
    coordinateModel: NonNullable<Structure3dAttrs['coordinateModel']>;
    catalogProvenance: NonNullable<Structure3dAttrs['catalogProvenance']>;
  }>();
  const [comparisonScene, setComparisonScene] = useState<{
    descriptor: StructureInspection['comparison'];
    view: InspectionScene;
  } | null>(null);
  const [loadedBinding, setLoadedBinding] = useState<{
    proteinKey: string;
    candidateId?: string;
    hasScene: boolean;
  }>();
  const canEditView =
    nativeReady &&
    !applyingMeasurement &&
    loadedBinding?.proteinKey === proteinKey &&
    loadedBinding?.candidateId === inspection.candidateId &&
    loadedBinding?.hasScene === true;
  useEffect(() => {
    setSceneError(null);
  }, [proteinKey, inspection.candidateId]);
  useEffect(() => {
    setSceneError(null);
  }, [inspection.savedViewReferenceId, keepsLoadedView]);
  useEffect(() => {
    let cancelled = false;
    const id = inspection.savedViewReferenceId;
    setSceneError(null);
    if (id)
      void loadInspectionDocument(id)
        .then((document) => {
          if (!cancelled) setSavedScene({ id, view: document.snapshot, document });
        })
        .catch((error) => {
          if (!cancelled) setSceneError(toUserMessage(error, 'structure.failed'));
        });
    return () => {
      cancelled = true;
    };
  }, [inspection.savedViewReferenceId, restoreAttempt]);
  useEffect(() => {
    let cancelled = false;
    const artifact = inspection.prediction;
    if (!artifact || inspection.savedViewReferenceId) return;
    setSceneError(null);
    void (async () => {
      if (
        (await coordinateDigest(inspection.request.translation)) !== artifact.proteinSequenceSha256
      )
        throw new Error('The predicted structure belongs to another protein product revision.');
      const coordinates = await loadInspectionPrediction(artifact);
      if (!cancelled) setPredictionCoordinates({ artifact, coordinates });
    })().catch((error) => {
      if (!cancelled) setSceneError(toUserMessage(error, 'structure.failed'));
    });
    return () => {
      cancelled = true;
    };
  }, [
    inspection.prediction,
    inspection.request.translation,
    inspection.savedViewReferenceId,
    restoreAttempt,
  ]);
  useEffect(() => {
    let current = true;
    const ref = inspection.catalogSource;
    if (ref && !inspection.savedViewReferenceId) {
      setSceneError(null);
      void loadCatalogStructure(ref.observationId)
        .then((loaded) => {
          const molecule = canonicalEncodedMolecule({
            kind: inspection.request.moleculeType ?? 'protein',
            sequence: inspection.request.translation,
          });
          const chain = loaded.inventory.chains.find((item) => item.key === ref.chainKey);
          const mapping = loaded.mappings.find(
            (item) =>
              item.chainKey === ref.chainKey &&
              item.molecule.kind === molecule.kind &&
              item.molecule.sequence === molecule.sequence
          );
          if (!chain || !mapping || mapping.status !== 'mapped')
            throw new Error('Saved coordinates do not map to this molecule.');
          if (loaded.observation.format === 'bcif')
            throw new Error('Mutation inspection currently requires text coordinates.');
          if (current)
            setCatalogCoordinates({
              ref,
              text: new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes),
              format: loaded.observation.format,
              sha256: loaded.observation.coordinateSha256,
              chainId: chain.labelAsymId,
              coordinateModel: { blockIndex: chain.blockIndex, modelIndex: chain.modelIndex },
              catalogProvenance: loaded.observation,
            });
        })
        .catch((error) => {
          if (current) setSceneError(toUserMessage(error, 'structure.failed'));
        });
    }
    return () => {
      current = false;
    };
  }, [
    inspection.catalogSource,
    inspection.request.translation,
    inspection.request.moleculeType,
    inspection.savedViewReferenceId,
    restoreAttempt,
  ]);
  useEffect(() => {
    if (!inspection.comparison || inspection.savedViewReferenceId) return;
    let cancelled = false;
    setSceneError(null);
    void loadInspectionComparison(inspection)
      .then((view) => {
        if (!cancelled) setComparisonScene({ descriptor: inspection.comparison, view });
      })
      .catch((error) => {
        if (!cancelled) setSceneError(toUserMessage(error, 'structure.failed'));
      });
    return () => {
      cancelled = true;
    };
  }, [inspection.comparison, inspection.savedViewReferenceId, restoreAttempt]);
  useEffect(() => {
    if (inspection.savedViewReferenceId) {
      if (keepsLoadedView) {
        void store.getState().open(inspection.request);
        return;
      }
      if (savedScene?.id === inspection.savedViewReferenceId) {
        store.getState().openSavedCoordinates(
          inspection.request,
          savedViewCandidateId ?? `saved:${savedScene.id}`,
          {
            ...textCoordinates(savedScene.view.coordinates),
            coordinateModel: savedScene.view.source.coordinateModel,
            catalogProvenance: savedScene.view.source.catalogObservation,
          },
          {
            source: 'saved_coordinates',
            chainId: inspection.attachedChainId,
            confidenceNote: 'Saved coordinates; mapping belongs to the current protein sequence.',
          }
        );
      }
      return;
    }
    if (inspection.comparison) {
      if (comparisonScene?.descriptor === inspection.comparison)
        store
          .getState()
          .openSavedCoordinates(
            inspection.request,
            inspection.candidateId!,
            textCoordinates(comparisonScene.view.coordinates),
            {
              source: 'saved_coordinates',
              confidenceNote:
                'Reference and allele protein chains rigidly aligned using unchanged alpha carbons. Original coordinate sources are retained.',
            }
          );
      return;
    }
    if (inspection.catalogSource) {
      if (catalogCoordinates?.ref === inspection.catalogSource)
        store.getState().openSavedCoordinates(
          inspection.request,
          inspection.candidateId ?? `catalog:${inspection.catalogSource.observationId}`,
          {
            text: catalogCoordinates.text,
            format: catalogCoordinates.format,
            coordinateModel: catalogCoordinates.coordinateModel,
            catalogProvenance: catalogCoordinates.catalogProvenance,
          },
          {
            source: 'saved_coordinates',
            chainId: catalogCoordinates.chainId,
            confidenceNote: 'Saved original coordinates with a verified molecule-to-chain mapping.',
          }
        );
      return;
    }
    if (inspection.prediction) {
      if (predictionCoordinates?.artifact === inspection.prediction) {
        store
          .getState()
          .openSavedCoordinates(
            inspection.request,
            inspection.candidateId ?? `prediction:${inspection.prediction.jobRecordId}`,
            predictionCoordinates.coordinates,
            {
              source: 'computed_coordinates',
              chainId: inspection.prediction.chainId,
              confidenceNote: `Predicted with ${inspection.prediction.toolId} on ${inspection.prediction.provider}; job ${inspection.prediction.remoteId}. Selected protein product sequence matched to the coordinate model.`,
            }
          );
      }
      return;
    }
    if (inspection.request.alleleOf) return;
    if (sidecarStatus !== 'ready') return;
    const unsubscribe = store.subscribe((state, previous) => {
      if (
        !state.committedCandidateId ||
        state.committedCandidateId === previous.committedCandidateId
      )
        return;
      const canvas = useCanvasStore.getState();
      const tab = canvas.panels[panelId]?.tabs.find((item) => item.id === tabId);
      const saved = tab?.structureInspection;
      if (
        !saved ||
        saved.request !== state.request ||
        saved.candidateId === state.committedCandidateId
      )
        return;
      canvas.updateTab(panelId, tabId, {
        structureInspection: { ...saved, candidateId: state.committedCandidateId },
      });
    });
    void store
      .getState()
      .open(inspection.request)
      .then(() => {
        const current = store.getState();
        if (
          current.request !== inspection.request ||
          current.committedCandidateId ||
          !current.resolved
        )
          return;
        const candidates = candidateRowsForResolved(current.resolved);
        const candidate =
          candidates.find((item) => item.id === inspection.candidateId) ??
          candidates.find((item) => item.id === current.resolved?.recommendedCandidateId) ??
          candidates[0];

        if (candidate) current.commitCandidate(candidate.id, current.requestId);
      });
    return unsubscribe;

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    store,
    inspection.request,
    panelId,
    tabId,
    sidecarStatus,
    inspection.savedViewReferenceId,
    savedViewCandidateId,
    keepsLoadedView,
    savedScene,
    inspection.prediction,
    predictionCoordinates,
    inspection.catalogSource,
    catalogCoordinates,
    inspection.comparison,
    comparisonScene,
  ]);

  const selectionStoresVersion = useSyncExternalStore(
    subscribeWorkspaceResidueSelectionsStores,
    getWorkspaceResidueSelectionsStoreVersion
  );
  useEffect(() => {
    const entityId = inspection.request.entityId;
    const moleculeId = inspection.request.residueMolecule?.moleculeId;
    const selections = entityId ? getWorkspaceResidueSelectionsStore(entityId) : null;
    if (!selections || !moleculeId) return;
    if (inspection.selections) selections.set(inspection.selections);
    return selections.subscribe(() => {
      const canvas = useCanvasStore.getState();
      const current = canvas.panels[panelId]?.tabs.find(
        (tab) => tab.id === tabId
      )?.structureInspection;

      if (!current || current.request !== inspection.request) return;
      const next = selections.getSnapshot().filter((item) => item.target.moleculeId === moleculeId);
      if (JSON.stringify(next) === JSON.stringify(current.selections ?? [])) return;
      canvas.updateTab(panelId, tabId, {
        structureInspection: { ...current, selections: next },
      });
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspection.request, selectionStoresVersion, panelId, tabId]);
  const saveViewSettings = useCallback(
    (candidateId: string | undefined, attrs: Structure3dAttrs) => {
      const canvas = useCanvasStore.getState();
      const saved = canvas.panels[panelId]?.tabs.find(
        (tab) => tab.id === tabId
      )?.structureInspection;
      if (!saved || saved.request !== inspection.request || saved.candidateId !== candidateId)
        return;
      latestAttrs.current = attrs;
      const viewSettings = {
        candidateId,
        structureViewId: attrs.structureViewIdentity?.structureViewId,
        view: attrs.molViewSpec ? undefined : attrs.view,
        molViewSpec: attrs.molViewSpec,
        molViewSpecSnapshotIndex: attrs.molViewSpecSnapshotIndex,
        cameraSnapshot: attrs.cameraSnapshot,
        showSequenceViewer: attrs.showSequenceViewer,
        molecularData: attrs.molecularData,
      };
      if (
        JSON.stringify(saved.viewSettings) === JSON.stringify(viewSettings) &&
        JSON.stringify(saved.measurements) ===
          JSON.stringify(attrs.measurements ?? saved.measurements) &&
        saved.activeMeasurementId === attrs.activeMeasurementId
      )
        return;
      canvas.updateTab(panelId, tabId, {
        structureInspection: {
          ...saved,
          viewSettings,
          measurements: attrs.measurements ?? saved.measurements,
          activeMeasurementId: attrs.activeMeasurementId,
        },
      });
    },
    [panelId, tabId, inspection.request, proteinKey]
  );
  const markNativeViewerReady = useCallback(
    (candidateId: string | undefined, attrs: Structure3dAttrs) => {
      const saved = useCanvasStore
        .getState()
        .panels[panelId]?.tabs.find((tab) => tab.id === tabId)?.structureInspection;
      if (!saved || saved.request !== inspection.request || saved.candidateId !== candidateId)
        return;
      saveViewSettings(candidateId, attrs);
      const nextBinding = { proteinKey, candidateId, hasScene: !!attrs.molViewSpec };
      setLoadedBinding((previous) =>
        previous?.proteinKey === nextBinding.proteinKey &&
        previous.candidateId === nextBinding.candidateId &&
        previous.hasScene === nextBinding.hasScene
          ? previous
          : nextBinding
      );
    },
    [panelId, tabId, inspection.request, proteinKey, saveViewSettings]
  );
  useEffect(() => {
    const intent = inspection.focusSelectionId;
    const attrs = latestAttrs.current;
    if (!intent || inspection.mutationCamera === 'keep' || !canEditView || !attrs) return;
    let cancelled = false;
    const current = () =>
      useCanvasStore.getState().panels[panelId]?.tabs.find((tab) => tab.id === tabId)
        ?.structureInspection;
    const isCurrent = () =>
      !cancelled && current()?.mutationCamera !== 'keep' && current()?.focusSelectionId === intent;
    const selected = current()?.selections ?? [];
    void focusInspectionSelection(attrs, panelId, selected, isCurrent)
      .then(() => {
        const latest = current();
        if (isCurrent() && latest)
          useCanvasStore.getState().updateTab(panelId, tabId, {
            structureInspection: { ...latest, focusSelectionId: undefined },
          });
      })
      .catch((error) => {
        if (isCurrent()) setSceneError(toUserMessage(error, 'structure.failed'));
      });
    return () => {
      cancelled = true;
    };
  }, [inspection.focusSelectionId, inspection.mutationCamera, canEditView, panelId, tabId]);

  const restoringScene =
    !!inspection.savedViewReferenceId &&
    !keepsLoadedView &&
    savedScene?.id !== inspection.savedViewReferenceId;
  const restoringPrediction =
    !inspection.savedViewReferenceId &&
    !!inspection.prediction &&
    predictionCoordinates?.artifact !== inspection.prediction;
  const restoringComparison =
    !!inspection.comparison &&
    !inspection.savedViewReferenceId &&
    comparisonScene?.descriptor !== inspection.comparison;
  const restoringCatalog =
    !!inspection.catalogSource &&
    !inspection.savedViewReferenceId &&
    catalogCoordinates?.ref !== inspection.catalogSource;
  const restoring =
    restoringScene || restoringPrediction || restoringComparison || restoringCatalog;
  const pinned =
    savedScene && savedScene.id === inspection.savedViewReferenceId ? savedScene.view : undefined;
  const measurements = inspection.measurements ?? pinned?.measurements;

  const activeMeasurementId =
    inspection.measurements === undefined
      ? (inspection.activeMeasurementId ?? pinned?.activeMeasurementId)
      : inspection.activeMeasurementId;
  return (
    <div data-testid="structure-inspection-pane" className="flex h-full min-h-0 min-w-0 flex-col">
      {sidecarStatus !== 'ready' &&
        !inspection.savedViewReferenceId &&
        !inspection.prediction &&
        !inspection.catalogSource &&
        !inspection.comparison && (
          <div role="status" className="border-b border-border px-3 py-2 text-sm text-fg-muted">
            Waiting for the analysis engine to restore this protein view…
          </div>
        )}
      {inspection.message && (
        <div role="status" className="border-b border-border px-3 py-2 text-sm text-fg-muted">
          {toUserMessage(inspection.message, 'structure.failed')}
        </div>
      )}
      <InspectionMeasurements
        key={proteinKey}
        ready={canEditView && !restoring}
        inspection={{ ...inspection, measurements, activeMeasurementId }}
        molecularData={inspection.viewSettings?.molecularData ?? pinned?.molecularData}
        onApplyLayer={async (layer) => {
          const structureViewId = latestAttrs.current?.structureViewIdentity?.structureViewId;
          if (!canEditView || !structureViewId)
            throw new Error('Wait for the structure to finish loading.');
          setApplyingMeasurement(true);
          try {
            const { handleMolData } = await import('../../agent-bridge/public/structure-tools');
            const result = await handleMolData({ operation: 'apply', structureViewId, layer });
            if (!result.ok) throw new Error(result.error);
            if (!('unresolved' in result))
              throw new Error('The variation command did not return its mapping outcome.');
            return { unresolved: result.unresolved };
          } finally {
            setApplyingMeasurement(false);
          }
        }}
        onApply={async (measurement) => {
          if (!canEditView || !latestAttrs.current)
            throw new Error('Wait for the protein structure to finish loading.');
          setApplyingMeasurement(true);
          try {
            return await applyInspectionMeasurement(latestAttrs.current, panelId, measurement);
          } finally {
            setApplyingMeasurement(false);
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1 text-xs">
        <label className="flex items-center gap-1.5">
          Camera
          <select
            aria-label="Mutation camera"
            className="rounded border border-border bg-transparent px-2 py-1"
            value={inspection.mutationCamera ?? 'follow'}
            onChange={(event) => {
              const mutationCamera = event.target.value === 'keep' ? 'keep' : 'follow';
              const canvas = useCanvasStore.getState();
              const current = canvas.panels[panelId]?.tabs.find(
                (tab) => tab.id === tabId
              )?.structureInspection;
              if (!current) return;
              canvas.updateTab(panelId, tabId, {
                structureInspection: {
                  ...current,
                  mutationCamera,
                  focusSelectionId: undefined,
                },
              });
            }}
          >
            <option value="follow">Follow mutation</option>
            <option value="keep">Keep view</option>
          </select>
        </label>
        {inspection.savedViewReferenceId && !restoringScene && (
          <span role="status">Saved with coordinates</span>
        )}
      </div>
      <details
        className="shrink-0 border-b border-border text-xs"
        data-testid="inspection-structure-options"
      >
        <summary className="cursor-pointer px-3 py-1 text-fg-muted">Structure options</summary>
        {savedScene && savedScene.id === inspection.savedViewReferenceId && (
          <div className="flex justify-end px-3 py-1">
            <InspectionExport key={savedScene.id} view={savedScene.view} />
          </div>
        )}
        <div className="max-h-[40vh] overflow-y-auto">
          <InspectionProteinProducts
            inspection={inspection}
            comparison={pinned?.source.comparison ?? comparisonScene?.view.source.comparison}
          />
          <SavedMolecularStructures
            molecule={{
              kind: inspection.request.moleculeType ?? 'protein',
              sequence: inspection.request.translation,
            }}
            onUse={(observationId, chainKey) =>
              attachCatalogToInspection(inspection.request.entityId!, observationId, chainKey)
            }
          />
          {(inspection.request.moleculeType ?? 'protein') === 'protein' &&
            !inspection.request.comparisonOf && (
              <ProteinPredictions
                key={`predictions:${proteinKey}`}
                sequence={inspection.request.translation}
                selectedId={inspection.prediction?.resultReferenceId}
                selectedChain={inspection.prediction?.chainId}
                onUse={(row) =>
                  reuseInspectionPrediction(inspection.request.entityId!, row.id, row.chainId)
                }
              />
            )}
        </div>
      </details>
      {sceneError && (
        <div role="alert" className="px-3 py-2 text-sm">
          {toUserMessage(sceneError, 'structure.failed')}
          {restoring && (
            <button
              type="button"
              className="ml-2 rounded border border-border px-2 py-1"
              onClick={() => setRestoreAttempt((attempt) => attempt + 1)}
            >
              {restoringPrediction ? 'Retry predicted structure' : 'Retry saved view'}
            </button>
          )}
        </div>
      )}
      {inspection.prediction && (
        <div
          className="border-b border-border px-3 py-1 text-xs"
          data-testid="inspection-prediction-provenance"
        >
          Predicted with {userToolLabel(inspection.prediction.toolId)} ·{' '}
          {inspection.prediction.provider} · Job {inspection.prediction.remoteId}
        </div>
      )}
      {restoring ? (
        <div role="status" className="px-3 py-2 text-sm">
          {sceneError
            ? 'The protein view could not be restored.'
            : restoringComparison
              ? 'Aligning reference and allele structures…'
              : restoringPrediction
                ? 'Opening predicted protein coordinates…'
                : 'Restoring saved protein scene…'}
        </div>
      ) : inspection.request.alleleOf &&
        !inspection.prediction &&
        !inspection.catalogSource &&
        !inspection.savedViewReferenceId ? (
        <AlleleProteinAwaitingStructure inspection={inspection} />
      ) : (
        <div className="min-h-0 flex-1">
          <StructureDrawerContent
            store={store}
            paneHost={{ tabId, panelId }}
            viewSettings={inspection.viewSettings}
            retainLoadedView={keepsLoadedView}
            savedDocument={
              inspection.savedViewReferenceId && !keepsLoadedView ? savedScene?.document : undefined
            }
            savedScene={
              inspection.savedViewReferenceId && !keepsLoadedView
                ? savedScene?.view
                : inspection.comparison
                  ? comparisonScene?.view
                  : undefined
            }
            prediction={inspection.prediction}
            measurements={measurements}
            activeMeasurementId={activeMeasurementId}
            onViewSettingsChange={saveViewSettings}
            onViewerReady={markNativeViewerReady}
            onCloseDrawer={() => useCanvasStore.getState().closeTab(panelId, tabId)}
          />
        </div>
      )}
    </div>
  );
}
