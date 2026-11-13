import { withUserMessage } from '@waypoint/user-messages';
import type { createPrimerRecoveryServices } from './primer-recovery-owner';
import type { LimsEntityActionInput } from '../lims';
import type { ArtifactRegistryOperations } from '../artifact-operation-ports';
import type { createCatalogRepository } from '../../db/catalog-repository';
import type { SequenceDocumentResolver } from '../sequence-document-location';
import type { createDnaSequenceOwner } from '../registry-artifacts/dna-sequence-owner';
import type {
  CatalogNumberAllocator,
  ArtifactHistoryPort,
  CooperativeYield,
  WorkspaceMutationRunner,
} from '../artifact-operation-ports';
import { primerArtifactRelativePath } from './primer-artifact-path';
import { readPrimerById } from './primer-repository';
import type { ArtifactIO } from '../artifact-io';
import type { buildInlineDnaSequenceRef } from '../registry-artifacts/dna-sequence-value';
import type { LimsEntity } from '../lims';
import type { CreatePrimerInput, Primer, PrimerOrigin, DeleteResult } from './types';
import type { PrimerTmCalculationService } from '../primer-tm-contract';
import type { ScientificAcceptedDocumentRevision } from '@waypoint/domain-services';
import {
  primerArtifactRegistryProjection,
  primerArtifactLegacyProjection,
  primerLegacyProjectionFromArtifact,
  primerOriginFromArtifactSource,
} from '../primers/primer-artifact-projection';
import { computeChecksum } from '@waypoint/sequence-utils';
import { isBinarySequencePath, parseSequenceFileAsDocument } from '../parse-sequence-file';
import { buildInlineRnaSequenceRef } from '../registry-artifacts/rna-sequence';
import {
  addPrimerArtifactBinding,
  BUILTIN_PRIMER_SCHEMA_ID,
  BUILTIN_RNA_OLIGO_SCHEMA_ID,
  buildPrimerArtifact,
  createBuiltinPrimerSchemaSnapshot,
  normalizePrimerArtifactPath,
  parsePrimerArtifact,
  primerArtifactNotes,
  resolvePrimerArtifactMetadata,
  removePrimerArtifactBinding,
  replaceOwnedPrimerArtifactBindings,
  revisePrimerArtifactContent,
  serializePrimerArtifact,
  sha256Hex,
  updatePrimerArtifactBinding as revisePrimerArtifactBinding,
  validatePrimerArtifactPath,
  type PrimerArtifactV1,
  type PrimerArtifactBindingV1,
  type PrimerDesignProvenanceV1,
  type PrimerTmCalculationV1,
  type PrimerArtifactContentRevisionInput,
  type PrimerAnnealingSegment,
} from './primer-artifact';
import { scientificIdentityPath } from '@waypoint/scientific-objects';
import { pathRelativeToBoundary } from '../path-boundary';
import {
  NativeArtifactPublicationPendingError,
  type ScientificArtifactPort,
  type ScientificArtifactPublicationInput,
} from '../scientific-artifact-port';
export class PrimerProjectionError extends Error {
  readonly code = 'PRIMER_REGISTRY_RECONCILIATION_REQUIRED';

