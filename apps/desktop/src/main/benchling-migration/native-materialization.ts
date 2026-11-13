import { createHash } from 'node:crypto';
import { migrationSourceForObject } from './reviewed-table-source';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  parseNotebookPackageDocument,
  type NotebookPackageDocument,
} from '../../db/notebook-package';
import { readCanonicalNotebookPackage } from '../../db/notebook-package-migration';
import {
  isExactProviderStableId,
  isSafeProviderCanonicalUrl,
  providerObjectClassForStableId,
} from '../../shared/provider-object-reference';
import type {
  NativeWorkspaceManifestSourceIdentity,
  NativeWorkspacePlacement,
  NativeWorkspaceMigrationSourceRef,
} from '../../shared/native-workspace-manifest';
import type {
  MigrationRun,
  ProjectionReceipt,
  RelationshipResolution,
  SourceObject,
} from '../../shared/benchling-migration';
import {
  NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
  type NativeWorkspaceEntityInput,
  type NativeWorkspaceMaterializationPlan,
  type NativeExistingEntityReplacement,
} from '../native-workspace-materializer';
import type { CollectionProjection } from './collection-projection';
import { nativeFolderPathMap } from './collection-projection-writer';
import { mapBenchlingStrainFields } from './benchling-strain-field-map';
import type {
  BenchlingNeedsSequenceContent,
  BenchlingStrainContent,
} from './native-record-classifier';
import { nativeSequenceMaterializationFacts } from './source-object-materialization-view';
import { nativeRegistryRecordInput } from './native-registry-record';
import { parseOligoClassificationEvidence } from '../../shared/oligo-classification';

