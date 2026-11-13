import type {
  ComputeJobRecord,
  ProteinInspectionComputeTarget,
} from '../../shared/compute-jobs-ipc';
import { useCanvasStore } from '../canvas/public/store';
import { platform } from '../../platform';
import { coordinateDigest } from '../page/public/embeds/structure3d/molecularView';
import { readDesktopScientificDocument } from '../scientific-document/public/read-desktop-scientific-document';
import {
  MOLECULAR_DOCUMENT_SUFFIX,
  getCurrentMolecularSnapshot,
} from '../../shared/molecular-document';
import {
  inspectionProteinKey,
  structureInspectionId,
  openStructureInspection,
} from './structure-inspection';
import {
  createInspectionContinuation,
  loadInspectionContinuation,
  openContinuationSource,
  saveInspectionContinuation,
} from './inspection-continuation';
import { loadInspectionScene } from './inspection-scene';
import { validatePredictionCoordinates } from './prediction-coordinates';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { findWorkspaceRootForPath } from '../../db/workspace-catalog';
import { resolveSequenceDocumentById } from '../sequence/public/sequence-document-repository';
import {
  loadProteinPrediction,
  loadProteinPredictionByDigest,
  discoverProteinPredictions,
  type ProteinPredictionResult,
} from '../compute/public/prediction-library';

import type { InspectionPredictionArtifact } from './public/inspection-types';
export type { InspectionPredictionArtifact } from './public/inspection-types';

const MIGRATED_COMPUTE_PATH = /[\\/]compute[\\/][^\\/]+[\\/][^\\/]+[\\/][^\\/]+$/;

function isMolecularView(path: string) {
  return path.toLowerCase().endsWith(MOLECULAR_DOCUMENT_SUFFIX);
}

function findInspectionLocation(documentId: string) {
  const canvas = useCanvasStore.getState();
  const location = canvas.findTab('structure', structureInspectionId(documentId));
  const inspection =
    location &&
    canvas.panels[location.panelId]?.tabs.find((t) => t.id === location.tabId)?.structureInspection;
  if (!location || !inspection) return null;
  return { canvas, location, inspection };
}

function inspectionLocation(documentId: string) {
  const current = findInspectionLocation(documentId);
  if (!current)
    throw new Error('Open the reference mutation inspection before attaching this prediction.');
  return current;
}

export async function inspectionPredictionWorkspaceRoot(documentId: string): Promise<string> {
  const root = inspectionLocation(documentId).inspection.request.sourceWorkspaceRoot;
  if (root) return root;
  const folders = useWorkspaceStore.getState().folders;
  const document = await resolveSequenceDocumentById(
    documentId,
    folders.map((folder) => folder.path)
  );
  const owner = findWorkspaceRootForPath(folders, document.sourcePath);
  if (!owner)
    throw new Error('Mount the reference protein’s workspace before submitting its prediction.');
  return owner;
}

export async function prepareInspectionPrediction(
  input: { document_id: string; protein_key?: string },
  settings: Record<string, unknown>
): Promise<ProteinInspectionComputeTarget> {
  const { inspection } = inspectionLocation(input.document_id);
  const proteinKey = inspectionProteinKey(inspection.request);
  if (input.protein_key && input.protein_key !== proteinKey)
    throw new Error('The selected protein changed before prediction submission.');
  const polymers = settings.polymers;
  const submitted =
    settings.sequence ??
    settings.protein_sequence ??
    (Array.isArray(polymers) && polymers.length === 1 && polymers[0]?.molecule_type === 'protein'
      ? polymers[0].sequence
      : undefined);
  if (typeof submitted !== 'string' || submitted !== inspection.request.translation)
    throw new Error(
      'An inspection prediction must submit exactly its selected protein product sequence as one chain.'
    );
  const proteinSequenceSha256 = await coordinateDigest(submitted);
  const continuationReferenceId = await createInspectionContinuation(inspection);
  const { canvas, location, inspection: current } = inspectionLocation(input.document_id);
  if (inspectionProteinKey(current.request) !== proteinKey)
    throw new Error('The selected protein changed before prediction submission.');
  canvas.updateTab(location.panelId, location.tabId, {
    structureInspection: { ...current, continuationReferenceId },
  });
  return {
    continuationReferenceId,
    kind: 'protein-inspection',
    documentId: input.document_id,
    proteinKey,
    proteinSequenceSha256,
  };
}

