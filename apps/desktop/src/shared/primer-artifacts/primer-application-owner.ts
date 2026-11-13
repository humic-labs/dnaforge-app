import { canonicalEntityArtifactValue } from '../entity-artifact-projection';
import { validatePrimerSequence } from './primer-validation';
import { defaultPrimerArtifactPath } from './primer-artifact';
import type {
  CreatePrimerInput,
  CreateBindingInput,
  UpdatePrimerInput,
  Primer,
  PrimerBinding,
  DeleteResult,
  ImportBatchResult,
} from './types';
import {
  calculatePrimerTmWithCalculator,
  type PrimerTmCalculationService,
  type PrimerTmCalculationV1,
} from '../primer-tm-contract';
import type { createPrimerRepository } from './primer-repository';
import type {
  createPrimerArtifactOwner,
  FileAuthoritativePrimerInput,
  PrimerMutationOptions,
  ReadPrimerArtifactResult,
} from './primer-artifact-owner';
import type { createCatalogRepository } from '../../db/catalog-repository';
import type { PrimerRecoveryDependencies } from './primer-recovery-port';
import type { ArtifactRegistryOperations } from '../artifact-operation-ports';
export interface PrimerApplicationDependencies {
  io: PrimerRecoveryDependencies['io'];
  repository: ReturnType<typeof createPrimerRepository>;
  artifacts: ReturnType<typeof createPrimerArtifactOwner>;
  catalog: Pick<ReturnType<typeof createCatalogRepository>, 'getCatalogFilesForEntity'>;
  tm: PrimerTmCalculationService;
  withRendererWorkspaceMutation: PrimerRecoveryDependencies['withRendererWorkspaceMutation'];
  buildFileDnaSequenceRef: PrimerRecoveryDependencies['buildFileDnaSequenceRef'];
  queryLimsEntities: ArtifactRegistryOperations['queryLimsEntities'];
}
const UNVERIFIED_LEGACY_TM_MESSAGE =
  'The selected temperature provider could not verify this primer. No changes were saved.';