export async function buildNativeMigrationMaterializationPlan(input: {
  run: MigrationRun;
  sourceObjects: readonly SourceObject[];
  receipts: readonly ProjectionReceipt[];
  resolutions: readonly RelationshipResolution[];
  folderProjection: CollectionProjection | null;
  existingEntityRawIds?: ReadonlySet<string>;
  existingLimsEntityRawIds?: ReadonlySet<string>;
  needsSequenceCompletionRawIds?: ReadonlySet<string>;
  existingEntityReplacements?: ReadonlyMap<string, NativeExistingEntityReplacement>;
  migrationSourcesByObjectId?: ReadonlyMap<string, NativeWorkspaceMigrationSourceRef>;
}): Promise<NativeWorkspaceMaterializationPlan> {
  const nativeLayout = Boolean(
    input.run.externalZipSource || input.run.baseline?.kind === 'adopted_workspace'
  );
  const receiptBySourceId = new Map(
    input.receipts.map((receipt) => [receipt.sourceObjectId, receipt])
  );
  if (receiptBySourceId.size !== input.receipts.length) {
    throw new Error('Native materialization received duplicate projection receipts.');
  }
  const sourceByIdentity = new Map<string, SourceObject>();
  for (const source of input.sourceObjects) {
    for (const identity of [source.id, source.stableId]) {
      const existing = sourceByIdentity.get(identity);
      if (existing && existing.id !== source.id) {
        throw new Error(`Native materialization source identity is ambiguous: ${identity}`);
      }
      sourceByIdentity.set(identity, source);
    }
  }

  const entities: NativeWorkspaceEntityInput[] = [];
  const entityBySourceId = new Map<string, NativeWorkspaceEntityInput>();
  for (const source of input.sourceObjects) {
    const receipt = receiptBySourceId.get(source.id);
    if (!receipt) throw new Error(`Native materialization is missing receipt for ${source.id}.`);
    const isExisting = input.existingEntityRawIds?.has(receipt.destinationObjectId) ?? false;
    const isCompletion =
      input.needsSequenceCompletionRawIds?.has(receipt.destinationObjectId) ?? false;
    const isReplacement =
      input.existingEntityReplacements?.has(receipt.destinationObjectId) ?? false;
    if (isCompletion && !isExisting) {
      throw new Error(
        `Needs sequence completion is not an existing entity: ${receipt.destinationObjectId}`
      );
    }
    if (isExisting && !isCompletion && !isReplacement) continue;
    const entity = await nativeEntityForReceipt(input.run, source, receipt);
    const migrationSource = input.migrationSourcesByObjectId?.get(source.id);
    if (migrationSource) entity.migrationSource = migrationSource;
    entities.push(entity);
    entityBySourceId.set(source.id, entity);
  }

  const folderPaths = input.folderProjection
    ? nativeFolderPathMap(input.folderProjection, nativeLayout ? 'native-v2' : 'legacy-v1')
    : new Map<string, string>();
  for (const folder of input.folderProjection?.collections ?? []) {
    const relativePath = folderPaths.get(folder.id);
    if (!relativePath) throw new Error(`Native folder path is missing for ${folder.id}.`);
    const legacyFolderFields = nativeLayout ? {} : { relativePath, fileKind: 'folder' };
    entities.push({
      rawId: folder.id,
      type: 'folder',
      name: folder.title,
      locator: { kind: 'file' },
      storageType: 'file',
      ...legacyFolderFields,
      ...(nativeLayout
        ? {
            placement: {
              kind: 'file',
              relativePath,
              fileKind: 'folder',
            } satisfies NativeWorkspacePlacement,
          }
        : {}),
      metadata: {
        imported: true,
        sourceFolderIdentity: folder.provenance.sourceFolderId,
        sourceProvider: folder.provenance.provider,
        selectedRoot: folder.provenance.selectedRoot,
      },
    });
  }

  const links: NativeWorkspaceMaterializationPlan['links'] = [];
  for (const folder of input.folderProjection?.collections ?? []) {
    if (folder.parentCollectionId) {
      links.push({
        sourceRawId: folder.parentCollectionId,
        relation: 'contains',
        targetRawId: folder.id,
        evidence: { kind: 'folder_hierarchy' },
      });
    }
    for (const objectId of folder.memberObjectIds) {
      links.push({
        sourceRawId: folder.id,
        relation: 'contains',
        targetRawId: objectId,
        evidence: { kind: 'folder_membership' },
      });
    }
  }
  for (const resolution of input.resolutions) {
    if (resolution.classification !== 'exact' || !resolution.targetSourceId) continue;
    const sourceReceipt = receiptBySourceId.get(resolution.sourceObjectId);
    const targetSource = sourceByIdentity.get(resolution.targetSourceId);
    const targetReceipt = targetSource ? receiptBySourceId.get(targetSource.id) : undefined;
    if (!sourceReceipt || !targetSource || !targetReceipt) continue;
    links.push({
      sourceRawId: sourceReceipt.destinationObjectId,
      relation: resolution.relationType,
      targetRawId: targetReceipt.destinationObjectId,
      evidence: {
        kind: 'migration_relationship',
        relationshipId: resolution.relationshipId,
        classification: resolution.classification,
        targetProviderStableId: targetSource.stableId,
      },
    });
  }

  const limsEntities: NonNullable<NativeWorkspaceMaterializationPlan['limsEntities']> = [];
  for (const source of input.sourceObjects) {
    const receipt = receiptBySourceId.get(source.id);
    if (!receipt) continue;
    const sourceType = normalizeSourceType(source.sourceType);
    const content = record(source.content);
    if (!content) continue;
    const createdAt = requiredIsoTimestamp(
      source.createdAt ?? input.run.createdAt,
      `LIMS creation time for ${source.id}`
    );
    if (sourceType === 'registry_record') {
      limsEntities.push({
        entityRawId: receipt.destinationObjectId,
        input: nativeRegistryRecordInput({
          source,
          scopeId: input.run.projectionScopeId ?? input.run.workspaceId,
          createdAt,
          resolveTarget: (relationshipId, sourceTargetId) => {
            const resolution = input.resolutions.find(
              (entry) =>
                entry.relationshipId === relationshipId && entry.sourceObjectId === source.id
            );
            if (
              resolution?.classification !== 'exact' ||
              resolution.targetSourceId !== sourceTargetId
            )
              return null;
            const targetSource = sourceByIdentity.get(sourceTargetId);
            return targetSource
              ? (receiptBySourceId.get(targetSource.id)?.destinationObjectId ?? null)
              : null;
          },
        }),
      });
      continue;
    }
    if (sourceType === 'strain') {
      const strain = benchlingStrainContent(content);
      const fields = mapBenchlingStrainFields({
        stableId: source.stableId,
        fields: strain.fields,
      });
      limsEntities.push({
        entityRawId: receipt.destinationObjectId,
        input: {
          kind: 'strain',
          name: source.name,
          fields,
          registrationStatus:
            typeof fields.genotypeCanonical === 'string' ? 'registered' : 'unresolved',
          actor: 'migration',
          createdAt,
        },
      });
      continue;
    }
    if (isNeedsSequenceContent(content)) {
      limsEntities.push({
        entityRawId: receipt.destinationObjectId,
        input: {
          kind: 'dna_sequence',
          name: source.name,
          fields: {
            sequence: { mode: 'unresolved' },
            source: 'external_migration',
            sourceMetadata: needsSequenceSourceMetadata(source, content),
          },
          registrationStatus: 'unresolved',
          actor: 'migration',
          createdAt,
        },
      });
      continue;
    }
    if (!['dna_sequence', 'rna_sequence', 'protein'].includes(sourceType)) continue;
    if (receipt.destination?.kind === 'catalog-record' && sourceType === 'dna_sequence') {
      if (typeof content.bases !== 'string' || content.bases.length === 0) {
        throw new Error(`Catalog DNA ${source.id} is missing its sequence payload.`);
      }
      limsEntities.push({
        entityRawId: receipt.destinationObjectId,
        input: {
          kind: 'dna_sequence',
          name: receipt.destination.displayName,
          fields: {
            sequence: {
              mode: 'inline',
              bases: content.bases,
              topology: content.topology === 'circular' ? 'circular' : 'linear',
              length: content.bases.length,
            },
            source: 'external_migration',
          },
          registrationStatus: 'registered',
          actor: 'migration',
          createdAt,
        },
      });
      continue;
    }
    const absolutePath = join(input.run.workspacePath, receipt.destinationPath);
    const nativeEntity = entityBySourceId.get(source.id);
    const fileHash = nativeEntity?.contentHash;
    if (!fileHash) continue;
    const materializationFacts = nativeSequenceMaterializationFacts(content);
    if (sourceType === 'protein') {
      const aminoAcids = typeof content.aminoAcids === 'string' ? content.aminoAcids : '';
      const sequenceFacts =
        materializationFacts?.kind === 'protein'
          ? materializationFacts
          : aminoAcids
            ? {
                kind: 'protein' as const,
                length: aminoAcids.length,
                normalizedSequenceHash: `sha256:${sha256(aminoAcids.toUpperCase())}` as const,
              }
            : null;
      if (!sequenceFacts) continue;
      limsEntities.push({
        entityRawId: receipt.destinationObjectId,
        input: {
          kind: 'protein',
          name: source.name,
          fields: {
            sequence: {
              mode: 'file',
              relPath: absolutePath,
              length: sequenceFacts.length,
              contentHash: fileHash,
              fileContentHash: fileHash,
              normalizedSequenceHash: sequenceFacts.normalizedSequenceHash,
              sourceFormat: 'fasta',
              sizeBytes: nativeEntity.sizeBytes ?? undefined,
              modifiedAt: nativeEntity.modifiedAt ?? undefined,
            },
            source: 'external_migration',
          },
          registrationStatus: 'registered',
          actor: 'migration',
          createdAt,
        },
      });
      continue;
    }
    const bases = typeof content.bases === 'string' ? content.bases : '';
    const sequenceFacts =
      materializationFacts?.kind === 'nucleotide'
        ? materializationFacts
        : bases
          ? {
              kind: 'nucleotide' as const,
              length: bases.length,
              normalizedSequenceHash: `sha256:${sha256(bases.toUpperCase())}` as const,
              topology:
                content.topology === 'circular' ? ('circular' as const) : ('linear' as const),
            }
          : null;
    if (!sequenceFacts) continue;
    limsEntities.push({
      entityRawId: receipt.destinationObjectId,
      input: {
        kind: sourceType as 'dna_sequence' | 'rna_sequence',
        name: source.name,
        fields: {
          sequence: {
            mode: 'file',
            relPath: absolutePath,
            topology: sequenceFacts.topology,
            length: sequenceFacts.length,
            contentHash: fileHash,
            fileContentHash: fileHash,
            normalizedSequenceHash: sequenceFacts.normalizedSequenceHash,
            sourceFormat: 'genbank',
            sizeBytes: nativeEntity.sizeBytes ?? undefined,
            modifiedAt: nativeEntity.modifiedAt ?? undefined,
          },
          source: 'external_migration',
        },
        registrationStatus: 'registered',
        actor: 'migration',
        createdAt,
      },
    });
  }
  const limsEntityRawIds = new Set(limsEntities.map((entry) => entry.entityRawId));
  for (const existingLimsEntityRawId of input.existingLimsEntityRawIds ?? []) {
    if (!input.existingEntityRawIds?.has(existingLimsEntityRawId)) {
      throw new Error(
        `Existing LIMS entity is not an existing native entity: ${existingLimsEntityRawId}`
      );
    }
    limsEntityRawIds.add(existingLimsEntityRawId);
  }
  const limsLinks: NonNullable<NativeWorkspaceMaterializationPlan['limsLinks']> = [];
  for (const resolution of input.resolutions) {
    if (resolution.classification !== 'exact' || !resolution.targetSourceId) continue;
    const sourceReceipt = receiptBySourceId.get(resolution.sourceObjectId);
    const targetSource = sourceByIdentity.get(resolution.targetSourceId);
    const targetReceipt = targetSource ? receiptBySourceId.get(targetSource.id) : undefined;
    if (
      !sourceReceipt ||
      !targetReceipt ||
      !limsEntityRawIds.has(sourceReceipt.destinationObjectId) ||
      !limsEntityRawIds.has(targetReceipt.destinationObjectId) ||
      sourceReceipt.destinationObjectId === targetReceipt.destinationObjectId
    ) {
      continue;
    }
    const type = nativeLimsRelationshipType(resolution.relationType);
    limsLinks.push({
      id: `link-${sha256(`${sourceReceipt.destinationObjectId}:${type}:${targetReceipt.destinationObjectId}`).slice(0, 24)}`,
      fromEntityRawId: sourceReceipt.destinationObjectId,
      toEntityRawId: targetReceipt.destinationObjectId,
      type,
      payload: {
        sourceRelation: resolution.relationType,
        sourceClassification: resolution.classification,
        ...(sourceByIdentity.get(resolution.sourceObjectId)?.sourceType === 'registry_record'
          ? { sourceRelationshipId: resolution.relationshipId }
          : {}),
      },
    });
  }
  const pendingReferences = input.resolutions.flatMap((resolution) => {
    if (!['unresolved', 'ambiguous'].includes(resolution.classification)) return [];
    const sourceReceipt = receiptBySourceId.get(resolution.sourceObjectId);
    if (!sourceReceipt || !limsEntityRawIds.has(sourceReceipt.destinationObjectId)) return [];
    const candidateSources = resolution.candidateSourceIds.flatMap((identity) => {
      const source = sourceByIdentity.get(identity);
      return source ? [source] : [];
    });
    const candidateEntityRawIds = candidateSources.flatMap((source) => {
      const receipt = receiptBySourceId.get(source.id);
      return receipt && limsEntityRawIds.has(receipt.destinationObjectId)
        ? [receipt.destinationObjectId]
        : [];
    });
    const targetName = pendingRelationshipTargetName(resolution);
    if (!targetName) return [];
    const targetKind = pendingRelationshipTargetKind(resolution, candidateSources);
    const targetProviderIdentity = pendingRelationshipTargetProviderIdentity(resolution);
    return [
      {
        id: resolution.relationshipId,
        sourceEntityRawId: sourceReceipt.destinationObjectId,
        relationType: nativeLimsRelationshipType(resolution.relationType),
        targetName,
        ...(targetKind ? { targetKind } : {}),
        ...(targetProviderIdentity ? { targetProviderIdentity } : {}),
        classification: resolution.classification as 'unresolved' | 'ambiguous',
        candidateEntityRawIds: [...new Set(candidateEntityRawIds)].sort(),
      },
    ];
  });

  const createdAt = requiredIsoTimestamp(input.run.createdAt, 'Migration creation time');
  return {
    schema: NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
    ...(input.needsSequenceCompletionRawIds && input.needsSequenceCompletionRawIds.size > 0
      ? { needsSequenceCompletionRawIds: [...input.needsSequenceCompletionRawIds].sort() }
      : {}),
    ...(input.existingEntityReplacements && input.existingEntityReplacements.size > 0
      ? {
          existingEntityReplacements: [...input.existingEntityReplacements]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([, replacement]) => replacement),
        }
      : {}),
    entities,
    links: deduplicateLinks(links),
    events: entities.map((entity) => ({
      id: `import-${sha256(`${input.run.id}:${entity.rawId}`).slice(0, 32)}`,
      entityRawId: entity.rawId,
      eventType: 'imported',
      actor: 'migration',
      summary: 'Imported into DNAForge',
      payload: { source: 'external_migration' },
      createdAt,
    })),
    limsEntities,
    limsLinks: deduplicateLimsLinks(limsLinks),
    ...(pendingReferences.length > 0 ? { pendingReferences } : {}),
  };
}

