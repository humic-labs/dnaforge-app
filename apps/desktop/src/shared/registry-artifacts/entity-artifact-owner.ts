import { entityRelationshipKey, schemaFieldRelationships } from '../entity-field-relationships';
import { assertLimsTemporalEdits } from '@waypoint/scientific-artifacts/shared/lims-temporal';
import type { ArtifactDatabase } from '../artifact-io';
import type { ArtifactHistoryPort } from '../artifact-operation-ports';
import type { ArtifactIO } from '../artifact-io';
import type {
  BeginWorkflowAction,
  WorkflowOperation,
  WorkflowResultMetadata,
} from '../workflow-operation';
import { pathRelativeToBoundary } from '../path-boundary';
import {
  LIMS_GIT_EXPORT_RELATIVE_PATH,
  classifyLimsEntityFieldIssues,
  requireSupportedLimsFieldDefinitions,
  type LimsFieldDefinition,
} from '../lims';
import {
  ENTITY_ARTIFACT_CURRENT_SCHEMA,
  entityArtifactSchemaSnapshot,
  ENTITY_ARTIFACT_SUFFIX,
  entityArtifactSourceMetadata,
  sanitizeEntityArtifactStem,
  parseEntityArtifact,
  serializeEntityArtifact,
  type EntityArtifactRelationshipV1,
  type EntityArtifactSourceV1,
  type EntityArtifactV2,
} from '../entity-artifact';
import type { RegistryChangeEmitter } from '../registry-change';
import { scientificIdentityPath } from '@waypoint/scientific-objects';
import type { ScientificAcceptedDocumentRevision } from '@waypoint/domain-services';
import {
  NativeArtifactPublicationPendingError,
  type ScientificArtifactPort,
  type ScientificArtifactPublicationInput,
} from '../scientific-artifact-port';
import type {
  WorkspaceMutationRunner,
  ArtifactRegistryOperations,
} from '../artifact-operation-ports';
export interface RecordEntityArtifactInput {
  id?: string;

  artifactStem?: string;
  kind: string;
  schemaId?: string;
  expectedSchemaRevisionId?: string;
  name: string;
  fields: Record<string, unknown>;
  workspaceRoot: string;
  destinationDir: string;
  source?: EntityArtifactSourceV1;
  relationships?: EntityArtifactRelationshipV1[];
  registrationStatus?: EntityArtifactV2['registrationStatus'];
  domainStatus?: string | null;

  deferCommit?: boolean;

  resolvedSchemaFields?: readonly LimsFieldDefinition[];
  mutationToken?: string;
}
export interface RecordedEntityArtifact {
  artifact: EntityArtifactV2;
  artifactPath: string;
  relativePath: string;
  gitCommitted: boolean;
  created: boolean;
  acceptedRevision?: ScientificAcceptedDocumentRevision;
}
export class EntityArtifactAcceptedSavePendingError extends Error {
  constructor(
    readonly artifactPath: string,
    readonly artifact: EntityArtifactV2,
    readonly acceptedRevision: ScientificAcceptedDocumentRevision,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : 'Strain accepted; publication remains pending.');
    this.name = 'EntityArtifactAcceptedSavePendingError';
  }
}
export class EntityArtifactCreationProjectionError extends Error {
  readonly artifactPath: string;
  readonly relativePath: string;
  readonly artifact: EntityArtifactV2;
  readonly created: boolean;