export function assertInspectionPredictionTarget(target: ProteinInspectionComputeTarget): void {
  const { inspection } = inspectionLocation(target.documentId);
  if (
    inspectionProteinKey(inspection.request) !== target.proteinKey &&
    !inspection.retainedProteinViews?.[target.proteinKey]
  )
    throw new Error(
      'The prediction destination is stale. Reopen the original reference protein to attach it.'
    );
}

export async function validateInspectionPredictionTarget(
  target: ProteinInspectionComputeTarget
): Promise<void> {
  if (target.continuationReferenceId) await loadInspectionContinuation(target);
  else assertInspectionPredictionTarget(target);
}

export async function attachInspectionPrediction(
  target: ProteinInspectionComputeTarget,
  artifact: InspectionPredictionArtifact
): Promise<void> {
  if (artifact.proteinSequenceSha256 !== target.proteinSequenceSha256)
    throw new Error('The prediction belongs to another protein sequence.');
  const loaded = target.continuationReferenceId
    ? await loadInspectionContinuation(target)
    : undefined;
  if (!loaded) assertInspectionPredictionTarget(target);
  const canvas = useCanvasStore.getState();
  const location = canvas.findTab('structure', structureInspectionId(target.documentId));
  const inspection =
    location &&
    canvas.panels[location.panelId]?.tabs.find((tab) => tab.id === location.tabId)
      ?.structureInspection;
  const prior =
    inspection &&
    (inspectionProteinKey(inspection.request) === target.proteinKey
      ? inspection
      : inspection.retainedProteinViews?.[target.proteinKey]);
  const saved = prior ?? loaded?.context;
  if (
    saved?.prediction?.jobRecordId === artifact.jobRecordId &&
    saved.prediction.sha256 === artifact.sha256 &&
    saved.prediction.filePath === artifact.filePath &&
    prior
  ) {
    if (loaded) await openContinuationSource(loaded);
    return;
  }
  const identical =
    saved?.prediction?.jobRecordId === artifact.jobRecordId &&
    saved.prediction.sha256 === artifact.sha256 &&
    saved.prediction.filePath === artifact.filePath;
  const request = prior?.request ?? loaded?.request;
  if (!request) throw new Error('The original protein inspection cannot be recovered.');
  const restored = {
    request,
    selections: prior?.selections ?? loaded?.context.selections,
    continuationReferenceId: target.continuationReferenceId,
    candidateId: `prediction:${artifact.jobRecordId}:${artifact.sha256}`,
    prediction: artifact,
    savedViewReferenceId: identical ? saved?.savedViewReferenceId : undefined,
  };
  await saveInspectionContinuation(restored);
  if (loaded) await openContinuationSource(loaded);
  if (!inspection || !location) {
    if (!loaded) throw new Error('The prediction inspection was closed before import completed.');
    const error = openStructureInspection(request, restored.selections, {
      ...restored,
      retainedProteinViews: loaded.retainedProteinViews,
    });
    if (error) throw new Error(error);
    return;
  }
  const latest = inspectionLocation(target.documentId);
  const active = inspectionProteinKey(latest.inspection.request) === target.proteinKey;
  latest.canvas.updateTab(latest.location.panelId, latest.location.tabId, {
    structureInspection: {
      ...latest.inspection,
      ...(active
        ? {
            ...restored,
            viewSettings: undefined,
            measurements: undefined,
            activeMeasurementId: undefined,
          }
        : {}),
      retainedProteinViews: {
        ...loaded?.retainedProteinViews,
        ...latest.inspection.retainedProteinViews,
        [target.proteinKey]: restored,
      },
    },
  });
}