async function nativeEntityForReceipt(
  run: MigrationRun,
  source: SourceObject,
  receipt: ProjectionReceipt
): Promise<NativeWorkspaceEntityInput> {
  const sourceType = normalizeSourceType(source.sourceType);
  const entityType = nativeEntityType(sourceType);
  const isNotebook = sourceType === 'notebook' || sourceType === 'notebook_entry';
  const isDatabaseLimsEntity =
    receipt.destination?.kind === 'catalog-record' ||
    sourceType === 'strain' ||
    (record(source.content)?.kind === 'dna_sequence_needs_sequence' &&
      sourceType === 'dna_sequence');
  const destination = receipt.destination;
  if (run.externalZipSource && !destination) {
    throw new Error(`Native-v2 receipt has no destination: ${receipt.sourceObjectId}`);
  }
  if (destination?.kind === 'catalog-record' && destination.catalogType !== entityType) {
    throw new Error(`Native catalog placement type changed: ${receipt.sourceObjectId}`);
  }
  const primaryRelativePath =
    destination?.kind === 'file'
      ? destination.relativePath
      : destination?.kind === 'package'
        ? destination.primaryRelativePath
        : destination?.kind === 'catalog-record'
          ? null
          : receipt.destinationPath;
  const primaryPath = primaryRelativePath ? join(run.workspacePath, primaryRelativePath) : null;
  const stats = primaryPath ? await lstat(primaryPath) : null;
  if (stats && (!stats.isFile() || stats.isSymbolicLink())) {
    throw new Error(`Native projection is not a regular file: ${primaryRelativePath}`);
  }
  const bytes = primaryPath ? await readFile(primaryPath) : null;
  if (isNotebook && !bytes) {
    throw new Error(`Native notebook has no primary artifact: ${receipt.sourceObjectId}`);
  }
  let pageDocument =
    isNotebook && bytes ? parseNotebookPackageDocument(bytes.toString('utf8')) : null;
  if (pageDocument?.formatVersion === 2 && primaryPath && bytes) {
    const canonical = await readCanonicalNotebookPackage(
      {
        exists: async () => true,
        readTextFile: async (path) => readFile(path, 'utf8'),
      },
      dirname(dirname(primaryPath)),
      bytes.toString('utf8')
    );
    pageDocument = {
      ...pageDocument,
      title: canonical.metadata.title,
      content: canonical.parsed.content,
    };
  }
  const sourceIdentities = providerSourceIdentities(source);
  const fileKind = primaryRelativePath ? nativeFileKind(sourceType, primaryRelativePath) : null;
  const placement: NativeWorkspacePlacement | undefined =
    run.externalZipSource || run.baseline?.kind === 'adopted_workspace'
      ? destination
        ? destination.kind === 'file'
          ? { ...destination, fileKind: fileKind ?? 'file' }
          : destination.kind === 'package'
            ? { ...destination, fileKind: fileKind ?? 'file' }
            : {
                ...destination,
                catalogType: entityType,
              }
        : undefined
      : undefined;
  const legacyRelativePath = isNotebook
    ? dirname(dirname(receipt.destinationPath))
    : receipt.destinationPath;
  const contentHash = bytes ? `sha256:${sha256(bytes)}` : null;
  const classificationEvidence =
    isNotebook || sourceType === 'protocol'
      ? parseOligoClassificationEvidence(source.metadata.classificationEvidence)
      : null;
  return {
    rawId: receipt.destinationObjectId,
    type: entityType,
    name: destination?.kind === 'catalog-record' ? destination.displayName : source.name,
    locator: isNotebook
      ? { kind: 'entity', namespace: 'page' }
      : isDatabaseLimsEntity
        ? { kind: 'entity', namespace: 'lims' }
        : { kind: 'file' },
    storageType: isNotebook || isDatabaseLimsEntity ? 'database' : 'file',
    ...(placement ? { placement } : {}),
    ...(!placement
      ? {
          relativePath: legacyRelativePath,
          fileKind: isDatabaseLimsEntity
            ? 'benchling-native-record-evidence'
            : nativeFileKind(sourceType, receipt.destinationPath),
        }
      : {}),
    contentHash,
    sizeBytes: stats?.size ?? null,
    modifiedAt: stats ? Math.floor(stats.mtimeMs) : null,
    metadata: {
      imported: true,
      portableId: receipt.destinationObjectId,
      sourceType,
      projection: receipt.projection,
      nativeRepresentation: receipt.nativeRepresentation ?? null,
      ...(classificationEvidence &&
      classificationEvidence.facts.every((fact) => fact.sourceObjectId === source.id)
        ? { classificationEvidence }
        : {}),
      ...(isDatabaseLimsEntity
        ? {
            migrationEvidence: {
              ...(primaryRelativePath ? { path: primaryRelativePath } : {}),
              ...(contentHash ? { sha256: contentHash } : {}),
              ...(stats ? { sizeBytes: stats.size } : {}),
            },
          }
        : {}),
      limsProjection: limsProjectionClassification(source),
      ...(sourceType === 'registry_record'
        ? {
            benchlingRegistry: source.metadata.benchlingRegistry,
            ...(source.registryId ? { sourceRegistryId: source.registryId } : {}),
          }
        : {}),
    },
    ...(pageDocument ? { page: nativePage(pageDocument, source) } : {}),
    ...(sourceIdentities.length > 0 ? { sourceIdentities } : {}),
    ...(run.externalZipSource
      ? {
          migrationSource:
            migrationSourceForObject(source, run.id, run.externalZipSource.sourceId) ?? undefined,
        }
      : {}),
  };
}

