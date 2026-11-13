import { platform } from '../../platform';
import { findWorkspaceRootForPath, registerWorkspaceFile } from '../../db/workspace-catalog';
import { inferCatalogFileKind } from '../../shared/catalog-file-kind';
import { getStructureFileFormat } from '../../shared/scientific-file-types';
import { submittedEncodedMolecules } from '../../shared/encoded-molecule';
import type { WorkspaceFolder } from '../../stores/workspaceStore';
import { openDocument } from '../document-opening/public/open-document';
import type {
  ComputeImportDetails,
  ComputeJobRecord,
  ProteinInspectionComputeTarget,
} from '../../shared/compute-jobs-ipc';
import { coordinateDigest } from '../page/public/embeds/structure3d/molecularView';
import { buildDefaultMolecularDocument } from '../../shared/default-molecular-view';
import {
  MOLECULAR_DOCUMENT_SUFFIX,
  getCurrentMolecularSnapshot,
  type MolecularDocument,
} from '../../shared/molecular-document';
import { isBiologyFile, stripDisplayExtension } from '@/utils/fileTypes';
import { SEQUENCE_PACKAGE_META_NAME } from '../../db/sequence-package-contract';
import { registerPredictionResult } from './prediction-library';
import { openCatalogStructure, registerCatalogStructure } from './molecular-catalog';
import type { MolecularCatalogRegisterInput } from '../../shared/molecular-catalog';
import {
  validateInspectionPredictionTarget,
  attachInspectionPrediction,
  loadInspectionPrediction,
  validatePredictionCoordinates,
  type InspectionPredictionArtifact,
} from '../structure-drawer/public/inspection-prediction';

export interface ComputeResultFileInput {
  name: string;
  media_type: string;
  size_bytes: number | null;

  content: string | null;

  url: string | null;
}

function hasOnlyKnownNonProteinInputs(settings: Record<string, unknown>): boolean {
  try {
    return submittedEncodedMolecules(settings).every((molecule) => molecule.kind !== 'protein');
  } catch {
    return false;
  }
}

export interface ComputeResultBundleInput {
  provider: string;
  remoteId: string;
  toolId: string;
  outputKind: string;
  files: ComputeResultFileInput[];
  metrics: Record<string, unknown>;
  provenance: Record<string, string>;
  settingsHash?: string | null;
  label?: string | null;

  job?: ComputeJobRecord;
  inspectionDestination?: {
    target: ProteinInspectionComputeTarget;
    jobRecordId: string;
    recordedAt: string;
  };
}

export interface ImportedComputeResult {
  ok: true;
  workspaceRoot: string;

  writtenPaths: string[];

  urlOnly: Array<{ name: string; url: string }>;

  opened: string[];
  metrics: Record<string, unknown>;
  provenance: Record<string, string>;
  inspectionAttached?: boolean;
  catalogObservationIds: string[];
  predictionResultIds: string[];
  predictionLibraryWarnings: string[];
  importDetails: ComputeImportDetails;
}

export interface ImportComputeResultDeps {
  writePackage: (input: {
    workspaceRoot: string;
    directory: string;
    name: string;
    document: MolecularDocument;
  }) => Promise<string>;
  writeOutputFile: (input: {
    workspaceRoot: string;
    directory: string;
    name: string;
    content: string;
  }) => Promise<string>;
  registerFile: (
    path: string,
    workspaceRoot: string,
    metadata: Record<string, unknown>
  ) => Promise<void>;
  openStructure: (
    filePath: string,
    label: string,
    catalogObservationId?: string
  ) => Promise<unknown>;

  notifyFilesChanged?: (workspaceRoot: string, revealPath: string) => void;
  attachPrediction?: (
    target: ProteinInspectionComputeTarget,
    artifact: InspectionPredictionArtifact
  ) => Promise<void>;
  registerPrediction?: typeof registerPredictionResult;
  registerCatalog?: (input: MolecularCatalogRegisterInput) => Promise<string>;
}