  constructor(
    artifactPath: string,
    relativePath: string,
    artifact: EntityArtifactV2,
    created: boolean,
    cause: unknown
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`The record file was saved, but Registry projection failed: ${detail}`);
    this.name = 'EntityArtifactCreationProjectionError';
    this.artifactPath = artifactPath;
    this.relativePath = relativePath;
    this.artifact = artifact;
    this.created = created;
  }
}
export interface createEntityArtifactOwnerDependencies {
  scientific?: ScientificArtifactPort;
  withRendererWorkspaceMutation?: WorkspaceMutationRunner;
  queryLimsEntities?: ArtifactRegistryOperations['queryLimsEntities'];
  beginWorkflowAction: BeginWorkflowAction;
  io(): {
    db: Pick<ArtifactDatabase, 'select'>;
    fs: Pick<ArtifactIO['fs'], 'exists' | 'readTextFile' | 'writeWorkspaceTextFileAtomic'>;
  };
  gitCommitPaths: ArtifactHistoryPort['gitCommitPaths'];
  gitStatus: ArtifactHistoryPort['gitStatus'];
  isGitRepo: ArtifactHistoryPort['isGitRepo'];
  emitLimsRegistrationChanged: RegistryChangeEmitter;
  getLimsSchemas: ArtifactIO['lims']['listSchemas'];
  projectArtifact(
    artifact: EntityArtifactV2,
    content: string,
    artifactPath: string,
    input: RecordEntityArtifactInput
  ): Promise<void>;
}
export function createEntityArtifactOwner(dependencies: createEntityArtifactOwnerDependencies) {
  const {
    beginWorkflowAction,
    gitCommitPaths,
    gitStatus,
    isGitRepo,
    emitLimsRegistrationChanged,
    getLimsSchemas,
  } = dependencies;
  const platform = dependencies.io;
  const withRendererWorkspaceMutation: WorkspaceMutationRunner =
    dependencies.withRendererWorkspaceMutation ??
    (async (_root, operation, token) => operation(token));
  const readScientificNamespace = (root: string) =>
    dependencies.scientific?.namespace(root) ?? Promise.resolve(null);
  const readScientificText = (path: string, root: string) =>
    dependencies.scientific?.readText(path, root) ??
    dependencies
      .io()
      .fs.readTextFile(path)
      .then((content) => ({ content, acceptedRevision: null }));
  const publishNativeArtifact = (input: ScientificArtifactPublicationInput) => {
    if (!dependencies.scientific)
      throw new Error('Scientific publication authority is unavailable.');
    return dependencies.scientific.publish(input);
  };
  const scientificRelationshipGitPaths = (root: string, dirty: ReadonlyMap<string, unknown>) =>
    dependencies.scientific?.relationshipGitPaths(root, dirty) ?? Promise.resolve([]);
  const queryLimsEntities = (
    input: Parameters<ArtifactRegistryOperations['queryLimsEntities']>[0]
  ) => {
    if (!dependencies.queryLimsEntities)
      throw new Error('Accepted Registry projection authority is unavailable.');
    return dependencies.queryLimsEntities(input);
  };
  function joinPath(left: string, right: string): string {
    const separator = left.includes('\\') ? '\\' : '/';
    return `${left.replace(/[\\/]+$/, '')}${separator}${right.replace(/^[\\/]+/, '')}`;
  }
  function presentFields(fields: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(fields).filter(
        ([, value]) => value !== undefined && value !== null && value !== ''
      )
    );
  }
  async function resolveEntityArtifactSchemaFields(
    kind: string
  ): Promise<readonly LimsFieldDefinition[]> {
    return requireSupportedLimsFieldDefinitions(
      (await resolveEntityArtifactSchemaSnapshot(kind)).fields
    );
  }
  async function resolveEntityArtifactSchemaSnapshot(
    kind: string,
    selection?: { schemaId: string; expectedRevisionId: string }
  ) {
    if (selection && (!selection.schemaId || !selection.expectedRevisionId)) {
      throw new Error('Select a schema and its current version before creating the record.');
    }
    const schemas = await getLimsSchemas();
    const matches = schemas.filter(
      (schema) =>
        schema.entityKind === kind && (!selection || schema.schemaId === selection.schemaId)
    );
    if (matches.length !== 1)
      throw new Error(`No unique Registry schema is provisioned for ${kind}.`);
    if (selection && matches[0].currentRevisionId !== selection.expectedRevisionId) {
      throw new Error('This schema changed. Reopen the creation form before saving.');
    }
    const snapshot = entityArtifactSchemaSnapshot(matches[0]);
    return { ...snapshot, fields: requireSupportedLimsFieldDefinitions(snapshot.fields) };
  }
  const BATCH_OWNED_OPERATION: Pick<WorkflowOperation, 'complete' | 'fail'> = {
    complete: () => false,
    fail: () => false,
  };
  async function recordEntityArtifact(
    supplied: RecordEntityArtifactInput
  ): Promise<RecordedEntityArtifact> {
    const input = structuredClone(supplied);
    const name = input.name.trim();
    if (!name) throw new Error('Entity name is required.');
    const fields = presentFields(input.fields);
    const operation: Pick<WorkflowOperation, 'complete' | 'fail'> = input.deferCommit
      ? BATCH_OWNED_OPERATION
      : beginWorkflowAction({
          workflow: 'registry',
          action: 'create',
          workflowOrigin: 'direct',
        });
    const receipt: WorkflowResultMetadata = {
      recordWriteStatus: 'unconfirmed',
      recordProjectionStatus: 'not_attempted',
      recordHistoryStatus: 'not_attempted',
    };
    try {
      const result = await withRendererWorkspaceMutation(
        input.workspaceRoot,
        async (mutationToken) => {
          const namespace =
            input.kind === 'strain' ? await readScientificNamespace(input.workspaceRoot) : null;
          const id = input.id?.trim() || crypto.randomUUID();
          const stem = input.artifactStem
            ? sanitizeEntityArtifactStem(input.artifactStem)
            : `${sanitizeEntityArtifactStem(name)}-${id.slice(-8)}`;
          const artifactPath = joinPath(input.destinationDir, `${stem}${ENTITY_ARTIFACT_SUFFIX}`);
          const relativePath = pathRelativeToBoundary(artifactPath, input.workspaceRoot);
          if (!relativePath)
            throw new Error('Registry records must be saved inside an open project.');

          const exists = await platform().fs.exists(artifactPath);
          const acceptedExisting = namespace?.entries.find(
            (slot) => slot.resourceId === id && !slot.tombstone
          );
          if (namespace && exists && !acceptedExisting)
            throw new Error(
              `A working file already exists at ${relativePath}. Choose a new location or enroll it explicitly.`
            );
          const existingContent = acceptedExisting
            ? (await readScientificText(artifactPath, input.workspaceRoot)).content
            : exists
              ? await platform().fs.readTextFile(artifactPath)
              : null;
          const existing = existingContent === null ? null : parseEntityArtifact(existingContent);
          if (
            existing &&
            (existing.schema !== ENTITY_ARTIFACT_CURRENT_SCHEMA ||
              existing.id !== id ||
              existing.kind !== input.kind)
          ) {
            throw new Error(`A different record file already exists at ${relativePath}.`);
          }
          const schemaSnapshot =
            existing?.schema === ENTITY_ARTIFACT_CURRENT_SCHEMA
              ? existing.schemaSnapshot
              : await resolveEntityArtifactSchemaSnapshot(
                  input.kind,
                  input.schemaId || input.expectedSchemaRevisionId
                    ? {
                        schemaId: input.schemaId ?? '',
                        expectedRevisionId: input.expectedSchemaRevisionId ?? '',
                      }
                    : undefined
                );
          const manualCreation = input.source === undefined || input.source.type === 'manual';
          for (const field of manualCreation ? schemaSnapshot.fields : []) {
            const value = fields[field.key];
            if (
              field.type !== 'record_relationship' ||
              !value ||
              typeof value !== 'object' ||
              !('origin' in value) ||
              value.origin !== 'native'
            )
              continue;
            if (
              !('destinationEntityId' in value) ||
              typeof value.destinationEntityId !== 'string' ||
              value.destinationEntityId === id
            )
              throw new Error(`Choose a valid entity for ${field.label}.`);
            const [target] = await queryLimsEntities({
              id: value.destinationEntityId,
              limit: 1,
            });
            if (!target || target.tombstone || target.archivedAt !== null)
              throw new Error(`The linked entity for ${field.label} is unavailable or archived.`);
            if (target.workspaceId !== null) {
              const [owner] = await platform().db.select<
                Array<{ archived_at: number | null; trashed_at: number | null }>
              >('SELECT archived_at,trashed_at FROM workspaces WHERE id=?', [target.workspaceId]);
              if (!owner || owner.archived_at !== null || owner.trashed_at !== null)
                throw new Error(
                  `The linked entity for ${field.label} belongs to an unavailable project.`
                );
            }
            const savedValue = existing?.fields[field.key];
            fields[field.key] =
              savedValue &&
              typeof savedValue === 'object' &&
              'origin' in savedValue &&
              savedValue.origin === 'native' &&
              'destinationEntityId' in savedValue &&
              savedValue.destinationEntityId === target.id
                ? savedValue
                : {
                    origin: 'native',
                    destinationEntityId: target.id,
                    relationType: 'references',
                    label: target.name,
                    resolution: 'exact',
                  };
          }

          if (!input.source)
            assertLimsTemporalEdits(
              fields,
              schemaSnapshot.fields as LimsFieldDefinition[],
              existing?.fields
            );
          const issues = classifyLimsEntityFieldIssues(
            input.kind,
            fields,
            schemaSnapshot.fields as LimsFieldDefinition[]
          );
          if (issues.malformed.length > 0 || issues.incomplete.length > 0) {
            throw new Error([...issues.malformed, ...issues.incomplete].join('; '));
          }

          const artifact: EntityArtifactV2 = {
            schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
            id,
            schemaRevisionId: schemaSnapshot.schemaRevisionId,
            schemaSnapshot,
            archived: false,
            kind: input.kind,
            name,
            fields: {},
            registrationStatus: input.registrationStatus ?? 'registered',
            domainStatus: input.domainStatus ?? null,
            relationships: input.relationships?.map((relationship) => ({ ...relationship })) ?? [],
            source: input.source ?? { type: 'manual', values: {} },
          };
          const fieldRelationships = manualCreation
            ? schemaFieldRelationships(id, schemaSnapshot.fields, fields)
            : [];
          const relationshipKeys = new Set(artifact.relationships.map(entityRelationshipKey));
          artifact.relationships.push(
            ...fieldRelationships.filter(
              (link) => !relationshipKeys.has(entityRelationshipKey(link))
            )
          );

          artifact.fields = {
            ...fields,
            artifact: { schema: ENTITY_ARTIFACT_CURRENT_SCHEMA, relativePath },
            sourceMetadata: entityArtifactSourceMetadata(artifact),
          };
          const content = serializeEntityArtifact(artifact);
          if (namespace) {
            const existing = namespace.entries.find((slot) => slot.resourceId === id);
            const pathOwner = namespace.entries.find(
              (slot) => !slot.tombstone && slot.path === relativePath
            );
            if (
              (existing && (existing.tombstone || existing.path !== relativePath)) ||
              (pathOwner && pathOwner.resourceId !== id)
            )
              throw new Error(
                'The strain identity or path is already accepted. Open it to edit or restore it explicitly.'
              );
            let prior: ScientificAcceptedDocumentRevision | null = null;
            if (existing) {
              const loaded = await readScientificText(artifactPath, input.workspaceRoot);
              if (
                !loaded.acceptedRevision ||
                loaded.acceptedRevision.resourceId !== id ||
                loaded.content !== content
              )
                throw new Error(
                  'A different accepted strain already exists there. Open it to edit.'
                );
              prior = loaded.acceptedRevision;
            } else if (exists)
              throw new Error(
                `A working file already exists at ${relativePath}. Choose a new location or enroll it explicitly.`
              );
            const isGit =
              !input.deferCommit && (await isGitRepo(input.workspaceRoot, mutationToken));
            const dirtyBefore = isGit
              ? await gitStatus(input.workspaceRoot, mutationToken)
              : new Map<string, unknown>();
            let acceptedRevision: ScientificAcceptedDocumentRevision;
            try {
              acceptedRevision = await publishNativeArtifact({
                workspaceRoot: input.workspaceRoot,
                artifactPath,
                resourceId: id,
                ...(prior ? { prior } : { prior: null, expectedHead: namespace.head }),
                representation: { format: 'strain-entity-v1', text: content },
                mutationToken,
              });
            } catch (error) {
              if (error instanceof NativeArtifactPublicationPendingError) {
                receipt.recordWriteStatus = prior ? 'existing' : 'written';
                receipt.affectedCount = prior ? 0 : 1;
                throw new EntityArtifactAcceptedSavePendingError(
                  artifactPath,
                  artifact,
                  error.accepted,
                  error
                );
              }
              throw error;
            }
            receipt.recordWriteStatus = prior ? 'existing' : 'written';
            receipt.affectedCount = prior ? 0 : 1;
            try {
              const projected = (await queryLimsEntities({ id, limit: 1 }))[0];
              if (
                !projected ||
                projected.kind !== 'strain' ||
                projected.name !== name ||
                projected.fields.genotypeCanonical !== fields.genotypeCanonical
              )
                throw new Error('Strain accepted; Registry refresh remains incomplete.');
              receipt.recordProjectionStatus = 'ready';
            } catch (error) {
              receipt.recordProjectionStatus = 'failed';
              throw new EntityArtifactAcceptedSavePendingError(
                artifactPath,
                artifact,
                acceptedRevision,
                error
              );
            }
            let gitCommitted = false;
            receipt.recordHistoryStatus = input.deferCommit ? 'deferred' : 'not_applicable';
            try {
              if (isGit) {
                const dirtyAfter = await gitStatus(input.workspaceRoot, mutationToken);
                const ownedPaths = [
                  relativePath,
                  scientificIdentityPath,
                  ...(await scientificRelationshipGitPaths(input.workspaceRoot, dirtyAfter)),
                  ...[...dirtyAfter.keys()].filter(
                    (path) => path.startsWith('.waypoint/lims/') && !dirtyBefore.has(path)
                  ),
                ];
                const paths = ownedPaths.filter((path) => dirtyAfter.has(path));
                if (paths.length > 0) {
                  await gitCommitPaths(
                    input.workspaceRoot,
                    `Add strain ${name}`,
                    paths,
                    mutationToken
                  );
                  receipt.recordHistoryStatus = 'committed';
                } else {
                  receipt.recordHistoryStatus = 'unchanged';
                }
                gitCommitted = true;
              }
            } catch (error) {
              receipt.recordHistoryStatus = 'failed';
              throw new EntityArtifactAcceptedSavePendingError(
                artifactPath,
                artifact,
                acceptedRevision,
                new Error(
                  `Strain accepted; Git history remains pending: ${error instanceof Error ? error.message : String(error)}`
                )
              );
            }
            emitLimsRegistrationChanged({ filePath: artifactPath, entityId: id });
            return {
              artifact,
              artifactPath,
              relativePath,
              gitCommitted,
              created: !existing,
              acceptedRevision,
            };
          }
          if (exists) {
            const existingContent = await platform().fs.readTextFile(artifactPath);
            if (existingContent !== content) {
              throw new Error(`A different record file already exists at ${relativePath}.`);
            }
            receipt.recordWriteStatus = 'existing';
          } else {
            await platform().fs.writeWorkspaceTextFileAtomic({
              workspaceRoot: input.workspaceRoot,
              path: artifactPath,
              content,
              mode: 'create',
              artifactNoun: 'registry record',
              mutationToken,
            });
            receipt.recordWriteStatus = 'written';
          }
          receipt.affectedCount = exists ? 0 : 1;

          try {
            await dependencies.projectArtifact(artifact, content, artifactPath, {
              ...input,
              mutationToken,
            });
            receipt.recordProjectionStatus = 'ready';
          } catch (error) {
            receipt.recordProjectionStatus = 'failed';
            throw new EntityArtifactCreationProjectionError(
              artifactPath,
              relativePath,
              artifact,
              !exists,
              error
            );
          }

          let gitCommitted = false;
          receipt.recordHistoryStatus = input.deferCommit ? 'deferred' : 'not_applicable';
          try {
            if (!input.deferCommit && (await isGitRepo(input.workspaceRoot, mutationToken))) {
              const dirtyPaths = [
                ...(await gitStatus(input.workspaceRoot, mutationToken)).keys(),
              ].filter(
                (path) =>
                  path === relativePath || path.startsWith(`${LIMS_GIT_EXPORT_RELATIVE_PATH}/`)
              );
              if (dirtyPaths.length > 0) {
                await gitCommitPaths(
                  input.workspaceRoot,
                  `Add ${input.kind} ${name}`,
                  dirtyPaths,
                  mutationToken
                );
                gitCommitted = true;
                receipt.recordHistoryStatus = 'committed';
              } else {
                receipt.recordHistoryStatus = 'unchanged';
              }
            }
          } catch (error) {
            receipt.recordHistoryStatus = 'failed';
            console.warn(
              '[entity-artifact] Saved and registered, but Git history commit failed:',
              error
            );
          }

          emitLimsRegistrationChanged({ filePath: artifactPath, entityId: id });
          return { artifact, artifactPath, relativePath, gitCommitted, created: !exists };
        },
        input.mutationToken
      );
      operation.complete({
        ...receipt,
        status: result.created ? 'created' : 'success',
        outcomeKind: result.created ? 'record_created' : 'record_existing',
      });
      return result;
    } catch (error) {
      operation.fail(
        error instanceof EntityArtifactCreationProjectionError ||
          receipt.recordProjectionStatus === 'failed'
          ? 'projection'
          : 'unknown',
        receipt
      );
      throw error;
    }
  }
  return {
    resolveEntityArtifactSchemaFields,
    resolveEntityArtifactSchemaSnapshot,
    recordEntityArtifact,
  };
}