function providerSourceIdentities(source: SourceObject): NativeWorkspaceManifestSourceIdentity[] {
  const stableObjectId = source.stableId?.trim();
  if (!stableObjectId || !isExactProviderStableId(stableObjectId)) return [];
  const objectClass = providerObjectClassForStableId(stableObjectId);
  if (!objectClass) return [];
  const canonicalUrl = isSafeProviderCanonicalUrl(source.sourceUrl) ? source.sourceUrl : undefined;
  return [
    {
      provider: 'benchling',
      stableObjectId,
      objectClass,
      bindingKind: 'observed',
      ...(canonicalUrl ? { canonicalUrl } : {}),
    },
  ];
}

function limsProjectionClassification(source: SourceObject): Record<string, unknown> {
  const sourceType = normalizeSourceType(source.sourceType);
  if (sourceType === 'registry_record') return { status: 'materialized', kind: 'record' };
  if (sourceType === 'strain') {
    return { status: 'materialized', kind: 'strain' };
  }
  if (sourceType === 'protein') {
    const content = record(source.content);
    if (content?.kind === 'dna_sequence_needs_sequence') {
      return { status: 'materialized', kind: 'dna_sequence_needs_sequence' };
    }
    const materializationFacts = nativeSequenceMaterializationFacts(content);
    return (materializationFacts?.kind === 'protein' && materializationFacts.length > 0) ||
      (typeof content?.aminoAcids === 'string' && content.aminoAcids.length > 0)
      ? { status: 'materialized', kind: 'protein' }
      : {
          status: 'not_inferred',
          reason: 'The source protein has no usable amino-acid sequence.',
        };
  }
  if (sourceType === 'dna_sequence' || sourceType === 'rna_sequence') {
    const content = record(source.content);
    const materializationFacts = nativeSequenceMaterializationFacts(content);
    if (
      !(
        (materializationFacts?.kind === 'nucleotide' && materializationFacts.length > 0) ||
        (typeof content?.bases === 'string' && content.bases.length > 0)
      )
    ) {
      return {
        status: 'not_inferred',
        reason: `The source ${sourceType === 'dna_sequence' ? 'DNA' : 'RNA'} molecule has no usable nucleotide sequence.`,
      };
    }
    return {
      status: 'materialized',
      kind: sourceType,
      reason: 'Registered as a generic molecule without inferring a specialized biological role.',
    };
  }
  return {
    status: 'not_applicable',
    reason: 'This native object type has no LIMS record lifecycle.',
  };
}

