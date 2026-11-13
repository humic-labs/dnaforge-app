import type { createEntityArtifactOwner } from './entity-artifact-owner';
import type { createCatalogRepository } from '../../db/catalog-repository';
import type { ArtifactHistoryPort } from '../artifact-operation-ports';

import { pathRelativeToBoundary } from '../path-boundary';
import {
  LIMS_GIT_EXPORT_RELATIVE_PATH,
  type LimsApplyImportBatchResult,
  type LimsImportPlan,
  type LimsImportPlanRecord,
} from '../lims';
import { sha256Hex } from '../sha256';

import {
  ENTITY_ARTIFACT_CURRENT_SCHEMA,
  ENTITY_ARTIFACT_SUFFIX,
  entityArtifactSourceMetadata,
  parseEntityArtifact,
  sanitizeEntityArtifactStem,
  serializeEntityArtifact,
  type EntityArtifactRelationshipV1,
  type EntityArtifactV2,
} from '../entity-artifact';
import type {
  ApplyAcceptedLimsImportPlanOperation,
  LimsImportFileProvenance,
} from './ingress-core';
import type { ImportSetMemberV1, ImportSetSourceInput } from './import-set-core';
import type { PersistImportSetOperation } from './import-set-core';
import type { ArtifactIO } from '../artifact-io';
import { classifyLimsEntityFieldIssues, requireSupportedLimsFieldDefinitions } from '../lims';

export interface ImportedEntityArtifactDependencies {
  fs: Pick<ArtifactIO['fs'], 'exists' | 'readTextFile' | 'writeWorkspaceTextFileAtomic'>;
  resolveSchemaSnapshot: ReturnType<
    typeof createEntityArtifactOwner
  >['resolveEntityArtifactSchemaSnapshot'];
  resolveWorkspaceId: ReturnType<typeof createCatalogRepository>['resolveWorkspaceId'];
  withMutation<T>(
    workspaceRoot: string,
    operation: (mutationToken?: string) => Promise<T>
  ): Promise<T>;
  applyPlan: ApplyAcceptedLimsImportPlanOperation;
  persistSet: PersistImportSetOperation;
  isGitRepo: ArtifactHistoryPort['isGitRepo'];
  commitPaths: ArtifactHistoryPort['gitCommitPaths'];
}

export interface ImportedEntityArtifactResult {
  artifactWarnings?: string[];
  applyResult: LimsApplyImportBatchResult;
  artifactPaths: string[];
  artifactAbsolutePaths: string[];
  gitCommitted: boolean;
  importSet: { id: string; manifestRelativePath: string } | null;
  importSetError?: string;
  members: ImportSetMemberV1[];
  partition: ImportedEntityImportPartition;
}

export interface ImportedEntityImportPartition {
  plan: LimsImportPlan;
  members: ImportSetMemberV1[];
}

export class EntityArtifactProjectionError extends Error {
  readonly artifactPaths: string[];
  readonly artifactAbsolutePaths: string[];

  constructor(
    cause: unknown,
    artifacts: { artifactPaths: string[]; artifactAbsolutePaths: string[] }
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`The record files were saved, but Registry projection failed: ${detail}`);
    this.name = 'EntityArtifactProjectionError';
    this.artifactPaths = artifacts.artifactPaths;
    this.artifactAbsolutePaths = artifacts.artifactAbsolutePaths;
  }
}