const defaultDeps: ImportComputeResultDeps = {
  registerCatalog: async (input) => (await registerCatalogStructure(input)).observation.id,
  registerPrediction: registerPredictionResult,
  writePackage: async ({ workspaceRoot, directory, name, document }) => {
    const current = getCurrentMolecularSnapshot(document);
    for (let n = 1; n <= 1000; n += 1) {
      const path = joinPath(
        directory,
        `${n === 1 ? name : `${name} ${n}`}${MOLECULAR_DOCUMENT_SUFFIX}`
      );
      if (await platform().fs.exists(path)) {
        const existing = await platform()
          .molecularDocuments.read({ path, workspaceRoot })
          .then(({ document: saved }) => getCurrentMolecularSnapshot(saved))
          .catch(() => null);
        if (
          existing &&
          existing.source.sourceId === current.source.sourceId &&
          existing.coordinates.sha256 === current.coordinates.sha256
        )
          return path;
        continue;
      }
      const saved = await platform().molecularDocuments.save({
        document,
        destination: { path, workspaceRoot },
        expectedRevision: null,
      });
      return saved.path;
    }
    throw new Error('No free name for the predicted structure.');
  },
  writeOutputFile: async ({ workspaceRoot, directory, name, content }) => {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    for (let n = 1; n <= 1000; n += 1) {
      const path = joinPath(directory, `${n === 1 ? stem : `${stem} ${n}`}${extension}`);
      if (await platform().fs.exists(path)) {
        const existing = await platform()
          .fs.readTextFileSlice(path, content.length * 4 + 1)
          .catch(() => null);
        if (existing?.text === content) return path;
        continue;
      }
      await platform().fs.writeWorkspaceTextFileAtomic({
        workspaceRoot,
        path,
        content,
        mode: 'create',
        artifactNoun: 'compute result',
      });
      return path;
    }
    throw new Error(`No free name for ${name}.`);
  },
  attachPrediction: async (target, artifact) => {
    await loadInspectionPrediction(artifact);
    await attachInspectionPrediction(target, artifact);
  },
  registerFile: async (path, workspaceRoot, metadata) => {
    await registerWorkspaceFile({
      path,
      workspaceRoot,
      fileKind: inferCatalogFileKind(path),
      metadata,
    });
  },
  openStructure: async (filePath, label, catalogObservationId) => {
    if (catalogObservationId) return openCatalogStructure(catalogObservationId);
    const opened = await openDocument({
      target: { kind: 'file', path: filePath, tabType: 'structure' },
      label,
      placement: { kind: 'smart' },
    });
    if (opened.status !== 'presented')
      throw new Error(
        'message' in opened ? opened.message : 'The predicted structure could not be opened.'
      );
    return opened;
  },
  notifyFilesChanged: (workspaceRoot, revealPath) => {
    if (typeof window === 'undefined') return;

    window.dispatchEvent(
      new CustomEvent('waypoint:workspace-files-changed', {
        detail: { path: revealPath, workspaceRoot, revealPath },
      })
    );
  },
};

function joinPath(left: string, right: string): string {
  const separator = left.includes('\\') ? '\\' : '/';
  return `${left.replace(/[\\/]+$/, '')}${separator}${right.replace(/^[\\/]+/, '')}`;
}

export function safeResultFileName(name: string, index: number): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 120) : `result_${index + 1}`;
}

export function safeSegment(value: string, fallback: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : fallback;
}

export function resolveComputeWorkspaceRoot(
  folders: WorkspaceFolder[],
  preferredRoot?: string | null
): string | null {
  const userFolders = folders.filter((f) => !f.pinned);
  if (preferredRoot) {
    const found = findWorkspaceRootForPath(userFolders, preferredRoot);
    if (found) return found;
  }
  return userFolders[0]?.path ?? null;
}

const parentPath = (path: string) => path.slice(0, path.lastIndexOf('/'));

async function predictionPlacement(
  workspaceRoot: string,
  sourcePath: string | null | undefined
): Promise<{ directory: string; source: string | null }> {
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  let source = sourcePath?.replace(/\\/g, '/').split('/.forge/')[0];
  if (!source || !source.startsWith(`${root}/`)) return { directory: root, source: null };
  for (let probe = parentPath(source); probe.startsWith(`${root}/`); probe = parentPath(probe))
    if (await platform().fs.exists(`${probe}/.forge/${SEQUENCE_PACKAGE_META_NAME}`)) source = probe;
  return { directory: parentPath(source), source };
}