function nativePage(document: NotebookPackageDocument, source: SourceObject) {
  const createdAt = source.createdAt
    ? requiredIsoTimestamp(source.createdAt, 'Notebook creation time')
    : 0;
  const updatedAt = requiredIsoTimestamp(document.updatedAt, 'Notebook update time');
  return {
    title: document.title,
    content: document.content,
    createdAt,
    updatedAt,
  };
}

function nativeEntityType(sourceType: string): NativeWorkspaceEntityInput['type'] {
  if (sourceType === 'dna_sequence' || sourceType === 'rna_sequence') return 'sequence';
  if (sourceType === 'protein') return 'protein';
  if (sourceType === 'strain') return 'sample';
  if (sourceType === 'registry_record') return 'record';
  if (sourceType === 'notebook' || sourceType === 'notebook_entry') return 'notebook';
  if (sourceType === 'protocol' || sourceType === 'protocol_template') return 'protocol';
  if (['protocol_execution', 'protocol_run', 'execution'].includes(sourceType)) {
    return 'protocol_run';
  }
  return 'file';
}

function benchlingStrainContent(content: Record<string, unknown>): BenchlingStrainContent {
  if (
    content.kind !== 'benchling_strain' ||
    typeof content.displayName !== 'string' ||
    !Array.isArray(content.fields)
  ) {
    throw new Error('Native strain source content is invalid.');
  }
  const fields = content.fields.map((field, index) => {
    const candidate = record(field);
    if (
      !candidate ||
      typeof candidate.label !== 'string' ||
      typeof candidate.value !== 'string' ||
      candidate.position !== index
    ) {
      throw new Error(`Native strain field ${index + 1} is invalid.`);
    }
    return { label: candidate.label, value: candidate.value, position: index };
  });
  return { ...(content as Omit<BenchlingStrainContent, 'fields'>), fields };
}