export class EntityArtifactWriteError extends Error {
  constructor(
    cause: unknown,
    readonly artifactPaths: string[],
    readonly uncertainArtifactPath: string
  ) {
    super(
      `Record file publication failed at ${uncertainArtifactPath}: ${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = 'EntityArtifactWriteError';
  }
}

interface PreparedEntityArtifact {
  record: LimsImportPlanRecord;
  artifact: EntityArtifactV2;
  absolutePath: string;
  relativePath: string;
}

function joinPath(left: string, right: string): string {
  const separator = left.includes('\\') ? '\\' : '/';
  return `${left.replace(/[\\/]+$/, '')}${separator}${right.replace(/^[\\/]+/, '')}`;
}

function recordLookupKeys(record: LimsImportPlanRecord): string[] {
  const normalizedName = record.entityDraft.name.trim().toLowerCase();
  return [`${record.entityDraft.kind}:${normalizedName}`, `*:${normalizedName}`];
}

function relationshipEndpointId(
  directId: string | undefined,
  lookup: { kind?: string; name: string } | undefined,
  selfId: string,
  importedIds: ReadonlyMap<string, string>
): string | null {
  if (directId) return directId;
  if (!lookup) return selfId;
  const normalizedName = lookup.name.trim().toLowerCase();
  return (
    importedIds.get(`${lookup.kind ?? '*'}:${normalizedName}`) ??
    importedIds.get(`*:${normalizedName}`) ??
    null
  );
}

function concreteRelationships(
  record: LimsImportPlanRecord,
  entityId: string,
  importedIds: ReadonlyMap<string, string>
): EntityArtifactRelationshipV1[] {
  const relationships: EntityArtifactRelationshipV1[] = [];
  for (const link of record.proposedLinks) {
    if (link.suggested) continue;
    const fromEntityId = relationshipEndpointId(
      link.fromEntityId,
      link.fromEntityLookup,
      entityId,
      importedIds
    );
    const toEntityId = relationshipEndpointId(
      link.toEntityId,
      link.toEntityLookup,
      entityId,
      importedIds
    );
    if (!fromEntityId || !toEntityId || fromEntityId === toEntityId) continue;
    relationships.push({
      type: link.type,
      fromEntityId,
      toEntityId,
      payload: { ...link.payload },
    });
  }
  return relationships;
}

async function stableEntityId(record: LimsImportPlanRecord, plan: LimsImportPlan): Promise<string> {
  if (record.entityDraft.id) return record.entityDraft.id;

  const identity = JSON.stringify({
    sourceName: plan.sourceName,
    sourceKind: plan.sourceKind,
    sourcePartition: plan.selectedSheet,
    sourceRowId:
      record.externalRowId ?? `name:${record.entityDraft.name.trim().toLocaleLowerCase('en-US')}`,
    kind: record.entityDraft.kind,
  });
  return `entity-${(await sha256Hex(identity)).slice(0, 32)}`;
}

function assertDistinctFallbackIdentities(records: readonly LimsImportPlanRecord[]): void {
  const seen = new Set<string>();
  for (const record of records) {
    if (record.entityDraft.id || record.externalRowId) continue;
    const key = `${record.entityDraft.kind}:${record.entityDraft.name.trim().toLocaleLowerCase('en-US')}`;
    if (seen.has(key)) {
      throw new Error(
        `Multiple imported ${record.entityDraft.kind} records named "${record.entityDraft.name}" ` +
          'need a durable source row identifier before they can be written safely.'
      );
    }
    seen.add(key);
  }
}

function acceptedCreateRecords(plan: LimsImportPlan): LimsImportPlanRecord[] {
  return plan.records.filter(
    (record) =>
      record.accepted &&
      record.action === 'create' &&
      record.duplicateCandidates.length === 0 &&
      record.errors.length === 0
  );
}

async function prepareArtifacts(
  input: {
    plan: LimsImportPlan;
    workspaceRoot: string;
    destinationDir: string;
    fileProvenance?: LimsImportFileProvenance;
  },
  dependencies: ImportedEntityArtifactDependencies
): Promise<PreparedEntityArtifact[]> {
  const records = acceptedCreateRecords(input.plan);
  assertDistinctFallbackIdentities(records);
  const ids = await Promise.all(records.map((record) => stableEntityId(record, input.plan)));
  const importedIds = new Map<string, string>();
  for (let index = 0; index < records.length; index++) {
    for (const key of recordLookupKeys(records[index])) {
      if (importedIds.has(key)) importedIds.delete(key);
      else importedIds.set(key, ids[index]);
    }
  }

  const schemaSnapshots = new Map(
    await Promise.all(
      [...new Set(records.map((row) => row.entityDraft.kind))].map(
        async (kind) => [kind, await dependencies.resolveSchemaSnapshot(kind)] as const
      )
    )
  );
  const prepared: PreparedEntityArtifact[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const id = ids[index];
    const kindDir = sanitizeEntityArtifactStem(String(record.entityDraft.kind).toLowerCase());
    const stem = sanitizeEntityArtifactStem(record.entityDraft.name);
    const relativeFromDestination = `records/${kindDir}/${stem}-${id.slice(-8)}${ENTITY_ARTIFACT_SUFFIX}`;
    const absolutePath = joinPath(input.destinationDir, relativeFromDestination);
    const relativePath = pathRelativeToBoundary(absolutePath, input.workspaceRoot);
    if (!relativePath) throw new Error('Entity artifacts must be saved inside an open project.');
    const sourceValues = input.fileProvenance
      ? { ...record.source, ...input.fileProvenance }
      : { ...record.source };
    const schemaSnapshot = schemaSnapshots.get(record.entityDraft.kind)!;
    const issues = classifyLimsEntityFieldIssues(
      record.entityDraft.kind,
      record.entityDraft.fields,
      requireSupportedLimsFieldDefinitions(schemaSnapshot.fields)
    );
    if (issues.malformed.length) throw new Error(issues.malformed.join('; '));
    if (
      record.entityDraft.schemaRevisionId &&
      record.entityDraft.schemaRevisionId !== schemaSnapshot.schemaRevisionId
    ) {
      throw new Error(
        'Import schema changed after review; review the records again before importing.'
      );
    }
    const baseArtifact: EntityArtifactV2 = {
      schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
      id,
      schemaRevisionId: schemaSnapshot.schemaRevisionId,
      schemaSnapshot,
      archived: false,
      kind: record.entityDraft.kind,
      name: record.entityDraft.name,
      fields: {},
      registrationStatus: record.entityDraft.registrationStatus ?? 'registered',
      domainStatus: record.entityDraft.domainStatus ?? null,
      relationships: concreteRelationships(record, id, importedIds),
      source: {
        recordId: record.id,
        sourceName: input.plan.sourceName,
        sourceKind: input.plan.sourceKind,
        sourceRow: record.sourceRow,
        values: sourceValues,
      },
    };
    baseArtifact.fields = {
      ...record.entityDraft.fields,
      artifact: { schema: ENTITY_ARTIFACT_CURRENT_SCHEMA, relativePath },
      sourceMetadata: entityArtifactSourceMetadata(baseArtifact),
    };
    prepared.push({ record, artifact: baseArtifact, absolutePath, relativePath });
  }
  return prepared;
}

async function writeArtifacts(
  workspaceRoot: string,
  prepared: readonly PreparedEntityArtifact[],
  mutationToken: string | undefined,
  dependencies: ImportedEntityArtifactDependencies
): Promise<string[]> {
  const pendingWrites: Array<{ item: PreparedEntityArtifact; content: string }> = [];
  for (const item of prepared) {
    const content = serializeEntityArtifact(item.artifact);
    if (await dependencies.fs.exists(item.absolutePath)) {
      const existing = parseEntityArtifact(await dependencies.fs.readTextFile(item.absolutePath));
      if (serializeEntityArtifact(existing) !== content) {
        throw new Error(`A different entity artifact already exists at ${item.relativePath}.`);
      }
      continue;
    }
    pendingWrites.push({ item, content });
  }

  const written: string[] = [];
  const warnings: string[] = [];
  for (const { item, content } of pendingWrites) {
    try {
      const receipt = await dependencies.fs.writeWorkspaceTextFileAtomic({
        workspaceRoot,
        path: item.absolutePath,
        content,
        mode: 'create',
        mutationToken,
        artifactNoun: 'registry entity',
      });
      written.push(item.relativePath);
      if (receipt?.cleanupWarning) warnings.push(receipt.cleanupWarning);
    } catch (error) {
      throw new EntityArtifactWriteError(error, written, item.relativePath);
    }
  }
  return warnings;
}

function planWithArtifacts(
  plan: LimsImportPlan,
  prepared: readonly PreparedEntityArtifact[],
  workspaceId: number
): LimsImportPlan {
  const byRecordId = new Map(prepared.map((item) => [item.record.id, item]));
  return {
    ...plan,
    records: plan.records.map((record) => {
      const item = byRecordId.get(record.id);
      if (!item) return record;
      return {
        ...record,
        entityDraft: {
          ...record.entityDraft,
          id: item.artifact.id,
          fields: item.artifact.fields,
          schemaRevisionId: item.artifact.schemaRevisionId,
          schemaSnapshot: item.artifact.schemaSnapshot,
          workspaceId,
        },

        proposedLinks: record.proposedLinks,
        source: item.artifact.source.values,
      };
    }),
  };
}

export async function recordImportedEntityArtifacts(
  input: {
    plan: LimsImportPlan;
    workspaceRoot: string;
    destinationDir: string;
    fileProvenance?: LimsImportFileProvenance;
    source?: ImportSetSourceInput;
    persistImportSet?: boolean;
  },
  dependencies: ImportedEntityArtifactDependencies
): Promise<ImportedEntityArtifactResult> {
  if (
    input.plan.records.some(
      (record) =>
        record.accepted && record.action === 'create' && record.entityDraft.kind === 'protein'
    )
  ) {
    throw new Error('Protein imports must use recordImportedProteins().');
  }
  const prepared = await prepareArtifacts(input, dependencies);
  if (prepared.length === 0) {
    return {
      applyResult: await dependencies.applyPlan(input.plan, {
        fileProvenance: input.fileProvenance,
      }),
      artifactPaths: [],
      artifactAbsolutePaths: [],
      gitCommitted: false,
      importSet: null,
      members: [],
      partition: { plan: input.plan, members: [] },
    };
  }
  const workspaceId = await dependencies.resolveWorkspaceId(input.workspaceRoot);
  if (workspaceId == null) {
    throw new Error('Imported Registry records require a durable project owner.');
  }
  return dependencies.withMutation(input.workspaceRoot, async (mutationToken) => {
    const artifactWarnings = await writeArtifacts(
      input.workspaceRoot,
      prepared,
      mutationToken,
      dependencies
    );
    const artifactPaths = prepared.map((item) => item.relativePath);
    const artifactAbsolutePaths = prepared.map((item) => item.absolutePath);
    let applyResult: LimsApplyImportBatchResult;
    try {
      applyResult = await dependencies.applyPlan(
        planWithArtifacts(input.plan, prepared, workspaceId),
        { mutationToken }
      );
    } catch (error) {
      throw new EntityArtifactProjectionError(error, { artifactPaths, artifactAbsolutePaths });
    }
    const members: ImportSetMemberV1[] = await Promise.all(
      prepared.map(async (item) => ({
        sourceRecordId: item.record.id,
        sourceRowId: `rowid-${(await sha256Hex(item.artifact.id)).slice(0, 32)}`,
        ...(typeof item.record.sourceRow === 'number' ? { sourceRow: item.record.sourceRow } : {}),
        ...(item.record.externalRowId ? { externalRowId: item.record.externalRowId } : {}),
        entityId: item.artifact.id,
        entityKind: item.artifact.kind,
        artifactRelativePath: item.relativePath,
      }))
    );
    let importSet: ImportedEntityArtifactResult['importSet'] = null;
    let importSetError: string | undefined;
    let importSetRelativePaths: string[] = [];
    if (members.length > 0 && input.persistImportSet !== false) {
      try {
        const persisted = await dependencies.persistSet({
          partitions: [{ plan: input.plan, members }],
          workspaceRoot: input.workspaceRoot,
          destinationDir: input.destinationDir,
          mutationToken,
          ...(input.source ? { source: input.source } : {}),
        });
        importSet = persisted.importSet;
        importSetRelativePaths = persisted.relativePaths;
      } catch (error) {
        importSetError = error instanceof Error ? error.message : String(error);
      }
    }
    let gitCommitted = false;
    try {
      if (await dependencies.isGitRepo(input.workspaceRoot, mutationToken)) {
        await dependencies.commitPaths(
          input.workspaceRoot,
          `Import ${prepared.length} ${prepared[0].artifact.kind} record${prepared.length === 1 ? '' : 's'}`,
          [
            ...prepared.map((item) => item.relativePath),
            ...importSetRelativePaths,
            LIMS_GIT_EXPORT_RELATIVE_PATH,
          ],
          mutationToken
        );
        gitCommitted = true;
      }
    } catch (error) {
      console.warn('[entity-artifact] Saved and registered, but Git history commit failed:', error);
    }
    return {
      applyResult,
      ...(artifactWarnings.length ? { artifactWarnings } : {}),
      artifactPaths,
      artifactAbsolutePaths,
      gitCommitted,
      importSet,
      ...(importSetError ? { importSetError } : {}),
      members,
      partition: { plan: input.plan, members },
    };
  });
}