function predictionPackageName(
  bundle: ComputeResultBundleInput,
  source: string | null,
  testMode: boolean
): string {
  const sourceName =
    bundle.job?.sourceName ??
    (source ? stripDisplayExtension(source.slice(source.lastIndexOf('/') + 1)) : null);
  const base = sourceName
    ? `${sourceName} prediction`
    : (bundle.label ?? `${bundle.toolId} prediction`);
  const cleaned =
    base
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Prediction';
  return testMode ? `${cleaned} (test mode)` : cleaned;
}

function predictionFormat(name: string): 'pdb' | 'cif' {
  const format = getStructureFileFormat(name);
  if (!format || format.encoding !== 'text')
    throw new Error('Prediction inspection requires text PDB or mmCIF coordinates.');
  return format.parser === 'pdb' ? 'pdb' : 'cif';
}

export async function importComputeResult(
  bundle: ComputeResultBundleInput,
  folders: WorkspaceFolder[],
  options: {
    preferredRoot?: string | null;
    openViewer?: boolean;
    deps?: ImportComputeResultDeps;
  } = {}
): Promise<
  | ImportedComputeResult
  | { ok: false; error: 'no_workspace' | 'nothing_to_import'; message: string }
> {
  const deps = options.deps ?? defaultDeps;
  const workspaceRoot = resolveComputeWorkspaceRoot(folders, options.preferredRoot);
  if (!workspaceRoot) {
    return {
      ok: false,
      error: 'no_workspace',
      message: 'No workspace is open to receive the result.',
    };
  }
  const inline = bundle.files.filter((f) => typeof f.content === 'string' && f.content.length > 0);
  const fileNames = inline.map((file, index) => safeResultFileName(file.name, index));
  if (new Set(fileNames).size !== fileNames.length)
    throw new Error('The provider returned colliding output names. Results were not overwritten.');
  if (bundle.job && workspaceRoot !== bundle.job.workspaceRoot)
    throw new Error('Open the prediction’s recorded workspace before importing its result.');
  const destination = bundle.inspectionDestination;
  const predictedFile = destination
    ? inline.find((file) => getStructureFileFormat(file.name))
    : undefined;
  if (destination) {
    await validateInspectionPredictionTarget(destination.target);
    if (bundle.provenance.livemode === 'false')
      throw new Error(
        'A provider test-mode fixture cannot be attached as a prediction of this protein.'
      );
    if (!predictedFile?.content)
      throw new Error('The provider has not returned coordinate bytes for this prediction.');
    if (workspaceRoot !== options.preferredRoot)
      throw new Error('Open the prediction’s original workspace before importing its structure.');
    await validatePredictionCoordinates(
      predictedFile.content,
      predictionFormat(predictedFile.name),
      destination.target.proteinSequenceSha256
    );
  }
  const urlOnly = bundle.files
    .filter((f) => !f.content && typeof f.url === 'string')
    .map((f) => ({ name: f.name, url: f.url as string }));
  if (inline.length === 0 && urlOnly.length === 0 && Object.keys(bundle.metrics).length === 0) {
    return {
      ok: false,
      error: 'nothing_to_import',
      message: 'The provider returned no files or metrics.',
    };
  }

  const testMode = bundle.provenance?.livemode === 'false';
  const { directory, source } = await predictionPlacement(workspaceRoot, bundle.job?.sourcePath);
  const packageName = predictionPackageName(bundle, source, testMode);
  const provenance = {
    provider: bundle.provider,
    tool: bundle.toolId,
    remote_id: bundle.remoteId,
    ...bundle.provenance,
  };
  const writtenPaths: string[] = [];
  const structurePaths: string[] = [];
  const catalogObservationIds: string[] = [];
  const predictionResultIds: string[] = [];
  const predictionLibraryWarnings: string[] = [];
  const outputs: ComputeImportDetails['outputs'] = [];

  for (const [index, file] of inline.entries()) {
    const format = getStructureFileFormat(file.name);
    const name = safeResultFileName(file.name, index);
    if (!format && isBiologyFile(name)) {
      const path = await deps.writeOutputFile({
        workspaceRoot,
        directory,
        name,
        content: file.content as string,
      });
      await deps.registerFile(path, workspaceRoot, {
        computeProvenance: provenance,
        computeMetrics: bundle.metrics,
        outputKind: bundle.outputKind,
      });
      writtenPaths.push(path);
      continue;
    }
    if (format?.encoding !== 'text') {
      outputs.push({ name, content: file.content as string });
      continue;
    }
    const document = await buildDefaultMolecularDocument({
      name: packageName,
      format: predictionFormat(file.name),
      text: file.content as string,
      createdAt: Date.now(),
      documentId: crypto.randomUUID(),
      referenceId: crypto.randomUUID(),
      source: {
        source: 'prediction',
        sourceId: `${bundle.provider}:${bundle.remoteId}/${safeResultFileName(file.name, index)}`,
      },
    });
    const packagePath = await deps.writePackage({
      workspaceRoot,
      directory,
      name: packageName,
      document,
    });
    writtenPaths.push(packagePath);
    structurePaths.push(packagePath);
    if (bundle.job && !testMode) {
      try {
        catalogObservationIds.push(
          await deps.registerCatalog!({
            workspaceRoot,
            filePath: packagePath,
            source: { kind: 'prediction', jobRecordId: bundle.job.id, outputKey: file.name },
            label: bundle.label ?? file.name,
          })
        );
      } catch (error) {
        predictionLibraryWarnings.push(
          `${file.name}: shared structure registration failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (bundle.job && !testMode && !hasOnlyKnownNonProteinInputs(bundle.job.settings)) {
      try {
        predictionResultIds.push(
          await (deps.registerPrediction ?? registerPredictionResult)({
            job: bundle.job,
            filePath: packagePath,
            coordinates: { text: file.content!, format: predictionFormat(file.name) },
            metrics: bundle.metrics,
            provenance,
          })
        );
      } catch (error) {
        predictionLibraryWarnings.push(
          `${file.name}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  const importDetails: ComputeImportDetails = {
    receipt: {
      schemaVersion: 2,
      provider: bundle.provider,
      tool: bundle.toolId,
      remoteId: bundle.remoteId,
      label: bundle.label ?? null,
      settingsHash: bundle.settingsHash ?? null,
      outputKind: bundle.outputKind,
      testMode,
      files: writtenPaths,
      urlOnly,
      metrics: bundle.metrics,
      provenance,
      importedAt: new Date().toISOString(),
      ...(destination ? { inspectionDestination: destination } : {}),
    },
    outputs,
  };

  const opened: string[] = [];
  try {
    if (destination && predictedFile?.content) {
      const attach = deps.attachPrediction ?? defaultDeps.attachPrediction!;
      await attach(destination.target, {
        jobRecordId: destination.jobRecordId,
        provider: bundle.provider,
        remoteId: bundle.remoteId,
        toolId: bundle.toolId,
        workspaceRoot,
        filePath: structurePaths[0],
        format: predictionFormat(predictedFile.name),
        sha256: await coordinateDigest(predictedFile.content),
        proteinSequenceSha256: destination.target.proteinSequenceSha256,
        metrics: bundle.metrics,
        provenance,
      });
    } else if (options.openViewer !== false && structurePaths.length > 0) {
      const first = structurePaths[0];
      const baseLabel = bundle.label ?? `${bundle.toolId} · ${bundle.provider}`;
      const label = testMode ? `${baseLabel} · test mode` : baseLabel;
      await deps.openStructure(first, label);
      opened.push(first);
    }
  } finally {
    deps.notifyFilesChanged?.(workspaceRoot, writtenPaths[0] ?? directory);
  }

  return {
    ok: true,
    workspaceRoot,
    writtenPaths,
    urlOnly,
    opened,
    metrics: bundle.metrics,
    provenance,
    catalogObservationIds,
    predictionResultIds,
    predictionLibraryWarnings,
    importDetails,
    ...(destination ? { inspectionAttached: true } : {}),
  };
}