function isNeedsSequenceContent(
  content: Record<string, unknown>
): content is Record<string, unknown> & BenchlingNeedsSequenceContent {
  return (
    content.kind === 'dna_sequence_needs_sequence' &&
    content.moleculeType === 'DNA' &&
    content.bases === '' &&
    Array.isArray(content.annotations) &&
    content.annotations.length === 0 &&
    record(content.genbankMetadata) !== null
  );
}

function needsSequenceSourceMetadata(
  source: SourceObject,
  content: BenchlingNeedsSequenceContent
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    origin: {
      type: 'connector',
      connectorType: 'benchling',
      sourceName: 'Benchling GenBank export',
      sourceId: source.stableId,
    },
    values: content.genbankMetadata,
    entries: content.genbankMetadata.sourceFields.map(({ label, value, position }) => ({
      label,
      value,
      position,
    })),
  };
}

function pendingRelationshipTargetName(resolution: RelationshipResolution): string | null {
  const name = resolution.evidence.find(({ kind, value }) => kind === 'name' && value.trim());
  if (name) return name.value.trim();
  const stableId = resolution.evidence.find(
    ({ kind, value }) => kind === 'stable_id' && value.trim()
  );
  if (stableId) return stableId.value.trim();
  return resolution.targetSourceId?.trim() || null;
}