export async function reopenInspectionPrediction(job: ComputeJobRecord) {
  const target = job.resultTarget;
  if (!target) throw new Error('This job has no protein inspection destination.');
  const loaded = target.continuationReferenceId
    ? await loadInspectionContinuation(target)
    : undefined;
  if (!loaded) assertInspectionPredictionTarget(target);
  const canvas = useCanvasStore.getState();
  const location = canvas.findTab('structure', structureInspectionId(target.documentId));
  const inspection =
    location &&
    canvas.panels[location.panelId]?.tabs.find((tab) => tab.id === location.tabId)
      ?.structureInspection;
  const retained =
    inspection &&
    (inspectionProteinKey(inspection.request) === target.proteinKey
      ? inspection
      : inspection.retainedProteinViews?.[target.proteinKey]);
  const view =
    retained ??
    (loaded
      ? {
          ...loaded.context,
          request: loaded.request,
          continuationReferenceId: target.continuationReferenceId,
        }
      : undefined);
  const artifact = view?.prediction;
  if (
    !artifact ||
    !view?.request ||
    artifact.jobRecordId !== job.id ||
    artifact.provider !== job.provider ||
    artifact.remoteId !== job.remoteId ||
    !(
      job.importedPaths.includes(artifact.filePath) ||
      (MIGRATED_COMPUTE_PATH.test(artifact.filePath) && job.importedPaths.some(isMolecularView))
    )
  )
    throw new Error(
      'This prediction is no longer the retained result for that protein. Reopen the reference mutation to inspect its current view.'
    );
  if (view.savedViewReferenceId) {
    const saved = await loadInspectionScene(view.savedViewReferenceId);
    if (
      saved.coordinates.sha256 !== artifact.sha256 ||
      saved.source.prediction?.jobRecordId !== job.id
    )
      throw new Error('The saved scene uses different coordinates from this prediction.');
  } else await loadInspectionPrediction(artifact);
  if (loaded) await openContinuationSource(loaded);
  const error = openStructureInspection(view.request, view.selections, {
    retainedProteinViews: loaded?.retainedProteinViews,
    candidateId: `prediction:${artifact.jobRecordId}:${artifact.sha256}`,
    prediction: artifact,
    continuationReferenceId: target.continuationReferenceId,
    savedViewReferenceId: view.savedViewReferenceId,
    ...(retained
      ? {
          viewSettings: retained.viewSettings,
          measurements: retained.measurements,
          activeMeasurementId: retained.activeMeasurementId,
        }
      : {}),
  });
  if (error) throw new Error(error);
  const opened = useCanvasStore
    .getState()
    .findTab('structure', structureInspectionId(target.documentId))!;
  return {
    status: 'presented' as const,
    ...opened,
    tabType: 'structure' as const,
    disposition: location ? ('reused' as const) : ('created' as const),
    content: 'loading' as const,
  };
}

async function readViewCoordinates(path: string, workspaceRoot: string) {
  const { readMolecularDocument } = await import('../molecular-documents/public/services');
  const saved = await readMolecularDocument(path, workspaceRoot);
  return getCurrentMolecularSnapshot(saved.document).coordinates;
}

async function readPredictionCoordinateText(artifact: InspectionPredictionArtifact) {
  if (isMolecularView(artifact.filePath))
    return (await readViewCoordinates(artifact.filePath, artifact.workspaceRoot)).text;
  const result = await readDesktopScientificDocument({
    filePath: artifact.filePath,
    workspaceRoot: artifact.workspaceRoot,
  });
  if (result.ok) return result.document.content;
  if (MIGRATED_COMPUTE_PATH.test(artifact.filePath)) {
    const job = await platform().compute.findJob(artifact.provider, artifact.remoteId);
    for (const path of job?.importedPaths.filter(isMolecularView) ?? []) {
      const coordinates = await readViewCoordinates(path, artifact.workspaceRoot).catch(() => null);
      if (coordinates?.sha256 === artifact.sha256) return coordinates.text;
    }
  }
  throw new Error(result.error.message);
}