  constructor(
    public readonly artifactPath: string,
    cause: unknown,
    public readonly retry?: () => Promise<SavedPrimerArtifact>
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Primer saved to ${artifactPath}, but registry projection failed. ` +
        `The file is safe and can be reconciled. ${detail}`
    );
    this.name = 'PrimerProjectionError';
  }
}
export class PrimerHistoryError extends Error {
  readonly code = 'PRIMER_GIT_HISTORY_REQUIRED';

  constructor(
    public readonly artifactPath: string,
    public readonly retry?: () => Promise<SavedPrimerArtifact>
  ) {
    super('Your oligo was saved, but its history could not be updated. Save again to retry.');
    this.name = 'PrimerHistoryError';
  }
}
export class PrimerArtifactRevisionError extends Error {
  readonly code = 'PRIMER_ARTIFACT_REVISION_STALE';

  constructor(
    public readonly expectedRevision: number,
    public readonly actualRevision: number
  ) {
    super(
      `Primer artifact revision is stale: expected ${expectedRevision}, current revision is ${actualRevision}. Read the primer again before retrying.`
    );
    this.name = 'PrimerArtifactRevisionError';
  }
}
type PrimerArtifactRevisionState = Awaited<
  ReturnType<
    ReturnType<PrimerArtifactDependencies['io']>['lims']['readPrimerArtifactRevisionState']
  >
>;
export type ReadyPrimerArtifactRevision = Extract<PrimerArtifactRevisionState, { state: 'ready' }>;
export type PendingPrimerArtifactPublication = Extract<
  PrimerArtifactRevisionState,
  { state: 'pending' }
>;
type PrimerArtifactRevisionRequest = Parameters<
  ReturnType<PrimerArtifactDependencies['io']>['lims']['revisePrimerArtifact']
>[0];
type PrimerArtifactRevisionResult = Awaited<
  ReturnType<ReturnType<PrimerArtifactDependencies['io']>['lims']['revisePrimerArtifact']>
>;
export class PrimerPublicationPendingError extends Error {
  readonly code = 'PRIMER_ARTIFACT_PUBLICATION_REQUIRED';
  constructor(
    public readonly pending: PendingPrimerArtifactPublication,
    message = 'This primer has an unfinished save. Retry that save before making another change.'
  ) {
    super(message);
    this.name = 'PrimerPublicationPendingError';
  }
}
export interface SavedPrimerArtifact {
  created: boolean;
  artifactPath: string;
  artifact: PrimerArtifactV1;
  limsEntity: LimsEntity;
  primer: Primer;
  gitCommitted: boolean;
  historyStatus?: 'committed' | 'not-git' | 'failed';

  publication?: { entityId: string; operationId: string };
  acceptedRevision?: ScientificAcceptedDocumentRevision;
}
export class PrimerAcceptedSavePendingError extends Error {
  constructor(
    readonly artifact: PrimerArtifactV1,
    readonly acceptedRevision: ScientificAcceptedDocumentRevision,
    cause: unknown,
    readonly saved?: SavedPrimerArtifact
  ) {
    super(
      cause instanceof Error
        ? cause.message
        : 'Primer Save accepted; project refresh remains pending.'
    );
    this.name = 'PrimerAcceptedSavePendingError';
    withUserMessage(this, 'document.saveRefreshPending');
  }
}
export interface ResolvedPrimerBinding {
  binding: PrimerArtifactV1['bindings'][number];
  sequenceId: number;
}
export interface ReadPrimerArtifactResult {
  path: string;
  content: string;
  artifact: PrimerArtifactV1;
  resolvedBindings: ResolvedPrimerBinding[];
  registeredRevision?: ReadyPrimerArtifactRevision;
  acceptedRevision?: ScientificAcceptedDocumentRevision | null;
}
export type UpdatePrimerArtifactContentInput = PrimerArtifactContentRevisionInput & {
  mutationToken?: string;
  artifactPath: string;
  workspaceRoot: string;
  expectedArtifactRevision: number;

  status?: Primer['status'];
  acceptedRevision?: ScientificAcceptedDocumentRevision | null;
};
export type FileAuthoritativePrimerInput = CreatePrimerInput & {
  artifactId?: string;
  artifactPath: string;
  workspaceRoot: string;
  requireRegistry: true;
  actor?: string;
  artifactSource?: PrimerArtifactV1['metadata']['source'];
  designProvenance?: PrimerDesignProvenanceV1;
  annealing?: PrimerAnnealingSegment;

  tmCalculation?: PrimerTmCalculationV1;
};
export interface PrimerMutationOptions {
  mutationToken?: string;
  parentActionId?: string;
}
export interface PrimerReadOptions extends PrimerMutationOptions {
  bindingResolution?: 'projected' | 'verified';
}
export interface AttachPrimerArtifactInput {
  primer: Primer;
  workspaceRoot: string;
  targetWorkspaceRoot?: string;
  targetFilePath: string;
  targetDocumentId: string;
  bindingSequenceId: number;
  bindingStart: number;
  bindingEnd: number;
  bindingStrand: 1 | -1;
  expectedArtifactRevision?: number;
  source?: PrimerArtifactBindingV1['source'];
  alignment?: PrimerArtifactBindingV1['alignment'];
  history?: PrimerArtifactBindingV1['history'];
}
export interface UpdatePrimerArtifactBindingInput extends AttachPrimerArtifactInput {
  bindingId: string;
  expectedArtifactRevision: number;
}
export type SavedPrimerBindingTargetInput = Pick<
  AttachPrimerArtifactInput,
  'workspaceRoot' | 'targetFilePath' | 'targetDocumentId' | 'bindingSequenceId'
> & { expectedFileSha256: string };

export type PersistOwnedPrimerArtifactBindingsInput = SavedPrimerBindingTargetInput & {
  primer: Primer;
  ownedBindingIds: string[];
  bindings: { bindingId: string; start: number; end: number; strand: 1 | -1 }[];
};

export interface OwnedPrimerBindingMutation {
  bindingId: string;
  bindingMutation: 'created' | 'duplicate' | 'updated';
}

export type PrimerArtifactBindingMutationResult = SavedPrimerArtifact & {
  bindingMutation: 'created' | 'duplicate' | 'updated';
  bindingId: string;
};
export interface DetachPrimerArtifactInput {
  primer: Primer;
  workspaceRoot: string;
  bindingId: string;
  expectedArtifactRevision?: number;
}
export interface PrimerArtifactWorkspaceReconcileResult {
  discovered: number;
  reconciled: number;
  errors: Array<{ path: string; message: string; primerName?: string }>;
  recovered?: number;
}
export interface WriteAndProjectedPrimerArtifact {
  artifactPath: string;
  artifact: PrimerArtifactV1;
  limsEntity: LimsEntity;
  primer: Primer;

  limsPathsBefore: Set<string>;

  created: boolean;
  acceptedRevision?: ScientificAcceptedDocumentRevision;
}
export interface PrimerArtifactDependencies {
  recovery: ReturnType<typeof createPrimerRecoveryServices>;
  archiveLimsEntity(
    input: LimsEntityActionInput,
    options?: Parameters<ArtifactRegistryOperations['updateLimsEntity']>[1]
  ): Promise<LimsEntity>;
  scientific?: ScientificArtifactPort;
  io(): {
    shell?: { trashItem(path: string, mutationToken?: string): Promise<void> };
    fs: Pick<
      ArtifactIO['fs'],
      | 'stat'
      | 'readFile'
      | 'exists'
      | 'readDir'
      | 'readTextFile'
      | 'validateWorkspacePath'
      | 'writeWorkspaceTextFileAtomic'
    >;
    db: Pick<ArtifactIO['db'], 'execute' | 'select' | 'replacePrimerProjection'>;
    lims: Pick<
      ArtifactIO['lims'],
      | 'repairEntityProjectionFromAudit'
      | 'readPrimerArtifactRevisionState'
      | 'revisePrimerArtifact'
      | 'resumePrimerArtifactPublication'
    >;
  };
  buildFileDnaSequenceRef: ReturnType<typeof createDnaSequenceOwner>['buildFileDnaSequenceRef'];
  buildInlineDnaSequenceRef: typeof buildInlineDnaSequenceRef;
  queryLimsEntities: ArtifactRegistryOperations['queryLimsEntities'];
  registerLimsEntity: ArtifactRegistryOperations['registerLimsEntity'];
  restoreLimsEntity: ArtifactRegistryOperations['restoreLimsEntity'];
  updateLimsEntity: ArtifactRegistryOperations['updateLimsEntity'];
  generateCatalogNumber: CatalogNumberAllocator;
  gitCommitPaths: ArtifactHistoryPort['gitCommitPaths'];
  gitStatus: ArtifactHistoryPort['gitStatus'];
  isGitRepo: ArtifactHistoryPort['isGitRepo'];
  cooperateWithRendererInteraction: CooperativeYield;
  bindCatalogEntityToFile: ReturnType<typeof createCatalogRepository>['bindCatalogEntityToFile'];
  getCatalogEntity: ReturnType<typeof createCatalogRepository>['getCatalogEntity'];
  getCatalogFileForPath: ReturnType<typeof createCatalogRepository>['getCatalogFileForPath'];
  markCatalogFileHistorical: ReturnType<
    typeof createCatalogRepository
  >['markCatalogFileHistorical'];
  markCatalogFileMissing: ReturnType<typeof createCatalogRepository>['markCatalogFileMissing'];
  releaseMissingCatalogFilePath: ReturnType<
    typeof createCatalogRepository
  >['releaseMissingCatalogFilePath'];
  registerCatalogEntity: ReturnType<typeof createCatalogRepository>['registerCatalogEntity'];
  primerTmCalculationService: PrimerTmCalculationService;
  resolveSequenceDocumentById: SequenceDocumentResolver;
  withRendererWorkspaceMutation: WorkspaceMutationRunner;
}
export function createPrimerArtifactOwner(dependencies: PrimerArtifactDependencies) {
  const {
    buildFileDnaSequenceRef,
    queryLimsEntities,
    registerLimsEntity,
    restoreLimsEntity,
    updateLimsEntity,
    generateCatalogNumber,
    gitCommitPaths,
    gitStatus,
    isGitRepo,
    cooperateWithRendererInteraction,
    bindCatalogEntityToFile,
    getCatalogEntity,
    getCatalogFileForPath,
    markCatalogFileHistorical,
    markCatalogFileMissing,
    releaseMissingCatalogFilePath,
    registerCatalogEntity,
    primerTmCalculationService,
    resolveSequenceDocumentById,
    withRendererWorkspaceMutation,
  } = dependencies;
  const buildInlineDnaSequenceRef = dependencies.buildInlineDnaSequenceRef;
  const archiveLimsEntity = dependencies.archiveLimsEntity;
  const {
    primerRecoverySourceFingerprint,
    primerRecoveryRelationshipsFingerprint,
    recoverPrimerRecordsInWorkspace,
    persistPrimerRecoveryReport,
    readPrimerRecoveryDocument,
    findTrashedPrimerDocument,
  } = dependencies.recovery;
  const platform = dependencies.io;
  const readScientificNamespace = (root: string) =>
    dependencies.scientific?.namespace(root) ?? Promise.resolve(null);
  const readScientificText = (
    path: string,
    root: string,
    readLegacy?: (path: string) => Promise<string>,
    acceptedHead?: string
  ) =>
    dependencies.scientific?.readText(path, root, readLegacy, acceptedHead) ??
    (readLegacy ?? dependencies.io().fs.readTextFile)(path).then((content) => ({
      content,
      acceptedRevision: null,
    }));
  const publishNativeArtifact = (input: ScientificArtifactPublicationInput) => {
    if (!dependencies.scientific)
      throw new Error('Scientific publication authority is unavailable.');
    return dependencies.scientific.publish(input);
  };
  const getPrimerById = (id: string) => {
    if (!dependencies.scientific)
      throw new Error('Accepted primer projection authority is unavailable.');
    return dependencies.scientific.primerById(id);
  };
  const scientificRelationshipGitPaths = (root: string, dirty: ReadonlyMap<string, unknown>) =>
    dependencies.scientific?.relationshipGitPaths(root, dirty) ?? Promise.resolve([]);
  function expectedArtifactSource(
    origin: PrimerOrigin | undefined,
    target: unknown | null,
    artifactSource?: PrimerArtifactV1['metadata']['source']
  ): PrimerArtifactV1['metadata']['source'] {
    if (artifactSource) return artifactSource;
    return origin === 'assembly' ? 'assembly' : target ? 'drag-selection' : 'manual';
  }
  const PRIMER_DISCOVERY_EXCLUDED_DIRECTORIES = new Set([
    '.git',
    '.venv',
    'node_modules',
    'dist',
    'dist-electron',
  ]);
  const PRIMER_DISCOVERY_MAX_ENTRIES = 100000;
  const PRIMER_DISCOVERY_MAX_DEPTH = 40;
  function isFileAuthoritativePrimerInput(
    input: CreatePrimerInput
  ): input is FileAuthoritativePrimerInput {
    return (
      input.requireRegistry === true &&
      typeof input.artifactPath === 'string' &&
      typeof input.workspaceRoot === 'string'
    );
  }
  async function calculateArtifactTm(
    sequence: string,
    pinned?: PrimerDesignProvenanceV1['tm']
  ): Promise<PrimerTmCalculationV1> {
    if (pinned) return pinned;
    return primerTmCalculationService.calculate(sequence, {
      onProviderError: (error) =>
        console.warn(
          '[primer-artifact] Selected Tm provider unavailable; saving the marked local fallback.',
          error
        ),
    });
  }
  async function prepareUnboundPrimerArtifact(
    input: FileAuthoritativePrimerInput,
    options: PrimerMutationOptions & { now?: number } = {}
  ): Promise<PrimerArtifactV1> {
    if (
      input.targetDocumentId != null ||
      input.targetFilePath != null ||
      input.bindingSequenceId != null
    )
      throw new Error('This primer capture requires an unbound assembly oligo.');
    const workspaceId = input.workspaceId ?? (await resolveWorkspaceId(input.workspaceRoot));
    return prepareNewPrimerArtifact(input, null, workspaceId, options.mutationToken, options.now);
  }
  async function prepareNewPrimerArtifact(
    input: FileAuthoritativePrimerInput,
    target: Awaited<ReturnType<typeof buildFileDnaSequenceRef>> | null,
    workspaceId: number | null,
    mutationToken?: string,
    now?: number
  ): Promise<PrimerArtifactV1> {
    const catalogNumber = await generateCatalogNumber(
      workspaceId ?? 0,
      input.workspaceRoot,
      mutationToken
    );
    const tmCalculation =
      input.oligo?.orderType === 'rna'
        ? undefined
        : (input.tmCalculation ??
          (await calculateArtifactTm(
            input.annealing?.pbsSequence ?? input.sequence,
            input.designProvenance?.tm
          )));
    return buildPrimerArtifact({
      id: input.artifactId ?? randomId(),
      catalogNumber,
      name: input.name,
      sequence: input.sequence,
      oligo: input.oligo,
      workspaceRoot: input.workspaceRoot,
      artifactPath: normalizePrimerArtifactPath(input.artifactPath),
      binding: target
        ? {
            id: randomId(),
            targetDocumentId: target.documentId,
            targetFilePath: input.targetFilePath!,
            targetLength: target.length,
            targetTopology: target.topology,
            targetFileContentHash: target.fileContentHash ?? target.contentHash,
            targetNormalizedSequenceHash: target.normalizedSequenceHash ?? target.contentHash,
            start: input.bindingStart!,
            end: input.bindingEnd!,
            strand: input.bindingStrand!,
          }
        : undefined,
      application: input.application,
      notes: input.notes,
      actor: input.actor ?? 'local-user',
      source: expectedArtifactSource(input.origin, target, input.artifactSource),
      designProvenance: input.designProvenance,
      annealing: input.annealing,
      ...(tmCalculation ? { tmCalculation } : {}),
      entitySchema: input.entitySchema,
      entityFields: input.entityFields,
      inventory: {
        origin:
          input.origin ??
          primerOriginFromArtifactSource(
            expectedArtifactSource(input.origin, target, input.artifactSource)
          ),
        originDetails: input.originDetails ?? null,
        vendor: input.oligo?.vendor ?? null,
        modifications: input.oligo?.notation ?? null,
        orderDate: null,
        scale: null,
        purification: null,
        stockLocation: null,
        concentration: null,
      },
      ...(now === undefined ? {} : { now }),
    });
  }
  async function writeAndProjectPrimerArtifact(
    input: FileAuthoritativePrimerInput,
    options: PrimerMutationOptions = {}
  ): Promise<WriteAndProjectedPrimerArtifact> {
    return withRendererWorkspaceMutation(
      input.workspaceRoot,
      (mutationToken) =>
        writeAndProjectPrimerArtifactInMutation(input, mutationToken, options.parentActionId),
      options.mutationToken
    );
  }
  async function resolvePrimerArtifactPath(path: string, workspaceRoot: string): Promise<string> {
    const fs = platform().fs;
    if (!(await fs.validateWorkspacePath({ workspaceRoot, path, allowMissing: true })))
      throw new Error(
        'Primer files must be saved inside the owning project without symbolic links.'
      );
    const missing: string[] = [];
    let ancestor = path.replace(/\\/gu, '/');
    while (!(await fs.exists(ancestor))) {
      const slash = ancestor.lastIndexOf('/');
      if (slash < 0) throw new Error('The primer project path is unavailable.');
      missing.unshift(ancestor.slice(slash + 1));
      ancestor = ancestor.slice(0, slash) || '/';
    }
    const [existing, root] = await Promise.all([fs.stat(ancestor), fs.stat(workspaceRoot)]);
    if (missing.length && !existing.isDirectory)
      throw new Error('The primer save location is not a directory.');
    const canonical = [
      existing.canonicalPath.replace(/\\/gu, '/').replace(/\/$/u, ''),
      ...missing,
    ].join('/');
    const relative = pathRelativeToBoundary(canonical, root.canonicalPath.replace(/\\/gu, '/'));
    if (!relative) throw new Error('The primer path does not belong to its project.');

    return `${workspaceRoot.replace(/\\/gu, '/').replace(/\/$/u, '')}/${relative}`;
  }
  async function writeAndProjectPrimerArtifactInMutation(
    supplied: FileAuthoritativePrimerInput,
    mutationToken?: string,
    parentActionId?: string
  ): Promise<WriteAndProjectedPrimerArtifact> {
    const captured = structuredClone(supplied);
    if (
      captured.artifactId !== undefined &&
      (!captured.artifactId || captured.artifactId.trim() !== captured.artifactId)
    )
      throw new Error(
        'A supplied primer artifact identity must be nonempty and unchanged by trimming.'
      );
    const requestedPath = normalizePrimerArtifactPath(captured.artifactPath);
    const requestedValidation = validatePrimerArtifactPath(requestedPath, captured.workspaceRoot);
    if (!requestedValidation.valid) throw new Error(requestedValidation.error);
    const artifactPath = await resolvePrimerArtifactPath(requestedPath, captured.workspaceRoot);
    const input = { ...captured, artifactPath };
    const pathValidation = validatePrimerArtifactPath(artifactPath, input.workspaceRoot);
    if (!pathValidation.valid) throw new Error(pathValidation.error);
    const workspaceId = await resolveWorkspaceId(input.workspaceRoot);
    if (workspaceId == null) throw new Error('Primer creation requires a registered project.');
    if (input.workspaceId != null && input.workspaceId !== workspaceId) {
      throw new Error('The primer save location does not belong to the supplied project.');
    }
    const namespace = await readScientificNamespace(input.workspaceRoot);

    const hasBinding =
      typeof input.targetFilePath === 'string' &&
      typeof input.targetDocumentId === 'string' &&
      input.targetDocumentId.length > 0 &&
      typeof input.targetLength === 'number' &&
      (input.targetTopology === 'linear' || input.targetTopology === 'circular') &&
      typeof input.bindingSequenceId === 'number' &&
      typeof input.bindingStart === 'number' &&
      typeof input.bindingEnd === 'number' &&
      (input.bindingStrand === 1 || input.bindingStrand === -1);
    const hasPartialBinding =
      input.targetFilePath != null ||
      input.targetDocumentId != null ||
      input.targetLength != null ||
      input.targetTopology != null ||
      input.bindingSequenceId != null ||
      input.bindingStart != null ||
      input.bindingEnd != null ||
      input.bindingStrand != null;
    if (hasPartialBinding && !hasBinding) {
      throw new Error('Primer binding metadata is incomplete; select the target range again.');
    }
    if (
      hasBinding &&
      !(await platform().fs.validateWorkspacePath({
        workspaceRoot: input.workspaceRoot,
        path: input.targetFilePath!,
      }))
    ) {
      throw new Error('The primer target sequence must be inside the owning project.');
    }
    const target = hasBinding
      ? await buildFileDnaSequenceRef(input.targetFilePath!, {
          workspaceRoot: input.workspaceRoot,
          documentId: input.targetDocumentId!,
        })
      : null;
    if (target && (target.sequenceId == null || target.sequenceId !== input.bindingSequenceId)) {
      throw new Error('The selected target no longer matches its stable sequence identity.');
    }
    if (namespace) {
      const existing = namespace.entries.find(
        (slot) => !slot.tombstone && slot.path === pathValidation.relativePath
      );
      if (existing) {
        const loaded = await readScientificText(artifactPath, input.workspaceRoot);
        const artifact = parsePrimerArtifact(loaded.content);
        if (
          !loaded.acceptedRevision ||
          loaded.acceptedRevision.resourceId !== existing.resourceId ||
          !matchesRetry(artifact, input, target)
        )
          throw new Error(
            'A different accepted primer already exists there. Open it to edit, or choose a new file name.'
          );
        const limsPathsBefore = await currentDirtyLimsPaths(input.workspaceRoot, mutationToken);
        const projected = await publishAcceptedPrimerArtifact(
          artifactPath,
          input.workspaceRoot,
          artifact,
          { prior: loaded.acceptedRevision },
          mutationToken,
          loaded.content
        );
        return { artifactPath, artifact, ...projected, limsPathsBefore, created: false };
      }
      if (await platform().fs.exists(artifactPath))
        throw new Error(
          'A working file already exists at that location. Choose a new file name or enroll it explicitly.'
        );
    }
    if (!namespace && (await platform().fs.exists(artifactPath))) {
      let existingArtifact: PrimerArtifactV1;
      try {
        existingArtifact = parsePrimerArtifact(await platform().fs.readTextFile(artifactPath));
      } catch {
        throw new Error('A file already exists at that location. Choose a new file name.');
      }
      if (!matchesRetry(existingArtifact, input, target)) {
        throw new Error(
          'A different primer artifact already exists there. Choose a new file name.'
        );
      }
      const limsPathsBefore = await currentDirtyLimsPaths(input.workspaceRoot, mutationToken);
      let projected: { limsEntity: LimsEntity; primer: Primer };
      try {
        projected = await projectPrimerArtifact(existingArtifact, input.workspaceRoot, {
          mutationToken,
          parentActionId,
        });
      } catch (error) {
        throw new PrimerProjectionError(artifactPath, error);
      }
      return {
        artifactPath,
        artifact: existingArtifact,
        ...projected,
        limsPathsBefore,
        created: false,
      };
    }

    const id = input.artifactId ?? randomId();
    const catalogNumber = await generateCatalogNumber(
      workspaceId ?? 0,
      input.workspaceRoot,
      mutationToken
    );
    const orderType = input.oligo?.orderType ?? 'dna';
    const tmCalculation =
      orderType === 'rna'
        ? undefined
        : (input.tmCalculation ??
          (await calculateArtifactTm(
            input.annealing?.pbsSequence ?? input.sequence,
            input.designProvenance?.tm
          )));
    const artifact = await buildPrimerArtifact({
      id,
      catalogNumber,
      name: input.name,
      sequence: input.sequence,
      oligo: input.oligo,
      workspaceRoot: input.workspaceRoot,
      artifactPath,
      binding: target
        ? {
            id: randomId(),
            targetDocumentId: target.documentId,
            targetFilePath: input.targetFilePath!,
            targetLength: target.length,
            targetTopology: target.topology,
            targetFileContentHash: target.fileContentHash ?? target.contentHash,
            targetNormalizedSequenceHash: target.normalizedSequenceHash ?? target.contentHash,
            start: input.bindingStart!,
            end: input.bindingEnd!,
            strand: input.bindingStrand!,
          }
        : undefined,
      application: input.application,
      notes: input.notes,
      actor: input.actor ?? 'local-user',

      source: expectedArtifactSource(input.origin, target, input.artifactSource),
      designProvenance: input.designProvenance,
      annealing: input.annealing,
      ...(tmCalculation ? { tmCalculation } : {}),
      entitySchema: input.entitySchema,
      entityFields: input.entityFields,
      inventory: {
        origin:
          input.origin ??
          primerOriginFromArtifactSource(
            expectedArtifactSource(input.origin, target, input.artifactSource)
          ),
        originDetails: input.originDetails ?? null,
        vendor: input.oligo?.vendor ?? null,
        modifications: input.oligo?.notation ?? null,
        orderDate: null,
        scale: null,
        purification: null,
        stockLocation: null,
        concentration: null,
      },
    });
    if (namespace) {
      const limsPathsBefore = await currentDirtyLimsPaths(input.workspaceRoot, mutationToken);
      const projected = await publishAcceptedPrimerArtifact(
        artifactPath,
        input.workspaceRoot,
        artifact,
        { prior: null, expectedHead: namespace.head },
        mutationToken
      );
      return { artifactPath, artifact, ...projected, limsPathsBefore, created: true };
    }

    await platform().fs.writeWorkspaceTextFileAtomic({
      workspaceRoot: input.workspaceRoot,
      path: artifactPath,
      content: serializePrimerArtifact(artifact),
      mode: 'create',
      mutationToken,
    });

    const limsPathsBefore = await currentDirtyLimsPaths(input.workspaceRoot, mutationToken);
    let projected: { limsEntity: LimsEntity; primer: Primer };
    try {
      const priorFile = await getCatalogFileForPath(artifactPath);
      if (priorFile && priorFile.entity_id !== artifact.id && priorFile.status === 'current') {
        await markCatalogFileMissing(artifactPath, 'replaced-after-exclusive-create');
      }
      projected = await projectPrimerArtifact(artifact, input.workspaceRoot, {
        mutationToken,
        parentActionId,
      });
    } catch (error) {
      throw new PrimerProjectionError(artifactPath, error);
    }
    return { artifactPath, artifact, ...projected, limsPathsBefore, created: true };
  }
  async function savePrimerArtifact(
    input: FileAuthoritativePrimerInput,
    options: PrimerMutationOptions = {}
  ): Promise<SavedPrimerArtifact> {
    return withRendererWorkspaceMutation(
      input.workspaceRoot,
      async (mutationToken) => {
        const {
          artifactPath,
          artifact,
          limsEntity,
          primer,
          limsPathsBefore,
          created,
          acceptedRevision,
        } = await writeAndProjectPrimerArtifactInMutation(
          input,
          mutationToken,
          options.parentActionId
        );
        const gitStatus = await commitPrimerArtifactHistory(
          input.workspaceRoot,
          artifact.file.workspaceRelativePath,
          artifact.name,
          limsPathsBefore,
          'Add',
          mutationToken,
          acceptedRevision ? [scientificIdentityPath] : []
        );
        if (gitStatus === 'failed') {
          if (acceptedRevision)
            throw new PrimerAcceptedSavePendingError(
              artifact,
              acceptedRevision,
              new PrimerHistoryError(artifactPath)
            );
          throw new PrimerHistoryError(artifactPath);
        }
        return {
          artifactPath,
          artifact,
          limsEntity,
          primer,
          created,
          gitCommitted: gitStatus === 'committed',
          ...(acceptedRevision ? { acceptedRevision } : {}),
        };
      },
      options.mutationToken
    );
  }
  async function reconcilePrimerArtifact(
    artifactPath: string,
    workspaceRoot: string,
    options: PrimerMutationOptions = {}
  ): Promise<{ artifact: PrimerArtifactV1; limsEntity: LimsEntity; primer: Primer }> {
    const normalizedPath = normalizePrimerArtifactPath(artifactPath);
    const validation = validatePrimerArtifactPath(normalizedPath, workspaceRoot);
    if (!validation.valid) throw new Error(validation.error);
    if (
      !(await platform().fs.validateWorkspacePath({
        workspaceRoot,
        path: normalizedPath,
      }))
    ) {
      throw new Error('Primer files must be saved inside the owning project.');
    }
    const artifact = parsePrimerArtifact(
      (await readScientificText(normalizedPath, workspaceRoot)).content
    );
    if (artifact.file.workspaceRelativePath !== validation.relativePath) {
      throw new Error(
        `Primer artifact path mismatch: manifest says ${artifact.file.workspaceRelativePath}, ` +
          `file is ${validation.relativePath}.`
      );
    }
    return { artifact, ...(await projectPrimerArtifact(artifact, workspaceRoot, options)) };
  }
  async function reconcilePrimerArtifactsInWorkspace(
    workspaceRoot: string,
    options: {
      signal?: AbortSignal;
      candidatePaths?: readonly string[];
      acceptedPaths?: readonly string[];
      mutationToken?: string;
    } = {}
  ): Promise<PrimerArtifactWorkspaceReconcileResult> {
    const { signal, candidatePaths } = options;
    const acceptedPaths = new Set(options.acceptedPaths ?? []);
    signal?.throwIfAborted();
    const result: PrimerArtifactWorkspaceReconcileResult = {
      discovered: 0,
      reconciled: 0,
      errors: [],
    };
    const recovery = await recoverPrimerRecordsInWorkspace(
      workspaceRoot,
      {
        read: readPrimerRecoveryDocument,
        project: projectPrimerArtifact,
        commit: commitPrimerBatchHistory,
        dirtyPaths: currentDirtyLimsPaths,
        retireTrashed: retireTrashedPrimerArtifact,
      },
      options
    );
    if (recovery.recovered > 0) result.recovered = recovery.recovered;
    result.errors.push(...recovery.errors);
    const candidates: string[] = candidatePaths ? [...candidatePaths] : [];
    let scannedEntries = 0;
    let scanWorkUnits = 0;
    let limitReported = false;

    async function scanDirectory(directoryPath: string, depth: number): Promise<void> {
      signal?.throwIfAborted();
      if (depth > PRIMER_DISCOVERY_MAX_DEPTH || scannedEntries >= PRIMER_DISCOVERY_MAX_ENTRIES) {
        if (!limitReported) {
          result.errors.push({
            path: directoryPath,
            message: 'Primer discovery stopped at the project scan safety limit.',
          });
          limitReported = true;
        }
        return;
      }

      let entries: Array<{ name: string; isDirectory: boolean; isFile: boolean }>;
      try {
        entries = await platform().fs.readDir(directoryPath);
      } catch (error) {
        result.errors.push({
          path: directoryPath,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      for (const entry of entries) {
        await cooperateWithRendererInteraction(scanWorkUnits++, { signal });
        signal?.throwIfAborted();
        if (scannedEntries >= PRIMER_DISCOVERY_MAX_ENTRIES) break;
        scannedEntries++;
        const entryPath = workspaceAbsolutePath(directoryPath, entry.name);
        if (entry.isDirectory) {
          if (!PRIMER_DISCOVERY_EXCLUDED_DIRECTORIES.has(entry.name)) {
            await scanDirectory(entryPath, depth + 1);
          }
          continue;
        }
        if (!entry.isFile) continue;
        if (entry.name.toLowerCase().endsWith('.primer.json')) candidates.push(entryPath);
        if (scannedEntries >= PRIMER_DISCOVERY_MAX_ENTRIES) break;
      }
    }

    if (candidatePaths === undefined) await scanDirectory(workspaceRoot, 0);
    signal?.throwIfAborted();
    candidates.sort((a, b) => a.localeCompare(b));
    result.discovered = candidates.length;

    const parsed: Array<{ path: string; artifact: PrimerArtifactV1; contentHash: string }> = [];
    for (const path of candidates) {
      if (acceptedPaths.has(path)) continue;
      await cooperateWithRendererInteraction(scanWorkUnits++, { signal });
      signal?.throwIfAborted();
      try {
        if (!(await platform().fs.validateWorkspacePath({ workspaceRoot, path }))) {
          throw new Error('Primer files must be saved inside the owning project.');
        }
        const { content } = await readScientificText(path, workspaceRoot);
        const artifact = parsePrimerArtifact(content);
        const validation = validatePrimerArtifactPath(path, workspaceRoot);
        if (!validation.valid || artifact.file.workspaceRelativePath !== validation.relativePath) {
          throw new Error(
            'Primer artifact path does not match its project-relative manifest path.'
          );
        }
        parsed.push({ path, artifact, contentHash: await sha256Hex(content) });
      } catch (error) {
        result.errors.push({
          path,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const blockedPaths = duplicateArtifactPaths(parsed, 'id', 'stable primer ID', result.errors);
    for (const path of recovery.pendingArtifactPaths) blockedPaths.add(path);
    for (const path of duplicateArtifactPaths(
      parsed,
      'catalogNumber',
      'catalog number',
      result.errors
    )) {
      blockedPaths.add(path);
    }

    for (const candidate of parsed) {
      await cooperateWithRendererInteraction(scanWorkUnits++, { signal });
      signal?.throwIfAborted();
      if (blockedPaths.has(candidate.path)) continue;
      try {
        const { content: currentContent } = await readScientificText(candidate.path, workspaceRoot);
        if ((await sha256Hex(currentContent)) !== candidate.contentHash) {
          throw new Error('Primer artifact changed during project reconciliation; retry the scan.');
        }
        await projectPrimerArtifact(candidate.artifact, workspaceRoot, {
          mutationToken: options.mutationToken,
        });
        result.reconciled++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const record = recovery.records.find((entry) => entry.id === candidate.artifact.id);
        if (record) {
          record.status = 'unresolved';
          record.message = message;
        } else {
          recovery.records.push({
            id: candidate.artifact.id,
            name: candidate.artifact.name,
            source: candidate.artifact.recovery?.source ?? 'registry',
            status: 'unresolved',
            artifactPath: candidate.path,
            message,
          });
        }
        result.errors.push({
          path: candidate.path,
          message,
        });
      }
    }

    await persistPrimerRecoveryReport(workspaceRoot, recovery, result.errors);
    return result;
  }
  async function attachPrimerArtifact(
    input: AttachPrimerArtifactInput,
    options: PrimerMutationOptions = {}
  ): Promise<PrimerArtifactBindingMutationResult> {
    return withRendererWorkspaceMutation(
      input.workspaceRoot,
      async (mutationToken) => {
        const loaded = await loadArtifactForPrimer(input.primer, input.workspaceRoot, {
          mutationToken,
        });
        assertExpectedArtifactRevision(loaded.artifact, input.expectedArtifactRevision);
        const targetRoot = input.targetWorkspaceRoot ?? input.workspaceRoot;
        const targetProjectId =
          targetRoot === input.workspaceRoot
            ? undefined
            : await requirePrimerTargetProjectId(targetRoot);
        if (
          !(await platform().fs.validateWorkspacePath({
            workspaceRoot: targetRoot,
            path: input.targetFilePath,
          }))
        ) {
          throw new Error(
            'The primer target must be inside its explicitly selected source project.'
          );
        }
        const target = loaded.registeredRevision
          ? await readRegisteredPrimerBindingTarget(input, loaded.registeredRevision.workspaceId)
          : await buildFileDnaSequenceRef(input.targetFilePath, {
              workspaceRoot: targetRoot,
              documentId: input.targetDocumentId,
            });
        if (
          target.sequenceId !== input.bindingSequenceId ||
          target.documentId !== input.targetDocumentId
        ) {
          throw new Error('The selected target no longer matches its stable sequence identity.');
        }
        const binding: PrimerArtifactBindingV1 = {
          id: randomId(),
          relation: 'binds_to_sequence',
          target: {
            documentId: target.documentId,
            ...(targetProjectId ? { projectId: targetProjectId } : {}),
            topology: target.topology,
            length: target.length,
            fileContentHash: target.fileContentHash ?? target.contentHash,
            normalizedSequenceHash: target.normalizedSequenceHash ?? target.contentHash,
          },
          coordinates: {
            system: 'zero_based_half_open',
            start: input.bindingStart,
            end: input.bindingEnd,
            strand: input.bindingStrand,
          },
          source: input.source ?? 'manual',
          ...(input.history ? { history: input.history } : {}),
          ...(input.alignment ? { alignment: input.alignment } : {}),
        };
        if (loaded.registeredRevision) {
          const saved = await publishRegisteredPrimerRevision(
            loaded,
            input.workspaceRoot,
            { type: 'binding_add', binding },
            mutationToken
          );
          return {
            ...saved.saved,
            bindingMutation: saved.result.changed ? 'created' : 'duplicate',
            bindingId: saved.result.bindingId ?? binding.id,
          };
        }
        const duplicate = loaded.artifact.bindings.find((existing) =>
          equivalentBinding(existing, binding)
        );
        if (duplicate) {
          const persisted = await persistRevisedPrimerArtifact(
            loaded.path,
            input.workspaceRoot,
            loaded.content,
            loaded.artifact,
            mutationToken,
            loaded.acceptedRevision
          );
          return { ...persisted, bindingMutation: 'duplicate', bindingId: duplicate.id };
        }
        const revised = parsePrimerArtifact(
          serializePrimerArtifact(addPrimerArtifactBinding(loaded.artifact, binding))
        );
        const persisted = await persistRevisedPrimerArtifact(
          loaded.path,
          input.workspaceRoot,
          loaded.content,
          revised,
          mutationToken,
          loaded.acceptedRevision
        );
        return { ...persisted, bindingMutation: 'created', bindingId: binding.id };
      },
      options.mutationToken
    );
  }
  async function readSavedPrimerBindingTarget(input: SavedPrimerBindingTargetInput) {
    if (
      !(await platform().fs.validateWorkspacePath({
        workspaceRoot: input.workspaceRoot,
        path: input.targetFilePath,
      }))
    ) {
      throw new Error('The primer target sequence must be inside the owning project.');
    }
    const target = await buildFileDnaSequenceRef(input.targetFilePath, {
      workspaceRoot: input.workspaceRoot,
      documentId: input.targetDocumentId,
    });
    if (
      target.sequenceId !== input.bindingSequenceId ||
      target.documentId !== input.targetDocumentId
    ) {
      throw new Error('The selected target no longer matches its stable sequence identity.');
    }
    if ((target.fileContentHash ?? target.contentHash) !== input.expectedFileSha256) {
      throw new Error(
        'The sequence file changed after the captured Save; copied primer bindings remain pending.'
      );
    }
    return target;
  }

  async function persistOwnedPrimerArtifactBindings(
    input: PersistOwnedPrimerArtifactBindingsInput,
    options: PrimerMutationOptions & { retainAcceptedHistoryPending?: boolean } = {}
  ): Promise<SavedPrimerArtifact & { bindingMutations: OwnedPrimerBindingMutation[] }> {
    return withRendererWorkspaceMutation(
      input.workspaceRoot,
      async (mutationToken) => {
        const target = await readSavedPrimerBindingTarget(input);
        const ownedIds = new Set(input.ownedBindingIds);
        const loaded = await loadArtifactForPrimer(
          input.primer,
          input.workspaceRoot,
          { mutationToken },
          { documentId: input.targetDocumentId, ids: ownedIds }
        );
        for (const binding of loaded.artifact.bindings) {
          if (ownedIds.has(binding.id) && binding.target.documentId !== input.targetDocumentId) {
            throw new Error('The copied primer attachment belongs to another document.');
          }
        }
        const unowned = loaded.artifact.bindings.filter((binding) => !ownedIds.has(binding.id));
        const bindings: PrimerArtifactBindingV1[] = [];
        const bindingMutations: OwnedPrimerBindingMutation[] = [];
        for (const desired of input.bindings) {
          if (!ownedIds.has(desired.bindingId)) {
            throw new Error('The copied primer attachment has no ownership intent.');
          }
          const binding: PrimerArtifactBindingV1 = {
            id: desired.bindingId,
            relation: 'binds_to_sequence',
            target: {
              documentId: target.documentId,
              topology: target.topology,
              length: target.length,
              fileContentHash: target.fileContentHash ?? target.contentHash,
              normalizedSequenceHash: target.normalizedSequenceHash ?? target.contentHash,
            },
            coordinates: {
              system: 'zero_based_half_open',
              start: desired.start,
              end: desired.end,
              strand: desired.strand,
            },
            source: 'manual',
          };
          const duplicate = [...unowned, ...bindings].find((existing) =>
            equivalentBinding(existing, binding)
          );
          if (duplicate) {
            bindingMutations.push({ bindingId: duplicate.id, bindingMutation: 'duplicate' });
          } else {
            bindings.push(binding);
            bindingMutations.push({
              bindingId: binding.id,
              bindingMutation: loaded.artifact.bindings.some(
                (existing) => existing.id === binding.id
              )
                ? 'updated'
                : 'created',
            });
          }
        }
        const nextBindings = [...unowned, ...bindings];
        const revised =
          JSON.stringify(nextBindings) === JSON.stringify(loaded.artifact.bindings)
            ? loaded.artifact
            : parsePrimerArtifact(
                serializePrimerArtifact(
                  replaceOwnedPrimerArtifactBindings(loaded.artifact, ownedIds, bindings)
                )
              );
        if (loaded.registeredRevision) {
          const saved = await publishRegisteredPrimerRevision(
            loaded,
            input.workspaceRoot,
            {
              type: 'bindings_replace_owned',
              ownedBindingIds: [...ownedIds],
              targetDocumentId: input.targetDocumentId,
              bindings,
            },
            mutationToken
          );
          return { ...saved.saved, bindingMutations };
        }
        try {
          const persisted = await persistRevisedPrimerArtifact(
            loaded.path,
            input.workspaceRoot,
            loaded.content,
            revised,
            mutationToken,
            loaded.acceptedRevision
          );
          return { ...persisted, bindingMutations };
        } catch (error) {
          if (
            options.retainAcceptedHistoryPending &&
            error instanceof PrimerAcceptedSavePendingError &&
            error.saved
          )
            return { ...error.saved, bindingMutations };
          throw error;
        }
      },
      options.mutationToken
    );
  }

  async function updatePrimerArtifactBinding(
    input: UpdatePrimerArtifactBindingInput,
    options: PrimerMutationOptions = {}
  ): Promise<PrimerArtifactBindingMutationResult> {
    return withRendererWorkspaceMutation(
      input.workspaceRoot,
      async (mutationToken) => {
        const loaded = await loadArtifactForPrimer(input.primer, input.workspaceRoot, {
          mutationToken,
        });
        assertExpectedArtifactRevision(loaded.artifact, input.expectedArtifactRevision);
        const existing = loaded.artifact.bindings.find((binding) => binding.id === input.bindingId);
        if (!existing) {
          throw new Error(`Primer binding ${input.bindingId} does not exist in the artifact.`);
        }
        const targetRoot = input.targetWorkspaceRoot ?? input.workspaceRoot;
        const targetProjectId =
          targetRoot === input.workspaceRoot
            ? undefined
            : await requirePrimerTargetProjectId(targetRoot);
        if (
          !(await platform().fs.validateWorkspacePath({
            workspaceRoot: targetRoot,
            path: input.targetFilePath,
          }))
        ) {
          throw new Error(
            'The primer target must be inside its explicitly selected source project.'
          );
        }
        const target = loaded.registeredRevision
          ? await readRegisteredPrimerBindingTarget(input, loaded.registeredRevision.workspaceId)
          : await buildFileDnaSequenceRef(input.targetFilePath, {
              workspaceRoot: targetRoot,
              documentId: input.targetDocumentId,
            });
        if (
          target.sequenceId !== input.bindingSequenceId ||
          target.documentId !== input.targetDocumentId
        ) {
          throw new Error('The selected target no longer matches its stable sequence identity.');
        }
        const replacement: PrimerArtifactBindingV1 = {
          id: existing.id,
          relation: 'binds_to_sequence',
          target: {
            documentId: target.documentId,
            ...(targetProjectId ? { projectId: targetProjectId } : {}),
            topology: target.topology,
            length: target.length,
            fileContentHash: target.fileContentHash ?? target.contentHash,
            normalizedSequenceHash: target.normalizedSequenceHash ?? target.contentHash,
          },
          coordinates: {
            system: 'zero_based_half_open',
            start: input.bindingStart,
            end: input.bindingEnd,
            strand: input.bindingStrand,
          },
          source: input.source ?? 'manual',
          ...(input.alignment ? { alignment: input.alignment } : {}),
        };
        if (loaded.registeredRevision) {
          const saved = await publishRegisteredPrimerRevision(
            loaded,
            input.workspaceRoot,
            { type: 'binding_update', bindingId: input.bindingId, binding: replacement },
            mutationToken
          );
          return { ...saved.saved, bindingMutation: 'updated', bindingId: existing.id };
        }
        const revised = parsePrimerArtifact(
          serializePrimerArtifact(
            revisePrimerArtifactBinding(loaded.artifact, input.bindingId, replacement)
          )
        );
        const persisted = await persistRevisedPrimerArtifact(
          loaded.path,
          input.workspaceRoot,
          loaded.content,
          revised,
          mutationToken,
          loaded.acceptedRevision
        );
        return { ...persisted, bindingMutation: 'updated', bindingId: existing.id };
      },
      options.mutationToken
    );
  }
  async function detachPrimerArtifact(
    input: DetachPrimerArtifactInput,
    options: PrimerMutationOptions = {}
  ): Promise<SavedPrimerArtifact> {
    return withRendererWorkspaceMutation(
      input.workspaceRoot,
      async (mutationToken) => {
        const loaded = await loadArtifactForPrimer(input.primer, input.workspaceRoot, {
          mutationToken,
        });
        assertExpectedArtifactRevision(loaded.artifact, input.expectedArtifactRevision);
        if (loaded.registeredRevision)
          return (
            await publishRegisteredPrimerRevision(
              loaded,
              input.workspaceRoot,
              { type: 'binding_remove', bindingId: input.bindingId },
              mutationToken
            )
          ).saved;
        if (!loaded.artifact.bindings.some((binding) => binding.id === input.bindingId)) {
          return persistRevisedPrimerArtifact(
            loaded.path,
            input.workspaceRoot,
            loaded.content,
            loaded.artifact,
            mutationToken,
            loaded.acceptedRevision
          );
        }
        const revised = parsePrimerArtifact(
          serializePrimerArtifact(removePrimerArtifactBinding(loaded.artifact, input.bindingId))
        );
        return persistRevisedPrimerArtifact(
          loaded.path,
          input.workspaceRoot,
          loaded.content,
          revised,
          mutationToken,
          loaded.acceptedRevision
        );
      },
      options.mutationToken
    );
  }
  async function loadArtifactForPrimer(
    primer: Primer,
    workspaceRoot: string,
    options: PrimerMutationOptions = {},
    supersededBindings?: { documentId: string; ids: ReadonlySet<string> }
  ): Promise<ReadPrimerArtifactResult> {
    const relativePath = primerArtifactRelativePath(primer);
    if (!relativePath) throw new Error('This primer does not have project file authority.');
    const state = await platform().lims.readPrimerArtifactRevisionState({
      entityId: primer.id,
      mutationToken: options.mutationToken,
    });
    if (state.state === 'pending') throw new PrimerPublicationPendingError(state);
    const path = workspaceAbsolutePath(workspaceRoot, relativePath);
    const loaded = await readPrimerArtifactAtPath(path, workspaceRoot, options, supersededBindings);
    if (
      loaded.artifact.id !== primer.id ||
      loaded.artifact.file.workspaceRelativePath !== relativePath
    )
      throw new Error('Primer artifact identity does not match the selected library primer.');
    return loaded;
  }
  async function readPrimerArtifactForPrimer(
    primer: Primer,
    workspaceRoot: string,
    options: PrimerMutationOptions = {}
  ): Promise<ReadPrimerArtifactResult> {
    return loadArtifactForPrimer(primer, workspaceRoot, options);
  }
  async function registeredReadResult(
    state: ReadyPrimerArtifactRevision,
    path: string,
    workspaceRoot: string
  ): Promise<ReadPrimerArtifactResult> {
    const validation = validatePrimerArtifactPath(path, workspaceRoot);
    if (
      !validation.valid ||
      validation.relativePath !== state.relativePath ||
      state.artifact.id !== state.entity.id ||
      state.artifact.registry.entityId !== state.entity.id ||
      state.artifact.file.workspaceRelativePath !== state.relativePath ||
      (await resolveWorkspaceId(workspaceRoot)) !== state.workspaceId
    )
      throw new Error('The registered primer no longer matches its owning saved document.');

    return {
      path,
      content: serializePrimerArtifact(state.artifact),
      artifact: state.artifact,
      resolvedBindings: await readProjectedPrimerBindings(state.artifact),
      registeredRevision: state,
    };
  }
  async function readProjectedPrimerBindings(
    artifact: PrimerArtifactV1
  ): Promise<ResolvedPrimerBinding[]> {
    if (artifact.bindings.length === 0) return [];
    const rows = await platform().db.select<
      Array<{ id: string; sequence_id: number; document_id: string | null }>
    >(
      `SELECT p.id,p.sequence_id,s.document_id FROM primer_bindings p
     JOIN sequences s ON s.id=p.sequence_id WHERE p.primer_id=?`,
      [artifact.registry.entityId]
    );
    return artifact.bindings.flatMap((binding) => {
      const row = rows.find(
        (item) =>
          item.id === binding.id &&
          (!binding.target.documentId || item.document_id === binding.target.documentId)
      );
      return row && Number.isSafeInteger(row.sequence_id) && row.sequence_id > 0
        ? [{ binding, sequenceId: row.sequence_id }]
        : [];
    });
  }
  async function retireTrashedPrimerArtifact(
    id: string,
    workspaceRoot: string,
    options: PrimerMutationOptions = {}
  ): Promise<void> {
    return withRendererWorkspaceMutation(
      workspaceRoot,
      async (mutationToken) => {
        const state = await platform().lims.readPrimerArtifactRevisionState({
          entityId: id,
          mutationToken,
        });
        if (state.state !== 'not_enrolled')
          throw new Error(
            'Registered primers keep their saved project document. Use Archive instead of Trash.'
          );
        const file = await findTrashedPrimerDocument(id);
        const workspaceId = await resolveWorkspaceId(workspaceRoot);
        if (!file || workspaceId == null || file.workspace_id !== workspaceId)
          throw new Error(
            'Primer retirement requires its owning project and recorded Trash action.'
          );
        const [entity] = await queryLimsEntities({ id, includeArchived: true, limit: 1 });
        if (entity?.workspaceId != null && entity.workspaceId !== workspaceId)
          throw new Error('The primer Registry identity belongs to a different project.');
        if (entity && !entity.tombstone) {
          await archiveLimsEntity(
            { id, actor: 'primer-document-trash', expectedEventSeq: entity.eventSeq ?? undefined },
            { mutationToken }
          );
        }
        const primer = await readPrimerById(platform().db, id);
        if (!primer || primer.workspaceId !== workspaceId) return;
        const [catalog] = await platform().db.select<Array<{ metadata: string | null }>>(
          'SELECT metadata FROM catalog_entities WHERE id = ?',
          [id]
        );
        const metadata = JSON.parse(catalog?.metadata ?? '{}') as { artifactRevision?: unknown };
        await platform().db.replacePrimerProjection(
          {
            ...primer,
            originDetails: primer.originDetails ?? {},
            bindings: [],
            retireArtifact: {
              artifactPath: String(primer.originDetails?.artifactPath ?? ''),
              expectedArtifactRevision: Number(metadata.artifactRevision),
            },
          },
          workspaceRoot,
          mutationToken
        );
      },
      options.mutationToken
    );
  }
  async function trashPrimerArtifact(
    primer: Primer,
    loaded: ReadPrimerArtifactResult,
    workspaceRoot: string,
    options: PrimerMutationOptions = {}
  ): Promise<void> {
    return withRendererWorkspaceMutation(
      workspaceRoot,
      async (mutationToken) => {
        const state = await platform().lims.readPrimerArtifactRevisionState({
          entityId: primer.id,
          mutationToken,
        });
        if (state.state !== 'not_enrolled')
          throw new Error(
            'Registered primers keep their saved project document. Use Archive instead of Trash.'
          );
        const dirtyBefore = await currentDirtyLimsPaths(workspaceRoot, mutationToken);
        const shell = platform().shell;
        if (!shell) throw new Error('Native file Trash is unavailable.');
        await shell.trashItem(loaded.path, mutationToken);
        await markCatalogFileMissing(loaded.path, 'moved-to-trash');
        await retireTrashedPrimerArtifact(primer.id, workspaceRoot, { mutationToken });
        const history = await commitPrimerArtifactHistory(
          workspaceRoot,
          loaded.artifact.file.workspaceRelativePath,
          loaded.artifact.name,
          dirtyBefore,
          'Delete',
          mutationToken
        );
        if (history === 'failed')
          throw new Error('The primer was moved to Trash, but its history could not be updated.');
      },
      options.mutationToken
    );
  }
  async function readPrimerArtifactAtPath(
    artifactPath: string,
    workspaceRoot: string,
    options: PrimerReadOptions = {},
    supersededBindings?: { documentId: string; ids: ReadonlySet<string> }
  ): Promise<ReadPrimerArtifactResult> {
    const normalizedPath = normalizePrimerArtifactPath(artifactPath);
    const validation = validatePrimerArtifactPath(normalizedPath, workspaceRoot);
    if (!validation.valid) throw new Error(validation.error);
    if (!(await platform().fs.validateWorkspacePath({ workspaceRoot, path: normalizedPath })))
      throw new Error('Primer files must be opened inside the owning project.');
    const binding = await getCatalogFileForPath(normalizedPath);
    if (binding?.file_kind === 'primer-artifact' && binding.status === 'current') {
      const state = await platform().lims.readPrimerArtifactRevisionState({
        entityId: binding.entity_id,
        mutationToken: options.mutationToken,
      });
      if (state.state === 'pending') throw new PrimerPublicationPendingError(state);
      if (state.state === 'ready') {
        if (state.workspaceId !== binding.workspace_id)
          throw new Error('The registered primer file has conflicting project ownership.');
        return registeredReadResult(state, normalizedPath, workspaceRoot);
      }
      if (state.state !== 'not_enrolled')
        throw new Error('The primer publication state is unavailable.');
    }
    const { content, acceptedRevision } = await readScientificText(normalizedPath, workspaceRoot);
    const artifact = parsePrimerArtifact(content);
    if (
      artifact.file.workspaceRelativePath !== validation.relativePath ||
      (binding?.status === 'current' && binding.entity_id !== artifact.id)
    )
      throw new Error('Primer artifact identity does not match its project file path.');

    const state = await platform().lims.readPrimerArtifactRevisionState({
      entityId: artifact.id,
      mutationToken: options.mutationToken,
    });
    if (state.state === 'pending') throw new PrimerPublicationPendingError(state);
    if (state.state === 'ready') return registeredReadResult(state, normalizedPath, workspaceRoot);
    if (state.state !== 'not_enrolled')
      throw new Error('The primer publication state is unavailable.');
    return {
      path: normalizedPath,
      content,
      artifact,
      acceptedRevision,
      resolvedBindings:
        options.bindingResolution === 'projected'
          ? await readProjectedPrimerBindings(artifact)
          : await resolvePrimerBindings(
              {
                ...artifact,
                bindings: artifact.bindings.filter(
                  (binding) =>
                    !(
                      supersededBindings?.ids.has(binding.id) &&
                      binding.target.documentId === supersededBindings.documentId
                    )
                ),
              },
              workspaceRoot,
              options
            ),
    };
  }
  async function updatePrimerArtifactContent(
    input: UpdatePrimerArtifactContentInput,
    options: PrimerMutationOptions = {}
  ): Promise<SavedPrimerArtifact> {
    return withRendererWorkspaceMutation(
      input.workspaceRoot,
      async (mutationToken) => {
        const loaded = await readPrimerArtifactAtPath(input.artifactPath, input.workspaceRoot, {
          mutationToken,
        });
        if (loaded.acceptedRevision) {
          if (
            !input.acceptedRevision ||
            input.acceptedRevision.resourceId !== loaded.artifact.id ||
            input.acceptedRevision.resourceRevisionId !==
              loaded.acceptedRevision.resourceRevisionId ||
            input.acceptedRevision.contentSha256 !== loaded.acceptedRevision.contentSha256
          )
            throw new Error(
              'The primer revision changed or was not captured. Reopen it before saving.'
            );
        } else if (input.acceptedRevision) {
          throw new Error('The accepted primer is unavailable; its Save cannot use working bytes.');
        }
        assertExpectedArtifactRevision(loaded.artifact, input.expectedArtifactRevision);
        const sequenceChanged = input.sequence.trim() !== loaded.artifact.sequence.bases;
        const annealing =
          input.annealing === undefined
            ? sequenceChanged
              ? undefined
              : loaded.artifact.annealing
            : (input.annealing ?? undefined);
        const annealingChanged =
          stableJson(annealing ?? null) !== stableJson(loaded.artifact.annealing ?? null);
        const nextOrderType =
          ('oligo' in input ? input.oligo : loaded.artifact.oligo)?.orderType ?? 'dna';
        const orderTypeChanged = nextOrderType !== (loaded.artifact.oligo?.orderType ?? 'dna');
        const tmCalculation =
          (sequenceChanged || orderTypeChanged || annealingChanged) && nextOrderType === 'dna'
            ? (input.tmCalculation ??
              (await calculateArtifactTm(annealing?.pbsSequence ?? input.sequence)))
            : undefined;
        if (loaded.registeredRevision) {
          if (
            input.entitySchema &&
            stableJson(input.entitySchema) !== stableJson(loaded.artifact.entity?.schema)
          )
            throw new Error('A registered primer keeps its saved record definition.');
          return (
            await publishRegisteredPrimerRevision(
              loaded,
              input.workspaceRoot,
              {
                type: 'content',
                content: {
                  name: input.name,
                  sequence: input.sequence,
                  ...(input.annealing !== undefined ? { annealing: input.annealing } : {}),
                  ...('oligo' in input ? { oligo: input.oligo } : {}),
                  notes: input.notes,
                  application: input.application,
                  inventory: input.inventory,
                  entityFields: input.entityFields,
                  ...(input.status !== undefined ? { status: input.status } : {}),
                  ...(tmCalculation ? { tmCalculation } : {}),
                },
              },
              mutationToken
            )
          ).saved;
        }
        if (loaded.acceptedRevision && samePrimerContent(loaded.artifact, input))
          return persistRevisedPrimerArtifact(
            loaded.path,
            input.workspaceRoot,
            loaded.content,
            loaded.artifact,
            mutationToken,
            input.acceptedRevision,
            loaded.content
          );
        const revised = await revisePrimerArtifactContent(loaded.artifact, {
          name: input.name,
          sequence: input.sequence,
          ...(input.annealing !== undefined ? { annealing: input.annealing } : {}),
          ...('oligo' in input ? { oligo: input.oligo } : {}),
          notes: input.notes,
          application: input.application,
          inventory: input.inventory,
          entityState: input.entityState,
          actor: input.actor,
          entitySchema: input.entitySchema,
          entityFields: input.entityFields,
          ...(tmCalculation ? { tmCalculation } : {}),
        });
        return persistRevisedPrimerArtifact(
          loaded.path,
          input.workspaceRoot,
          loaded.content,
          revised,
          mutationToken,
          input.acceptedRevision
        );
      },
      options.mutationToken ?? input.mutationToken
    );
  }
  async function readRegisteredPrimerBindingTarget(
    input: AttachPrimerArtifactInput,
    workspaceId: number
  ) {
    const rows = await platform().db.select<
      Array<{ id: number; document_id: string; path: string; workspace_id: number }>
    >(
      `SELECT s.id,s.document_id,f.path,f.workspace_id FROM sequences s
     JOIN indexed_files f ON f.id=s.file_id WHERE s.id=? AND s.document_id=?`,
      [input.bindingSequenceId, input.targetDocumentId]
    );
    const target = rows[0];
    if (
      rows.length !== 1 ||
      target.workspace_id !== workspaceId ||
      target.path !== input.targetFilePath
    )
      throw new Error(
        'The selected binding target must already have its own indexed identity in this project.'
      );
    const source = isBinarySequencePath(input.targetFilePath)
      ? await platform().fs.readFile(input.targetFilePath)
      : await platform().fs.readTextFile(input.targetFilePath);
    const parsed = parseSequenceFileAsDocument(source, input.targetFilePath).sequence;
    const hashSource = typeof source === 'string' ? source : new Uint8Array(source).buffer;
    const fileContentHash = await computeChecksum(hashSource);
    return {
      sequenceId: target.id,
      documentId: target.document_id,
      length: parsed.length,
      topology: parsed.circular ? ('circular' as const) : ('linear' as const),
      contentHash: fileContentHash,
      fileContentHash,
      normalizedSequenceHash: await computeChecksum(parsed.sequence.toUpperCase()),
    };
  }
  function pendingSummary(
    result: PrimerArtifactRevisionResult,
    operationId: string,
    workspaceId: number
  ): PendingPrimerArtifactPublication {
    return {
      state: 'pending',
      entityId: result.entity.id,
      operationId,
      workspaceId,
      relativePath: result.artifact.file.workspaceRelativePath,
      name: result.artifact.name,
      artifactRevision: result.artifact.artifactRevision,
    };
  }
  async function finishRegisteredPrimerRevision(
    result: PrimerArtifactRevisionResult,
    operationId: string,
    workspaceId: number,
    workspaceRoot: string,
    dirtyBefore: Set<string>,
    mutationToken?: string
  ): Promise<SavedPrimerArtifact> {
    const artifact = result.artifact;
    const artifactPath = workspaceAbsolutePath(workspaceRoot, artifact.file.workspaceRelativePath);
    const gitStatus = result.changed
      ? await commitPrimerArtifactHistory(
          workspaceRoot,
          artifact.file.workspaceRelativePath,
          artifact.name,
          dirtyBefore,
          'Update',
          mutationToken
        )
      : 'not-git';
    if (gitStatus === 'failed')
      throw new PrimerPublicationPendingError(
        pendingSummary(result, operationId, workspaceId),
        'The primer was saved locally, but its history could not be updated. Retry the same save.'
      );
    return {
      created: false,
      artifactPath,
      artifact,
      limsEntity: result.entity,
      primer: primerArtifactLegacyProjection(artifact, [], workspaceId).primer,
      gitCommitted: gitStatus === 'committed',
      ...(result.changed ? { publication: { entityId: result.entity.id, operationId } } : {}),
    };
  }
  async function publishRegisteredPrimerRevision(
    loaded: ReadPrimerArtifactResult,
    workspaceRoot: string,
    change: PrimerArtifactRevisionRequest['change'],
    mutationToken?: string
  ): Promise<{ saved: SavedPrimerArtifact; result: PrimerArtifactRevisionResult }> {
    const state = loaded.registeredRevision;
    if (!state) throw new Error('The primer publication authority is unavailable.');
    const dirtyBefore = await currentDirtyLimsPaths(workspaceRoot, mutationToken);
    const request: PrimerArtifactRevisionRequest = {
      entityId: state.entity.id,
      operationId: randomId(),
      expectedEventSeq: state.expectedEventSeq,
      expectedContentHash: state.expectedContentHash,
      change,
      mutationToken,
    };
    let result: PrimerArtifactRevisionResult;
    try {
      result = await platform().lims.revisePrimerArtifact(request);
    } catch (error) {
      const current = await platform().lims.readPrimerArtifactRevisionState({
        entityId: state.entity.id,
        mutationToken,
      });
      if (current.state === 'pending') throw new PrimerPublicationPendingError(current);

      if (current.state === 'ready' && current.expectedEventSeq !== state.expectedEventSeq) {
        try {
          result = await platform().lims.resumePrimerArtifactPublication({
            entityId: state.entity.id,
            operationId: request.operationId,
            mutationToken,
          });
        } catch {
          throw error;
        }
      } else throw error;
    }
    return {
      result,
      saved: await finishRegisteredPrimerRevision(
        result,
        request.operationId,
        state.workspaceId,
        workspaceRoot,
        dirtyBefore,
        mutationToken
      ),
    };
  }
  async function resumePrimerArtifactSave(
    input: { entityId: string; operationId: string; workspaceRoot: string },
    options: PrimerMutationOptions = {}
  ): Promise<SavedPrimerArtifact> {
    return withRendererWorkspaceMutation(
      input.workspaceRoot,
      async (mutationToken) => {
        const result = await platform().lims.resumePrimerArtifactPublication({
          entityId: input.entityId,
          operationId: input.operationId,
          mutationToken,
        });
        const current = await platform().lims.readPrimerArtifactRevisionState({
          entityId: input.entityId,
          mutationToken,
        });
        if (current.state === 'pending') throw new PrimerPublicationPendingError(current);
        if (
          current.state !== 'ready' ||
          current.workspaceId !== (await resolveWorkspaceId(input.workspaceRoot))
        )
          throw new Error('The primer owning project changed before Retry finished.');

        return finishRegisteredPrimerRevision(
          result,
          input.operationId,
          current.workspaceId,
          input.workspaceRoot,
          new Set(),
          mutationToken
        );
      },
      options.mutationToken
    );
  }
  function assertExpectedArtifactRevision(
    artifact: PrimerArtifactV1,
    expectedRevision: number | undefined
  ): void {
    if (expectedRevision !== undefined && artifact.artifactRevision !== expectedRevision) {
      throw new PrimerArtifactRevisionError(expectedRevision, artifact.artifactRevision);
    }
  }
  async function publishAcceptedPrimerArtifact(
    artifactPath: string,
    workspaceRoot: string,
    artifact: PrimerArtifactV1,
    authority:
      | { prior: ScientificAcceptedDocumentRevision }
      | { prior: null; expectedHead: string },
    mutationToken?: string,
    content = serializePrimerArtifact(artifact)
  ): Promise<{
    limsEntity: LimsEntity;
    primer: Primer;
    acceptedRevision: ScientificAcceptedDocumentRevision;
  }> {
    let accepted: ScientificAcceptedDocumentRevision;
    try {
      accepted = await publishNativeArtifact({
        workspaceRoot,
        artifactPath,
        resourceId: artifact.id,
        ...authority,
        representation: { format: 'primer-v2', text: content },
        mutationToken,
      });
    } catch (error) {
      if (error instanceof NativeArtifactPublicationPendingError)
        throw new PrimerAcceptedSavePendingError(artifact, error.accepted, error);
      throw error;
    }
    const limsEntity = (await queryLimsEntities({ id: artifact.id, limit: 1 }))[0];
    const primer = await getPrimerById(artifact.id);
    if (
      !limsEntity ||
      !primer ||
      limsEntity.name !== artifact.name ||
      primer.name !== artifact.name ||
      !isRecord(limsEntity.fields.artifact) ||
      limsEntity.fields.artifact.revision !== artifact.artifactRevision
    )
      throw new PrimerAcceptedSavePendingError(
        artifact,
        accepted,
        new Error('Primer Save accepted; its Registry projection is incomplete.')
      );
    return { limsEntity, primer, acceptedRevision: accepted };
  }
  async function persistRevisedPrimerArtifact(
    artifactPath: string,
    workspaceRoot: string,
    priorContent: string,
    artifact: PrimerArtifactV1,
    mutationToken?: string,
    acceptedRevision?: ScientificAcceptedDocumentRevision | null,
    acceptedContent?: string
  ): Promise<SavedPrimerArtifact> {
    const limsPathsBefore = await currentDirtyLimsPaths(workspaceRoot, mutationToken);
    if (acceptedRevision) {
      const {
        limsEntity,
        primer,
        acceptedRevision: accepted,
      } = await publishAcceptedPrimerArtifact(
        artifactPath,
        workspaceRoot,
        artifact,
        { prior: acceptedRevision },
        mutationToken,
        acceptedContent
      );
      const gitStatus = await commitPrimerArtifactHistory(
        workspaceRoot,
        artifact.file.workspaceRelativePath,
        artifact.name,
        limsPathsBefore,
        'Update',
        mutationToken,
        [scientificIdentityPath]
      );
      const saved: SavedPrimerArtifact = {
        artifactPath,
        artifact,
        limsEntity,
        primer,
        gitCommitted: gitStatus === 'committed',
        historyStatus: gitStatus,
        acceptedRevision: accepted,
        created: false,
      };
      if (gitStatus === 'failed')
        throw new PrimerAcceptedSavePendingError(
          artifact,
          accepted,
          new PrimerHistoryError(artifactPath),
          saved
        );
      return saved;
    }
    await platform().fs.writeWorkspaceTextFileAtomic({
      workspaceRoot,
      path: artifactPath,
      content: serializePrimerArtifact(artifact),
      mode: 'replace',
      expectedContentHash: await sha256Hex(priorContent),
      mutationToken,
    });
    return completeRevisedPrimerArtifact(
      artifactPath,
      workspaceRoot,
      artifact,
      limsPathsBefore,
      mutationToken
    );
  }
  async function completeRevisedPrimerArtifact(
    artifactPath: string,
    workspaceRoot: string,
    artifact: PrimerArtifactV1,
    limsPathsBefore: Set<string>,
    mutationToken?: string
  ): Promise<SavedPrimerArtifact> {
    if ((await platform().fs.readTextFile(artifactPath)) !== serializePrimerArtifact(artifact))
      throw new Error(
        'This oligo changed after its save. Reopen its current version before retrying.'
      );
    const retry = () =>
      withRendererWorkspaceMutation(workspaceRoot, (activeToken) =>
        completeRevisedPrimerArtifact(
          artifactPath,
          workspaceRoot,
          artifact,
          limsPathsBefore,
          activeToken
        )
      );
    let projected: { limsEntity: LimsEntity; primer: Primer };
    try {
      projected = await projectPrimerArtifact(artifact, workspaceRoot, { mutationToken });
    } catch (error) {
      throw new PrimerProjectionError(artifactPath, error, retry);
    }
    const gitStatus = await commitPrimerArtifactHistory(
      workspaceRoot,
      artifact.file.workspaceRelativePath,
      artifact.name,
      limsPathsBefore,
      'Update',
      mutationToken
    );
    if (gitStatus === 'failed') throw new PrimerHistoryError(artifactPath, retry);
    return {
      artifactPath,
      artifact,
      ...projected,
      created: false,
      gitCommitted: gitStatus === 'committed',
    };
  }
  async function projectPrimerArtifact(
    artifact: PrimerArtifactV1,
    workspaceRoot: string,
    options: PrimerMutationOptions = {}
  ): Promise<{ limsEntity: LimsEntity; primer: Primer }> {
    return withRendererWorkspaceMutation(
      workspaceRoot,
      (mutationToken) =>
        projectPrimerArtifactInMutation(artifact, workspaceRoot, { ...options, mutationToken }),
      options.mutationToken
    );
  }
  async function projectPrimerArtifactInMutation(
    artifact: PrimerArtifactV1,
    workspaceRoot: string,
    options: PrimerMutationOptions
  ): Promise<{ limsEntity: LimsEntity; primer: Primer }> {
    const publication = await platform().lims.readPrimerArtifactRevisionState({
      entityId: artifact.id,
      mutationToken: options.mutationToken,
    });
    if (publication.state === 'pending') throw new PrimerPublicationPendingError(publication);
    if (publication.state === 'ready') {
      if (
        stableJson(publication.artifact) !== stableJson(artifact) ||
        publication.workspaceId !== (await resolveWorkspaceId(workspaceRoot))
      )
        throw new Error(
          'The registered primer changed. Save it through its owning document before reconciling.'
        );
      return {
        limsEntity: publication.entity,
        primer: primerArtifactLegacyProjection(publication.artifact, [], publication.workspaceId)
          .primer,
      };
    }
    if (publication.state !== 'not_enrolled')
      throw new Error('The primer publication state is unavailable.');
    if ((await sha256Hex(artifact.sequence.bases)) !== artifact.sequence.contentHash) {
      throw new Error('Primer artifact sequence hash does not match its bases.');
    }
    let registryRelationships: { relativePath: string; contentHash: string } | undefined;
    if (artifact.registryRelationships !== undefined) {
      const content = await platform().fs.readTextFile(
        workspaceAbsolutePath(workspaceRoot, artifact.file.workspaceRelativePath)
      );
      if (
        serializePrimerArtifact(parsePrimerArtifact(content)) !== serializePrimerArtifact(artifact)
      )
        throw new Error(
          'The saved primer changed before relationship reconciliation; retry the scan.'
        );
      registryRelationships = {
        relativePath: artifact.file.workspaceRelativePath,
        contentHash: await sha256Hex(content),
      };
    }
    const resolvedBindings = await resolvePrimerBindings(artifact, workspaceRoot, options);
    const workspaceId = await resolveWorkspaceId(workspaceRoot, resolvedBindings[0]?.sequenceId);
    if (workspaceId == null) throw new Error('A saved primer requires a registered project.');
    const artifactContentHash = await sha256Hex(serializePrimerArtifact(artifact));
    const artifactPath = workspaceAbsolutePath(workspaceRoot, artifact.file.workspaceRelativePath);
    const namespace = await readScientificNamespace(workspaceRoot);
    const accepted = namespace?.entries.find((entry) => entry.resourceId === artifact.id);
    if (accepted) {
      if (accepted.tombstone || accepted.path !== artifact.file.workspaceRelativePath)
        throw new Error('The accepted primer was removed or moved. Reopen it before projecting.');
      const current = await readScientificText(artifactPath, workspaceRoot);
      if (!current.acceptedRevision || current.content !== serializePrimerArtifact(artifact))
        throw new Error(
          'Working primer bytes cannot replace the accepted projection. Submit the edit first.'
        );
      const limsEntity = (await queryLimsEntities({ id: artifact.id, limit: 1 }))[0];
      const primer = await getPrimerById(artifact.id);
      if (!limsEntity || !primer)
        throw new Error('Accepted primer projection is unavailable. Reopen the project.');
      return { limsEntity, primer };
    }
    const existingCatalogEntity = await getCatalogEntity(artifact.id);
    if (existingCatalogEntity && existingCatalogEntity.type !== 'primer') {
      throw new Error(
        `Primer catalog identity ${artifact.id} belongs to ${existingCatalogEntity.type}.`
      );
    }
    const existingCatalogFile = await getCatalogFileForPath(artifactPath);
    if (existingCatalogFile && existingCatalogFile.entity_id !== artifact.id) {
      if (existingCatalogFile.status !== 'missing') {
        throw new Error('Primer artifact path is already owned by another catalog entity.');
      }
      await releaseMissingCatalogFilePath(existingCatalogFile, artifact.id);
    }
    const orderType = artifact.oligo?.orderType ?? 'dna';
    const sequenceRef =
      orderType === 'rna'
        ? await buildInlineRnaSequenceRef(artifact.sequence.bases)
        : await buildInlineDnaSequenceRef(artifact.sequence.bases);
    const savedState = artifact.entity?.state;
    const { registrationStatus, domainStatus, fields } = primerArtifactRegistryProjection(
      artifact,
      sequenceRef,
      artifactContentHash
    );

    let existing = (
      await queryLimsEntities({ id: artifact.registry.entityId, includeArchived: true, limit: 1 })
    )[0];
    if (
      !existing &&
      (await platform().lims.repairEntityProjectionFromAudit(
        artifact.registry.entityId,
        options.mutationToken
      ))
    ) {
      existing = (
        await queryLimsEntities({ id: artifact.registry.entityId, includeArchived: true, limit: 1 })
      )[0];
    }
    let limsEntity: LimsEntity;
    if (!existing) {
      limsEntity = await registerLimsEntity(
        {
          id: artifact.registry.entityId,
          kind: artifact.registry.kind,
          name: artifact.name,
          fields,
          schemaRevisionId: artifact.entity?.schema.schemaRevisionId,
          schemaSnapshot:
            artifact.entity?.schema.schemaId === BUILTIN_PRIMER_SCHEMA_ID ||
            artifact.entity?.schema.schemaId === BUILTIN_RNA_OLIGO_SCHEMA_ID
              ? undefined
              : artifact.entity?.schema,
          registrationStatus,
          domainStatus,
          workspaceId,
          actor: artifact.metadata.actor,
          createdAt: Date.parse(artifact.metadata.createdAt),
          ...(savedState
            ? {
                initialState: {
                  updatedAt: Date.parse(artifact.metadata.updatedAt),
                  archived: savedState.archived,
                  archivedAt: savedState.archivedAt,
                },
              }
            : {}),
        },
        {
          mutationToken: options.mutationToken,
          workflowOrigin: 'projection',
          parentActionId: options.parentActionId,
        }
      );
    } else {
      if (existing.kind !== artifact.registry.kind) {
        throw new Error(`Primer registry identity ${artifact.id} belongs to ${existing.kind}.`);
      }
      const existingArtifact = isRecord(existing.fields.artifact) ? existing.fields.artifact : null;
      const recoveryAdoption =
        existingArtifact === null &&
        artifact.recovery?.source === 'registry' &&
        artifact.recovery.sourceFingerprint === (await primerRecoverySourceFingerprint(existing)) &&
        (existing.workspaceId == null || existing.workspaceId === workspaceId);
      if (
        recoveryAdoption &&
        artifact.recovery?.relationshipsFingerprint !== undefined &&
        artifact.recovery.relationshipsFingerprint !==
          (await primerRecoveryRelationshipsFingerprint(existing.id))
      )
        throw new Error(
          'The primer relationships changed before recovery; the saved evidence and current records were preserved.'
        );
      const ownedFileAdoption =
        existingArtifact === null &&
        existingCatalogFile?.entity_id === artifact.id &&
        existingCatalogFile.status === 'current' &&
        existingCatalogFile.workspace_id === workspaceId;
      if (
        !recoveryAdoption &&
        !ownedFileAdoption &&
        (existingArtifact?.schema !== artifact.schema ||
          existingArtifact?.relativePath !== artifact.file.workspaceRelativePath)
      ) {
        throw new Error(
          `Primer registry identity ${artifact.id} is already owned by another oligo record.`
        );
      }
      const needsUpdate =
        existing.name !== artifact.name ||
        existing.registrationStatus !== registrationStatus ||
        existing.domainStatus !== domainStatus ||
        existing.workspaceId !== workspaceId ||
        stableJson(existing.fields) !== stableJson(fields);
      limsEntity = needsUpdate
        ? await updateLimsEntity(
            {
              id: existing.id,
              name: artifact.name,
              fields,
              replaceFields: true,
              registrationStatus,
              domainStatus,
              workspaceId,
              expectedEventSeq: existing.eventSeq ?? undefined,
              actor: recoveryAdoption ? 'primer-record-recovery' : artifact.metadata.actor,
            },
            {
              mutationToken: options.mutationToken,
              workflowOrigin: 'projection',
              parentActionId: options.parentActionId,
            }
          )
        : existing;
      if (limsEntity.tombstone && !savedState?.archived) {
        limsEntity = await restoreLimsEntity(
          {
            id: limsEntity.id,
            actor: artifact.metadata.actor,
            expectedEventSeq: limsEntity.eventSeq ?? undefined,
          },
          {
            mutationToken: options.mutationToken,
            workflowOrigin: 'projection',
            parentActionId: options.parentActionId,
          }
        );
      }
      if (savedState?.archived && !limsEntity.tombstone) {
        limsEntity = await archiveLimsEntity(
          {
            id: limsEntity.id,
            actor: artifact.metadata.actor,
            expectedEventSeq: limsEntity.eventSeq ?? undefined,
          },
          { mutationToken: options.mutationToken }
        );
      }
    }

    await registerCatalogEntity({
      id: artifact.id,
      type: 'primer',
      name: artifact.name,
      locator: `waypoint://primer/${artifact.id}`,
      storageType: 'file',
      workspaceRoot,
      metadata: {
        schema: artifact.schema,
        schemaVersion: artifact.schemaVersion,
        artifactRevision: artifact.artifactRevision,
        relativePath: artifact.file.workspaceRelativePath,
        entitySchema: artifact.entity?.schema,
      },
    });
    await bindCatalogEntityToFile({
      entityId: artifact.id,
      path: artifactPath,
      fileKind: 'primer-artifact',
      workspaceRoot,
      contentHash: `sha256:${artifactContentHash}`,
      status: 'current',
      mutationToken: options.mutationToken,
    });

    const primer = await upsertLegacyPrimerProjection(
      artifact,
      resolvedBindings,
      workspaceId,
      workspaceRoot,
      options.mutationToken,
      registryRelationships
    );
    return { limsEntity, primer };
  }
  async function upsertLegacyPrimerProjection(
    artifact: PrimerArtifactV1,
    resolvedBindings: ResolvedPrimerBinding[],
    workspaceId: number | null,
    workspaceRoot: string,
    mutationToken?: string,
    registryRelationships?: { relativePath: string; contentHash: string }
  ): Promise<Primer> {
    const { input, primer } = primerArtifactLegacyProjection(
      artifact,
      resolvedBindings,
      workspaceId,
      registryRelationships
    );
    await platform().db.replacePrimerProjection(input, workspaceRoot, mutationToken);
    return primer;
  }
  async function resolvePrimerBindings(
    artifact: PrimerArtifactV1,
    workspaceRoot: string,
    options: PrimerMutationOptions = {}
  ): Promise<ResolvedPrimerBinding[]> {
    const resolved: ResolvedPrimerBinding[] = [];
    for (const binding of artifact.bindings) {
      const targetRoot = await resolvePrimerBindingTargetRoot(
        binding.target.projectId,
        workspaceRoot
      );
      if (!targetRoot) continue;
      const targetPath = binding.target.documentId
        ? (
            await resolveSequenceDocumentById(
              binding.target.documentId,
              [targetRoot],
              targetRoot === workspaceRoot ? options : {}
            )
          ).sourcePath
        : workspaceAbsolutePath(targetRoot, binding.target.legacyWorkspaceRelativePath ?? '');
      if (
        !(await platform().fs.validateWorkspacePath({
          workspaceRoot: targetRoot,
          path: targetPath,
        }))
      ) {
        throw new Error('Primer target escapes its source project.');
      }

      let target: Awaited<ReturnType<typeof buildFileDnaSequenceRef>>;
      try {
        target = await buildFileDnaSequenceRef(targetPath, {
          workspaceRoot: targetRoot,
          ...(binding.target.documentId ? { documentId: binding.target.documentId } : {}),
        });
      } catch {
        continue;
      }
      if (target.sequenceId == null) {
        continue;
      }
      const fileContentHash = target.fileContentHash ?? target.contentHash;
      const normalizedSequenceHash = target.normalizedSequenceHash ?? target.contentHash;
      if (
        target.length !== binding.target.length ||
        target.topology !== binding.target.topology ||
        fileContentHash !== binding.target.fileContentHash ||
        normalizedSequenceHash !== binding.target.normalizedSequenceHash
      ) {
        throw new Error('Primer target has changed; review the binding before reconciliation.');
      }
      resolved.push({ binding, sequenceId: target.sequenceId });
    }
    return resolved;
  }
  async function resolveWorkspaceId(
    workspaceRoot: string,
    sequenceId?: number
  ): Promise<number | null> {
    const exact = await platform().db.select<Array<{ id: number }>>(
      `SELECT id FROM workspaces WHERE path = ? ORDER BY id LIMIT 1`,
      [workspaceRoot]
    );
    if (exact[0]) return exact[0].id;
    if (sequenceId == null) return null;
    const viaSequence = await platform().db.select<Array<{ workspace_id: number }>>(
      `SELECT f.workspace_id
     FROM sequences s
     JOIN indexed_files f ON f.id = s.file_id
     WHERE s.id = ?
     LIMIT 1`,
      [sequenceId]
    );
    return viaSequence[0]?.workspace_id ?? null;
  }
  async function commitPrimerArtifactHistory(
    workspaceRoot: string,
    artifactRelativePath: string,
    primerName: string,
    limsPathsBefore: Set<string>,
    verb: 'Add' | 'Update' | 'Delete' = 'Add',
    mutationToken?: string,
    additionalPaths: readonly string[] = []
  ): Promise<'committed' | 'not-git' | 'failed'> {
    if (!(await isGitRepo(workspaceRoot, mutationToken))) return 'not-git';
    try {
      const paths = [artifactRelativePath, ...additionalPaths];
      const status = await gitStatus(workspaceRoot, mutationToken);
      paths.push(...(await scientificRelationshipGitPaths(workspaceRoot, status)));
      for (const path of status.keys()) {
        if (!path.startsWith('.waypoint/lims/')) continue;
        if (!limsPathsBefore.has(path)) paths.push(path);
      }
      const dirtyPaths = paths.filter((path) => status.has(path));
      if (dirtyPaths.length === 0) return 'committed';
      await gitCommitPaths(
        workspaceRoot,
        `${verb} primer ${primerName}`,
        dirtyPaths,
        mutationToken
      );
      return 'committed';
    } catch (error) {
      console.warn('[PrimerArtifact] Saved and registered, but Git history commit failed:', error);
      return 'failed';
    }
  }
  async function commitPrimerBatchHistory(
    workspaceRoot: string,
    relPaths: string[],
    limsPathsBefore: Set<string>,
    message: string,
    mutationToken?: string
  ): Promise<'committed' | 'not-git' | 'failed'> {
    return withRendererWorkspaceMutation(
      workspaceRoot,
      (activeMutationToken) =>
        commitPrimerBatchHistoryInMutation(
          workspaceRoot,
          relPaths,
          limsPathsBefore,
          message,
          activeMutationToken
        ),
      mutationToken
    );
  }
  async function commitPrimerBatchHistoryInMutation(
    workspaceRoot: string,
    relPaths: string[],
    limsPathsBefore: Set<string>,
    message: string,
    mutationToken?: string
  ): Promise<'committed' | 'not-git' | 'failed'> {
    if (!(await isGitRepo(workspaceRoot, mutationToken))) return 'not-git';
    try {
      const paths = [...relPaths];
      const status = await gitStatus(workspaceRoot, mutationToken);
      paths.push(...(await scientificRelationshipGitPaths(workspaceRoot, status)));
      for (const path of status.keys()) {
        if (!path.startsWith('.waypoint/lims/')) continue;
        if (!limsPathsBefore.has(path)) paths.push(path);
      }
      const dirtyPaths = [...new Set(paths)].filter((path) => status.has(path));
      if (dirtyPaths.length === 0) return 'committed';
      await gitCommitPaths(workspaceRoot, message, dirtyPaths, mutationToken);
      return 'committed';
    } catch (error) {
      console.warn('[PrimerArtifact] Batch primer history commit failed:', error);
      return 'failed';
    }
  }
  async function currentDirtyLimsPaths(
    workspaceRoot: string,
    mutationToken?: string
  ): Promise<Set<string>> {
    if (!(await isGitRepo(workspaceRoot, mutationToken))) return new Set();
    const status = await gitStatus(workspaceRoot, mutationToken);
    return new Set([...status.keys()].filter((path) => path.startsWith('.waypoint/lims/')));
  }
  function workspaceAbsolutePath(workspaceRoot: string, relativePath: string): string {
    const separator = workspaceRoot.includes('\\') ? '\\' : '/';
    const rootWithoutTrailingSeparators = workspaceRoot.replace(/[\\/]+$/, '');
    const root = rootWithoutTrailingSeparators || separator;
    const relative = relativePath.replace(/[\\/]/g, separator);
    return root.endsWith(separator) ? `${root}${relative}` : `${root}${separator}${relative}`;
  }
  function duplicateArtifactPaths(
    artifacts: Array<{ path: string; artifact: PrimerArtifactV1; contentHash: string }>,
    field: 'id' | 'catalogNumber',
    label: string,
    errors: Array<{ path: string; message: string }>
  ): Set<string> {
    const grouped = new Map<
      string,
      Array<{ path: string; artifact: PrimerArtifactV1; contentHash: string }>
    >();
    for (const candidate of artifacts) {
      const value = candidate.artifact[field];
      const group = grouped.get(value) ?? [];
      group.push(candidate);
      grouped.set(value, group);
    }
    const blocked = new Set<string>();
    for (const [value, candidates] of grouped) {
      if (candidates.length < 2) continue;
      const allPaths = candidates
        .map((candidate) => candidate.path)
        .sort()
        .join(', ');
      for (const candidate of candidates) {
        blocked.add(candidate.path);
        errors.push({
          path: candidate.path,
          message: `Duplicate primer ${label} ${value}; conflicting files: ${allPaths}`,
        });
      }
    }
    return blocked;
  }
  function matchesRetry(
    artifact: PrimerArtifactV1,
    input: FileAuthoritativePrimerInput,
    target: Awaited<ReturnType<typeof buildFileDnaSequenceRef>> | null
  ): boolean {
    const orderType = input.oligo?.orderType ?? 'dna';
    const expectedSchema = input.entitySchema ?? createBuiltinPrimerSchemaSnapshot(orderType);
    const expectedMetadata = resolvePrimerArtifactMetadata(expectedSchema, input);
    if (
      (input.artifactId !== undefined && artifact.id !== input.artifactId) ||
      artifact.name !== input.name ||
      artifact.sequence.bases !== input.sequence.trim() ||
      stableJson(artifact.oligo ?? null) !== stableJson(input.oligo ?? null) ||
      stableJson(
        artifact.annealing ??
          (input.annealing && artifact.designProvenance
            ? {
                pbsSequence: artifact.designProvenance.pbsSequence,
                overhangSequence: artifact.designProvenance.overhangSequence,
              }
            : null)
      ) !== stableJson(input.annealing ?? null) ||
      artifact.metadata.application !== (input.application ?? null) ||
      primerArtifactNotes(artifact) !== expectedMetadata.notes ||
      (artifact.inventory?.origin ?? primerOriginFromArtifactSource(artifact.metadata.source)) !==
        (input.origin ??
          primerOriginFromArtifactSource(
            expectedArtifactSource(input.origin, target, input.artifactSource)
          )) ||
      stableJson(artifact.inventory?.originDetails ?? null) !==
        stableJson(input.originDetails ?? null) ||
      artifact.metadata.source !==
        expectedArtifactSource(input.origin, target, input.artifactSource) ||
      stableJson(artifact.designProvenance ?? null) !==
        stableJson(input.designProvenance ?? null) ||
      stableJson(artifact.entity?.schema ?? createBuiltinPrimerSchemaSnapshot(orderType)) !==
        stableJson(expectedSchema) ||
      stableJson(artifact.entity?.fields ?? {}) !== stableJson(expectedMetadata.fields)
    ) {
      return false;
    }
    if (!target) return artifact.bindings.length === 0;
    if (artifact.bindings.length !== 1) return false;
    const binding = artifact.bindings[0];
    return (
      binding.target.documentId === target.documentId &&
      binding.target.length === target.length &&
      binding.target.topology === target.topology &&
      binding.target.fileContentHash === (target.fileContentHash ?? target.contentHash) &&
      binding.target.normalizedSequenceHash ===
        (target.normalizedSequenceHash ?? target.contentHash) &&
      binding.coordinates.start === input.bindingStart &&
      binding.coordinates.end === input.bindingEnd &&
      binding.coordinates.strand === input.bindingStrand
    );
  }
  function equivalentBinding(
    left: PrimerArtifactBindingV1,
    right: PrimerArtifactBindingV1
  ): boolean {
    return (
      left.relation === right.relation &&
      left.target.documentId === right.target.documentId &&
      left.target.topology === right.target.topology &&
      left.target.length === right.target.length &&
      left.target.fileContentHash === right.target.fileContentHash &&
      left.target.normalizedSequenceHash === right.target.normalizedSequenceHash &&
      left.coordinates.system === right.coordinates.system &&
      left.coordinates.start === right.coordinates.start &&
      left.coordinates.end === right.coordinates.end &&
      left.coordinates.strand === right.coordinates.strand
    );
  }
  function randomId(): string {
    return globalThis.crypto.randomUUID();
  }
  function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }
  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  function samePrimerContent(
    artifact: PrimerArtifactV1,
    input: UpdatePrimerArtifactContentInput
  ): boolean {
    const metadata = resolvePrimerArtifactMetadata(
      input.entitySchema ?? artifact.entity?.schema ?? createBuiltinPrimerSchemaSnapshot(),
      input,
      artifact
    );
    return (
      (input.inventory === undefined ||
        stableJson(input.inventory) === stableJson(artifact.inventory)) &&
      (input.entityState === undefined ||
        stableJson(input.entityState) === stableJson(artifact.entity?.state)) &&
      (input.status === undefined || input.status === artifact.entity?.state?.status) &&
      (input.application === undefined || input.application === artifact.metadata.application) &&
      input.name.trim() === artifact.name &&
      input.sequence.trim() === artifact.sequence.bases &&
      (input.annealing === undefined ||
        stableJson(input.annealing ?? null) === stableJson(artifact.annealing ?? null)) &&
      (!Object.hasOwn(input, 'oligo') ||
        stableJson(input.oligo ?? null) === stableJson(artifact.oligo ?? null)) &&
      metadata.notes === primerArtifactNotes(artifact) &&
      stableJson(metadata.fields) === stableJson(artifact.entity?.fields ?? {}) &&
      (input.entitySchema === undefined ||
        stableJson(input.entitySchema) === stableJson(artifact.entity?.schema))
    );
  }
  return {
    deletePrimerArtifact,
    isFileAuthoritativePrimerInput,
    prepareUnboundPrimerArtifact,
    writeAndProjectPrimerArtifact,
    savePrimerArtifact,
    reconcilePrimerArtifact,
    reconcilePrimerArtifactsInWorkspace,
    attachPrimerArtifact,
    readSavedPrimerBindingTarget,
    persistOwnedPrimerArtifactBindings,
    updatePrimerArtifactBinding,
    detachPrimerArtifact,
    readPrimerArtifactForPrimer,
    retireTrashedPrimerArtifact,
    trashPrimerArtifact,
    readPrimerArtifactAtPath,
    updatePrimerArtifactContent,
    resumePrimerArtifactSave,
    projectPrimerArtifact,
    resolvePrimerBindings,
    commitPrimerBatchHistory,
    currentDirtyLimsPaths,
    primerArtifactRelativePath,
  };

  async function deletePrimerArtifact(
    input: DeletePrimerArtifactInput
  ): Promise<DeleteResult & { gitCommitted: boolean }> {
    const shell = platform().shell;
    if (!shell) throw new Error('Native file Trash is unavailable.');
    return withRendererWorkspaceMutation(input.workspaceRoot, async (mutationToken) => {
      const loaded = await loadArtifactForPrimer(input.primer, input.workspaceRoot);
      assertExpectedArtifactRevision(loaded.artifact, input.expectedArtifactRevision);
      const projected = await projectPrimerArtifact(loaded.artifact, input.workspaceRoot, {
        mutationToken,
      });
      const before = await currentDirtyLimsPaths(input.workspaceRoot, mutationToken);
      await shell.trashItem(loaded.path, mutationToken);
      await archiveLimsEntity(
        { id: input.primer.id, actor: 'agent', operationId: input.operationId },
        { mutationToken }
      );
      await markCatalogFileHistorical(loaded.path, 'primer-deleted');
      await platform().db.replacePrimerProjection(
        {
          ...primerLegacyProjectionFromArtifact(loaded.artifact, projected.primer.workspaceId, []),
          retireArtifact: {
            artifactPath: loaded.artifact.file.workspaceRelativePath,
            expectedArtifactRevision: loaded.artifact.artifactRevision,
          },
        },
        input.workspaceRoot,
        mutationToken
      );
      const history = await commitPrimerBatchHistory(
        input.workspaceRoot,
        [loaded.artifact.file.workspaceRelativePath],
        before,
        `Remove primer ${loaded.artifact.name}`,
        mutationToken
      );
      if (history === 'failed')
        throw new Error('The primer was removed but its project history could not be committed.');
      return { deleted: true, gitCommitted: history === 'committed' };
    });
  }

  async function requirePrimerTargetProjectId(workspaceRoot: string): Promise<string> {
    const rows = await platform().db.select<Array<{ repo_uuid: string | null }>>(
      'SELECT repo_uuid FROM workspaces WHERE path = ?',
      [workspaceRoot]
    );
    if (rows.length !== 1 || !rows[0].repo_uuid)
      throw new Error('The separate source project requires a stable managed project identity.');
    return rows[0].repo_uuid;
  }

  async function resolvePrimerBindingTargetRoot(
    projectId: string | undefined,
    workspaceRoot: string
  ): Promise<string | null> {
    if (!projectId) return workspaceRoot;
    const rows = await platform().db.select<Array<{ path: string }>>(
      'SELECT path FROM workspaces WHERE repo_uuid = ?',
      [projectId]
    );
    if (rows.length > 1) throw new Error('The primer source project identity is ambiguous.');
    return rows[0]?.path ?? null;
  }
}
export interface PrimerArtifactPersistencePort {
  writeAndProjectArtifact: ReturnType<
    typeof createPrimerArtifactOwner
  >['writeAndProjectPrimerArtifact'];
  saveArtifact: ReturnType<typeof createPrimerArtifactOwner>['savePrimerArtifact'];
  readArtifactAtPath: ReturnType<typeof createPrimerArtifactOwner>['readPrimerArtifactAtPath'];
}

export interface DeletePrimerArtifactInput {
  primer: Primer;
  workspaceRoot: string;
  expectedArtifactRevision: number;
  operationId: string;
}