function pendingRelationshipTargetProviderIdentity(resolution: RelationshipResolution): {
  provider: 'benchling';
  stableObjectId: string;
  objectClass: NonNullable<ReturnType<typeof providerObjectClassForStableId>>;
} | null {
  const stableIds = new Set(
    [
      ...resolution.evidence
        .filter(({ kind }) => kind === 'stable_id')
        .map(({ value }) => value.trim()),
      resolution.targetSourceId?.trim() ?? '',
    ].filter(isExactProviderStableId)
  );
  if (stableIds.size !== 1) return null;
  const stableObjectId = [...stableIds][0];
  const objectClass = providerObjectClassForStableId(stableObjectId);
  if (!objectClass) return null;
  return { provider: 'benchling', stableObjectId, objectClass };
}

function pendingRelationshipTargetKind(
  resolution: RelationshipResolution,
  candidates: readonly SourceObject[]
): string | null {
  const candidateKinds = new Set(candidates.flatMap((candidate) => limsKind(candidate)));
  if (candidateKinds.size === 1) return [...candidateKinds][0] ?? null;
  if (candidateKinds.size > 1) return null;
  const providerClasses = new Set(
    resolution.evidence
      .filter(({ kind }) => kind === 'source_type')
      .flatMap(({ value }) => value.split('|').map((entry) => entry.trim()))
  );
  return providerClasses.size === 1 && providerClasses.has('registry_entity') ? 'strain' : null;
}