export async function loadInspectionPrediction(artifact: InspectionPredictionArtifact) {
  if (artifact.resultReferenceId) {
    if (!artifact.chainId) throw new Error('The reused prediction has no selected protein chain.');
    const result = await loadProteinPredictionByDigest(
      artifact.resultReferenceId,
      artifact.proteinSequenceSha256,
      artifact.chainId
    );
    if (
      result.coordinates.sha256 !== artifact.sha256 ||
      result.coordinates.format !== artifact.format ||
      result.run.jobRecordId !== artifact.jobRecordId ||
      result.run.provider !== artifact.provider ||
      result.run.remoteId !== artifact.remoteId ||
      result.run.toolId !== artifact.toolId
    )
      throw new Error('The saved prediction result no longer matches this inspection.');
    return result.coordinates;
  }
  const text = await readPredictionCoordinateText(artifact);
  if ((await coordinateDigest(text)) !== artifact.sha256)
    throw new Error(
      'The predicted coordinate file changed after import. Its saved digest does not match.'
    );
  await validatePredictionCoordinates(text, artifact.format, artifact.proteinSequenceSha256);
  return { text, format: artifact.format, sha256: artifact.sha256 };
}

export function predictionArtifactFromResult(
  resultReferenceId: string,
  chainId: string,
  result: ProteinPredictionResult
): InspectionPredictionArtifact {
  const chain = result.chains.find((item) => item.chainId === chainId);
  if (!chain) throw new Error('The selected prediction chain is unavailable.');
  return {
    resultReferenceId,
    chainId,
    jobRecordId: result.run.jobRecordId,
    provider: result.run.provider,
    remoteId: result.run.remoteId,
    toolId: result.run.toolId,
    workspaceRoot: result.origin.workspaceRoot,
    filePath: result.origin.filePath,
    format: result.coordinates.format,
    sha256: result.coordinates.sha256,
    proteinSequenceSha256: chain.sequenceSha256,
    metrics: result.metrics,
    provenance: result.provenance,
  };
}

export async function reuseInspectionPrediction(
  documentId: string,
  referenceId: string,
  chainId: string
) {
  const { inspection } = inspectionLocation(documentId);
  if (inspection.request.comparisonOf)
    throw new Error('Choose the reference or allele protein before reusing a prediction.');
  const key = inspectionProteinKey(inspection.request);
  const result = await loadProteinPrediction(referenceId, inspection.request.translation, chainId);
  const current = inspectionLocation(documentId);
  if (
    inspectionProteinKey(current.inspection.request) !== key ||
    current.inspection.candidateId !== inspection.candidateId
  )
    throw new Error('The selected protein or structure changed while loading the prediction.');
  const prediction = predictionArtifactFromResult(referenceId, chainId, result);
  if (
    current.inspection.prediction?.resultReferenceId === referenceId &&
    current.inspection.prediction.chainId === chainId &&
    current.inspection.prediction.sha256 === prediction.sha256
  )
    return { referenceId, chainId, proteinKey: key, jobRecordId: result.run.jobRecordId };
  current.canvas.updateTab(current.location.panelId, current.location.tabId, {
    structureInspection: {
      ...current.inspection,
      prediction,
      attachedChainId: chainId,
      candidateId: `prediction:${prediction.jobRecordId}:${prediction.sha256}:${chainId}`,
      savedViewReferenceId: undefined,
      continuationReferenceId: undefined,
      viewSettings: undefined,
      comparison: undefined,
      activeMeasurementId: undefined,
    },
  });
  return { referenceId, chainId, proteinKey: key, jobRecordId: result.run.jobRecordId };
}

export async function listInspectionPredictions(documentId: string) {
  const current = findInspectionLocation(documentId);
  if (!current)
    return {
      status: 'protein-required' as const,
      documentId,
      message:
        'This document has no selected protein inspection. Supply its exact amino-acid proteinSequence to list-predictions, or first use inspect_variant_call/inspect_sequence_variant to select a protein. No prediction search or attachment has occurred.',
    };
  return discoverProteinPredictions(current.inspection.request.translation);
}