export function createPrimerApplicationOwner(dependencies: PrimerApplicationDependencies) {
  const platform = dependencies.io;
  const primerTmCalculationService = dependencies.tm;
  const { getPrimerById, listBoundPrimers } = dependencies.repository;
  const { getCatalogFilesForEntity } = dependencies.catalog;
  const { withRendererWorkspaceMutation, buildFileDnaSequenceRef, queryLimsEntities } =
    dependencies;
  const {
    attachPrimerArtifact,
    detachPrimerArtifact,
    trashPrimerArtifact,
    readPrimerArtifactForPrimer,
    primerArtifactRelativePath,
    reconcilePrimerArtifactsInWorkspace,
    savePrimerArtifact,
    updatePrimerArtifactContent,
  } = dependencies.artifacts;
  function generateId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }

    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
  async function resolvePrimerProject(input: { workspaceRoot?: string; workspaceId?: number }) {
    if (input.workspaceRoot || input.workspaceId != null) {
      const [owner] = await platform().db.select<Array<{ id: number; path: string }>>(
        `SELECT id, path FROM workspaces WHERE ${input.workspaceRoot ? 'path' : 'id'} = ?
       AND archived_at IS NULL AND trashed_at IS NULL AND access_mode = 'writable'`,
        [input.workspaceRoot ?? input.workspaceId!]
      );
      if (!owner || (input.workspaceId != null && input.workspaceId !== owner.id))
        throw new Error('A saved primer requires a registered, writable project.');
      return { workspaceRoot: owner.path, workspaceId: owner.id };
    }
    const original = await platform().workspace.getOriginalDefaultProject();
    if (original.status !== 'ready') throw new Error(original.message);
    return { workspaceRoot: original.project.rootPath, workspaceId: original.project.workspaceId };
  }
  async function primerCreationInput(
    input: CreatePrimerInput
  ): Promise<FileAuthoritativePrimerInput> {
    const { workspaceRoot, workspaceId } = await resolvePrimerProject(input);
    let binding: Partial<CreatePrimerInput> = {};
    if (input.bindingSequenceId != null) {
      const [file] = await platform().db.select<Array<{ path: string }>>(
        'SELECT f.path FROM sequences s JOIN indexed_files f ON f.id = s.file_id WHERE s.id = ?',
        [input.bindingSequenceId]
      );
      if (!file) throw new Error('The primer binding target is unavailable.');
      const target = await buildFileDnaSequenceRef(file.path, { workspaceRoot });
      binding = {
        targetFilePath: input.targetFilePath ?? file.path,
        targetDocumentId: input.targetDocumentId ?? target.documentId,
        targetLength: input.targetLength ?? target.length,
        targetTopology: input.targetTopology ?? target.topology,
        bindingStart: input.bindingStart ?? 0,
        bindingEnd: input.bindingEnd ?? input.sequence.trim().length,
        bindingStrand: input.bindingStrand ?? 1,
      };
    }
    return {
      ...input,
      ...binding,
      workspaceRoot,
      workspaceId,
      artifactPath: input.artifactPath ?? defaultPrimerArtifactPath(workspaceRoot, generateId()),
      requireRegistry: true,
    };
  }
  async function createPrimer(input: CreatePrimerInput): Promise<Primer> {
    const file = await primerCreationInput(input);
    const validation = validatePrimerSequence(file.sequence, {
      orderType: file.oligo?.orderType ?? 'dna',
    });
    if (!validation.valid) throw new Error('Invalid primer sequence.');
    file.sequence = validation.trimmed ?? file.sequence.trim();
    if (file.oligo?.orderType !== 'rna') {
      file.tmCalculation = await primerTmCalculationService.calculate(file.sequence);
      if (file.tmCalculation.status === 'fallback') throw new Error(UNVERIFIED_LEGACY_TM_MESSAGE);
    }
    return (await savePrimerArtifact(file)).primer;
  }
  async function withPrimerDocument<T>(
    primer: Primer,
    operation: (
      primer: Primer,
      loaded: ReadPrimerArtifactResult,
      workspaceRoot: string,
      mutationToken?: string
    ) => Promise<T>,
    options: PrimerMutationOptions = {}
  ): Promise<T> {
    const currentFiles = (await getCatalogFilesForEntity(primer.id)).filter(
      (file) => file.status === 'current'
    );
    const fileOwner = currentFiles[0]?.workspace_id;
    if (
      currentFiles.length > 1 ||
      (fileOwner != null && primer.workspaceId != null && fileOwner !== primer.workspaceId)
    )
      throw new Error(
        'The primer has conflicting project ownership; review its saved document before editing.'
      );
    const { workspaceRoot } = await resolvePrimerProject({
      workspaceId: primer.workspaceId ?? fileOwner ?? undefined,
    });
    return withRendererWorkspaceMutation(
      workspaceRoot,
      async (mutationToken) => {
        if (!primerArtifactRelativePath(primer)) {
          const recovery = await reconcilePrimerArtifactsInWorkspace(workspaceRoot, {
            candidatePaths: [],
            mutationToken,
          });
          const recovered = await getPrimerById(primer.id);
          if (!recovered || !primerArtifactRelativePath(recovered))
            throw new Error(
              recovery.errors.find((error) => error.path.endsWith(primer.id))?.message ??
                'The primer must have a saved project document before it can be changed.'
            );
          primer = recovered;
        }
        return operation(
          primer,
          await readPrimerArtifactForPrimer(primer, workspaceRoot, { mutationToken }),
          workspaceRoot,
          mutationToken
        );
      },
      options.mutationToken
    );
  }
  async function updatePrimer(
    input: UpdatePrimerInput,
    options: PrimerMutationOptions = {}
  ): Promise<Primer | null> {
    const status = input.status;
    if (
      status !== undefined &&
      status !== 'designed' &&
      status !== 'ordered' &&
      status !== 'received' &&
      status !== 'verified' &&
      status !== 'archived'
    )
      throw new Error('Unknown primer lifecycle status.');
    const existing = await getPrimerById(input.id);
    if (!existing) return null;
    return withPrimerDocument(
      existing,
      async (primer, loaded, workspaceRoot, mutationToken) => {
        const artifact = loaded.artifact;
        const sequence = input.sequence ?? artifact.sequence.bases;
        if (sequence !== artifact.sequence.bases && artifact.oligo)
          throw new Error('Use the oligo editor to change a primer with recorded chemistry.');
        if (
          input.modifications !== undefined &&
          artifact.oligo &&
          input.modifications !== primer.modifications
        )
          throw new Error('Use the oligo editor to change recorded chemistry.');
        if (
          !validatePrimerSequence(sequence, { orderType: artifact.oligo?.orderType ?? 'dna' }).valid
        )
          throw new Error('Invalid primer sequence.');
        const tmCalculation =
          sequence !== artifact.sequence.bases
            ? await primerTmCalculationService.calculate(sequence)
            : undefined;
        if (tmCalculation?.status === 'fallback') throw new Error(UNVERIFIED_LEGACY_TM_MESSAGE);
        const [entity] = await queryLimsEntities({
          id: primer.id,
          includeArchived: true,
          limit: 1,
        });
        if (!entity) throw new Error('The saved primer Registry identity is unavailable.');
        const priorState = artifact.entity?.state ?? {
          registrationStatus: entity.registrationStatus,
          domainStatus: entity.domainStatus,
          archived: Boolean(entity.tombstone),
          archivedAt: entity.archivedAt ?? null,
          status:
            typeof entity.fields.status === 'string' || entity.fields.status === null
              ? entity.fields.status
              : primer.status,
          source:
            typeof entity.fields.source === 'string' || entity.fields.source === null
              ? entity.fields.source
              : artifact.metadata.source,
        };
        const archived = input.status === 'archived';
        const entityState =
          input.status === undefined
            ? priorState
            : {
                ...priorState,
                status: input.status,
                domainStatus: input.status,
                archived,
                archivedAt: archived ? (priorState.archivedAt ?? Date.now()) : null,
              };
        const priorInventory = artifact.inventory ?? {
          origin: primer.origin,
          originDetails: primer.originDetails,
          vendor: primer.vendor,
          orderDate: primer.orderDate,
          scale: primer.scale,
          purification: primer.purification,
          modifications: primer.modifications,
          stockLocation: primer.stockLocation,
          concentration: primer.concentration,
        };
        const inventory = {
          ...priorInventory,
          vendor: input.vendor === undefined ? priorInventory.vendor : input.vendor,
          orderDate: input.orderDate === undefined ? priorInventory.orderDate : input.orderDate,
          scale: input.scale === undefined ? priorInventory.scale : input.scale,
          purification:
            input.purification === undefined ? priorInventory.purification : input.purification,
          modifications:
            input.modifications === undefined ? priorInventory.modifications : input.modifications,
          stockLocation:
            input.stockLocation === undefined ? priorInventory.stockLocation : input.stockLocation,
          concentration:
            input.concentration === undefined ? priorInventory.concentration : input.concentration,
        };
        return (
          await updatePrimerArtifactContent(
            {
              artifactPath: loaded.path,
              workspaceRoot,
              expectedArtifactRevision: artifact.artifactRevision,
              acceptedRevision: loaded.acceptedRevision,
              name: input.name ?? artifact.name,
              sequence,
              notes: input.notes,
              application: input.application,
              inventory,
              tmCalculation,
              entityState,
              status,
            },
            { mutationToken }
          )
        ).primer;
      },
      options
    );
  }
  async function deletePrimer(
    id: string,
    options: PrimerMutationOptions = {}
  ): Promise<DeleteResult> {
    const primer = await getPrimerById(id);
    if (!primer) return { deleted: false, reason: 'not_found' };
    await withPrimerDocument(
      primer,
      (current, loaded, root, mutationToken) =>
        trashPrimerArtifact(current, loaded, root, { mutationToken }),
      options
    );
    return { deleted: true };
  }
  async function createBinding(
    input: CreateBindingInput,
    options: PrimerMutationOptions = {}
  ): Promise<PrimerBinding> {
    const primer = await getPrimerById(input.primerId);
    if (!primer) throw new Error('The primer is unavailable.');
    return withPrimerDocument(
      primer,
      async (current, loaded, workspaceRoot, mutationToken) => {
        const [file] = await platform().db.select<Array<{ path: string }>>(
          'SELECT f.path FROM sequences s JOIN indexed_files f ON f.id = s.file_id WHERE s.id = ?',
          [input.sequenceId]
        );
        if (!file) throw new Error('The primer binding target is unavailable.');
        const target = await buildFileDnaSequenceRef(file.path, { workspaceRoot });
        const now = Date.now();
        const result = await attachPrimerArtifact(
          {
            primer: current,
            workspaceRoot,
            targetFilePath: file.path,
            targetDocumentId: target.documentId,
            bindingSequenceId: input.sequenceId,
            bindingStart: input.bindingStart,
            bindingEnd: input.bindingEnd,
            bindingStrand: input.strand,
            expectedArtifactRevision: loaded.artifact.artifactRevision,
            history: { source: input.source ?? 'manual', createdAt: now, updatedAt: now },
          },
          { mutationToken }
        );
        const bound = (await listBoundPrimers(input.sequenceId)).find(
          (row) => row.binding.id === result.bindingId
        );
        if (!bound) throw new Error('The saved primer binding could not be projected.');
        return bound.binding;
      },
      options
    );
  }
  async function deleteBinding(
    bindingId: string,
    options: PrimerMutationOptions = {}
  ): Promise<void> {
    const [binding] = await platform().db.select<Array<{ primer_id: string }>>(
      'SELECT primer_id FROM primer_bindings WHERE id = ?',
      [bindingId]
    );
    if (!binding) return;
    const primer = await getPrimerById(binding.primer_id);
    if (!primer) throw new Error('The primer owning this binding is unavailable.');
    await withPrimerDocument(
      primer,
      (current, _loaded, workspaceRoot, mutationToken) =>
        detachPrimerArtifact({ primer: current, workspaceRoot, bindingId }, { mutationToken }),
      options
    );
  }
  async function importBatch(primers: CreatePrimerInput[]): Promise<ImportBatchResult> {
    const errors: ImportBatchResult['errors'] = [];
    const seen = new Set<string>();
    const prepared: Array<{ index: number; file: FileAuthoritativePrimerInput }> = [];
    let duplicates = 0;
    let imported = 0;
    const calculator = primerTmCalculationService.createCalculator({
      onProviderError: (error) =>
        console.warn('[primer-import] Selected calculation provider unavailable.', error),
    });
    for (const [index, input] of primers.entries()) {
      const validation = validatePrimerSequence(input.sequence, {
        orderType: input.oligo?.orderType ?? 'dna',
      });
      if (!validation.valid) {
        errors.push({
          index,
          reason: `Invalid primer sequence: ${validation.errors?.map((error) => error.reason ?? error.char).join(', ')}`,
        });
        continue;
      }
      const sequence = validation.trimmed ?? input.sequence.trim();
      const key = JSON.stringify(
        canonicalEntityArtifactValue({
          sequence: sequence.toUpperCase(),
          oligo: input.oligo ?? null,
          schema: input.entitySchema?.schemaRevisionId ?? null,
          fields: input.entityFields ?? {},
        })
      );
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      try {
        prepared.push({ index, file: await primerCreationInput({ ...input, sequence }) });
      } catch (error) {
        errors.push({ index, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    const outcomes = new Array<
      | { index: number; file: FileAuthoritativePrimerInput; calculation?: PrimerTmCalculationV1 }
      | undefined
    >(prepared.length);
    let cursor = 0;
    const calculate = async () => {
      while (cursor < prepared.length) {
        const position = cursor++;
        const item = prepared[position];
        try {
          const calculation =
            item.file.oligo?.orderType === 'rna'
              ? undefined
              : await calculatePrimerTmWithCalculator(calculator, item.file.sequence);
          if (calculation?.status === 'fallback') throw new Error(UNVERIFIED_LEGACY_TM_MESSAGE);
          outcomes[position] = { ...item, calculation };
        } catch (error) {
          errors.push({
            index: item.index,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, prepared.length) }, calculate));
    for (const item of outcomes) {
      if (!item) continue;
      try {
        await savePrimerArtifact({ ...item.file, tmCalculation: item.calculation });
        imported++;
      } catch (error) {
        errors.push({
          index: item.index,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    errors.sort((left, right) => left.index - right.index);
    return { imported, errors, duplicates };
  }
  return {
    persistOwnedPrimerBinding: dependencies.repository.persistOwnedPrimerBinding,
    createPrimer,
    updatePrimer,
    deletePrimer,
    createBinding,
    deleteBinding,
    importBatch,
  };
}