function limsKind(source: SourceObject): string[] {
  const sourceType = normalizeSourceType(source.sourceType);
  return ['strain', 'dna_sequence', 'rna_sequence', 'protein'].includes(sourceType)
    ? [sourceType]
    : [];
}

function nativeFileKind(sourceType: string, path: string): string {
  if (sourceType === 'dna_sequence' || sourceType === 'rna_sequence') return 'genbank';
  if (sourceType === 'protein') return 'fasta';
  if (sourceType === 'notebook' || sourceType === 'notebook_entry') return 'waypoint-notebook';
  if (sourceType === 'protocol' || sourceType === 'protocol_template') return 'waypoint-protocol';
  if (['protocol_execution', 'protocol_run', 'execution'].includes(sourceType)) {
    return 'waypoint-protocol-run';
  }
  return path.split('.').at(-1)?.toLowerCase() || 'file';
}

const NATIVE_LIMS_RELATIONSHIP_TYPES = new Set([
  'derives_from',
  'has_part',
  'variant_of',
  'encodes',
  'verified_by',
  'carried_by',
  'associated_with',
  'amplifies',
  'assembled_from',
  'references',
  'has_genome',
  'same_as',
  'targets',
  'has_marker',
  'primer_pair',
  'composed_of',
  'located_in',
]);

export function nativeLimsRelationshipType(sourceRelation: string): string {
  const normalized = normalizeSourceType(sourceRelation);
  if (NATIVE_LIMS_RELATIONSHIP_TYPES.has(normalized)) return normalized;
  if (normalized === 'reference' || normalized.startsWith('uses_')) return 'references';
  return 'associated_with';
}

function deduplicateLimsLinks(
  links: NonNullable<NativeWorkspaceMaterializationPlan['limsLinks']>
): NonNullable<NativeWorkspaceMaterializationPlan['limsLinks']> {
  const unique = new Map<string, (typeof links)[number]>();
  for (const link of links) {
    unique.set(`${link.fromEntityRawId}\u0000${link.type}\u0000${link.toEntityRawId}`, link);
  }
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function deduplicateLinks(
  links: NativeWorkspaceMaterializationPlan['links']
): NativeWorkspaceMaterializationPlan['links'] {
  const unique = new Map<string, (typeof links)[number]>();
  for (const link of links) {
    unique.set(`${link.sourceRawId}\u0000${link.relation}\u0000${link.targetRawId}`, link);
  }
  return [...unique.values()].sort((left, right) =>
    `${left.sourceRawId}\u0000${left.relation}\u0000${left.targetRawId}`.localeCompare(
      `${right.sourceRawId}\u0000${right.relation}\u0000${right.targetRawId}`
    )
  );
}

function requiredIsoTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error(`${label} is invalid.`);
  return timestamp;
}

function normalizeSourceType(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, '_');
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
