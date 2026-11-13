import { userMessagePayload, userMessagePayloadFromError } from '@waypoint/user-messages';
import { executeImportReviewAgent } from '../shared/import-review-agent';
import type { ImportReviewAgentInput } from '../shared/import-review-command';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import type Database from 'better-sqlite3';
import { ImportReviewOwner } from '../shared/registry-artifacts/import-review-owner';
import {
  applyAcceptedLimsImportPlan,
  applyImportPlanColumnMappings,
  createLimsImportPlan,
  resolveImportPlanDuplicate,
  resolveImportPlanLink,
  setImportPlanRecordsAccepted,
  type LimsImportPlannerDependencies,
} from '../shared/registry-artifacts/ingress-core';
import {
  EntityArtifactProjectionError,
  EntityArtifactWriteError,
  recordImportedEntityArtifacts,
  type ImportedEntityArtifactDependencies,
} from '../shared/registry-artifacts/import-entity-artifact-core';
import {
  persistImportSet,
  type ImportSetPersistenceDependencies,
} from '../shared/registry-artifacts/import-set-core';
import { entityArtifactSchemaSnapshot } from '../shared/entity-artifact';
import { requireSupportedLimsFieldDefinitions } from '../shared/lims';
import type {
  ImportReviewChanged,
  ImportReviewDocument,
  ImportReviewRequest,
  ImportReviewSource,
  ImportReviewReceipt,
} from '../shared/import-review';
import { applyLimsImportBatchInDb, queryLimsEntitiesInDb } from './lims';
import { listLimsEntitySchemasInDb } from './lims-engine-core';
import { materializeLimsGlobalRegistryExportInDb } from './lims-git-export';
import {
  canonicalWorkspacePath,
  writeWorkspaceBinaryFileAtomicInMain,
  writeWorkspaceTextFileAtomicInMain,
} from './primer-artifact-files';
import { syncDirectory } from './fs-durability';
import { writeTextFileAtomicInMain } from './text-file-atomic';
import {
  findKnownWorkspaceRoot,
  withKnownWorkspacePathMutation,
  withKnownWorkspacePathsMutationAcrossWorkspaces,
  workspaceMutationRootIdentity,
} from './workspace-sync-mutation-lease';
import {
  assertCommittedDatabaseReadAllowed,
  withWorkspaceSyncDatabaseFence,
} from './workspace-sync-database-fence';
import { assertKnownWorkspaceContentWritable } from './workspace-content-write-access';
import { commitPathsIfDirty, isGitRepo } from './workspace-git';
import { importContentIntoWorkspaceRoot } from './workspace-git/import';
import { registerImportedSequenceFromContent } from './lims-register-import';
import { pathRelativeToBoundary } from '../shared/path-boundary';
import {
  applyNativeSpecializedImport,
  nativeImportNeedsExternalTm,
  type NativeImportReviewAgentExecution,
} from './native-import-writers';
import {
  createNativeAgentGrantAuthorizer,
  type NativeAgentAuthority,
} from './agent-grant-authority';
import { hasRequiredCapabilities } from '../shared/capability-policy';
import { nativeDocumentFetch } from './sidecar-session-runtime';
import { NativeDocumentCommandError } from '../shared/native-document-error';
import { createNativeCatalogRepository } from './native-catalog-repository';
import {
  MANAGED_SEQUENCE_DOCUMENT_FIELD,
  readManagedSequenceDocumentRef,
} from '../shared/managed-sequence-document';
import { SEQUENCE_PACKAGE_FILE_KIND } from '../db/sequence-package-contract';
import { updateLimsEntityInDb } from './lims';

class NativeImportApplyError extends Error {
  constructor(
    cause: unknown,
    readonly receipt: ImportReviewReceipt
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

function failedImportReceipt(error: unknown): ImportReviewReceipt {
  if (error instanceof NativeImportApplyError) return error.receipt;
  if (error instanceof EntityArtifactProjectionError)
    return {
      changed: true,
      artifactPaths: error.artifactPaths,
      imported: 0,
      skipped: 0,
      failed: 1,
      userMessagePayload:
        userMessagePayloadFromError(error) ??
        userMessagePayload('registry.receipt.savedIncomplete'),
      partialEffects: [error.message],
    };
  if (error instanceof EntityArtifactWriteError)
    return {
      changed: error.artifactPaths.length ? true : 'unknown',
      artifactPaths: error.artifactPaths,
      imported: 0,
      skipped: 0,
      failed: 1,
      userMessagePayload:
        userMessagePayloadFromError(error) ?? userMessagePayload('registry.receipt.unconfirmed'),
      partialEffects: [
        error.message,
        `Inspect publication at ${error.uncertainArtifactPath} before continuing.`,
      ],
    };
  return {
    changed: 'unknown',
    artifactPaths: [],
    imported: 0,
    skipped: 0,
    failed: 1,
    userMessagePayload:
      userMessagePayloadFromError(error) ?? userMessagePayload('registry.receipt.unconfirmed'),
    partialEffects: [error instanceof Error ? error.message : String(error)],
  };
}

export function createNativeImportReviews(options: {
  db(): Database.Database;
  workspaceRoots(): readonly string[];
  profileDirectory(): string;
  captureWorkspace?(root: string): () => void;
  authorizeAgent?(agent: NativeAgentAuthority, required: readonly string[]): Promise<void>;
}) {
  const authorizeAgent =
    options.authorizeAgent ??
    createNativeAgentGrantAuthorizer(nativeDocumentFetch, 'IMPORT_REVIEW');
  const refusal = (error: unknown) =>
    new NativeDocumentCommandError(
      error instanceof Error
        ? (error.message.match(/^([A-Z][A-Z_]+):/)?.[1] ?? 'IMPORT_REVIEW_CAPABILITY_DENIED')
        : 'IMPORT_REVIEW_CAPABILITY_DENIED',
      error instanceof Error ? error.message : String(error),
      false
    );
  const listeners = new Set<(event: ImportReviewChanged) => void>();
  const workspace = (root: string) => {
    const matches = (
      options
        .db()
        .prepare(
          'SELECT id, path, access_mode FROM workspaces WHERE archived_at IS NULL AND trashed_at IS NULL AND path IS NOT NULL'
        )
        .all() as Array<{ id: number; path: string; access_mode: string }>
    ).filter(
      (entry) => workspaceMutationRootIdentity(entry.path) === workspaceMutationRootIdentity(root)
    );
    return matches.length === 1 ? matches[0] : undefined;
  };
  const reviewPath = (id: string) => {
    if (!/^import-review:[a-f0-9-]{36}$/.test(id)) throw new Error('INVALID_IMPORT_REVIEW_ID');
    return join(options.profileDirectory(), 'import-reviews', `${id.slice(14)}.json`);
  };
  const assertAuthority = async (root: string, mutating: boolean) => {
    if (!root) return;
    assertCommittedDatabaseReadAllowed(options.db());
    if (
      !options
        .workspaceRoots()
        .some(
          (entry) => workspaceMutationRootIdentity(entry) === workspaceMutationRootIdentity(root)
        ) ||
      findKnownWorkspaceRoot(options.db(), root) !== workspaceMutationRootIdentity(root) ||
      !workspace(root)
    )
      throw new Error('IMPORT_PROJECT_UNAVAILABLE: Choose a current admitted project.');
    if (mutating) assertKnownWorkspaceContentWritable(options.db(), root);
  };
  const validateDestination = async (root: string, destination: string) => {
    if (!root && !destination) return;
    if (!root || !destination)
      throw new Error('IMPORT_DESTINATION_REQUIRED: Choose a project and folder together.');
    const canonical = await canonicalWorkspacePath({
      workspaceRoot: root,
      path: join(destination, '.import-review-boundary-check'),
      allowMissing: true,
      artifactNoun: 'import',
    });
    const parts = relative(canonical.root, dirname(canonical.candidate)).split(/[\\/]/);
    if (
      findKnownWorkspaceRoot(options.db(), dirname(canonical.candidate)) !==
      workspaceMutationRootIdentity(root)
    )
      throw new Error(
        'IMPORT_DESTINATION_PROJECT_MISMATCH: The destination belongs to another project.'
      );
    if (parts.some((part) => ['.git', '.forge', '.dnaforge', '.waypoint'].includes(part)))
      throw new Error(
        'IMPORT_DESTINATION_INTERNAL: Project metadata cannot be an import destination.'
      );
    if (!(await stat(dirname(canonical.candidate))).isDirectory())
      throw new Error('IMPORT_DESTINATION_NOT_DIRECTORY: Choose an existing project folder.');
  };
  const sourceBytes = async (source: ImportReviewSource) => {
    if (source.sourcePath) {
      const root = findKnownWorkspaceRoot(options.db(), source.sourcePath);
      if (!root)
        throw new Error('IMPORT_SOURCE_UNAVAILABLE: Choose a source inside an admitted project.');
      await assertAuthority(root, false);
      const canonical = await canonicalWorkspacePath({
        workspaceRoot: workspace(root)!.path,
        path: source.sourcePath,
        artifactNoun: 'import source',
      });
      if (
        relative(canonical.root, canonical.candidate)
          .split(/[\\/]/)
          .some((part) => ['.git', '.forge', '.dnaforge', '.waypoint'].includes(part))
      )
        throw new Error(
          'IMPORT_SOURCE_INTERNAL: Project metadata is not an ordinary import source.'
        );
      const file = await open(canonical.candidate, 'r');
      try {
        const before = await file.stat();
        if (!before.isFile()) throw new Error('IMPORT_SOURCE_UNAVAILABLE: Choose a physical file.');
        const bytes = await file.readFile();
        const after = await file.stat();
        if (
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          bytes.length !== before.size
        )
          throw new Error('IMPORT_SOURCE_CHANGED: The source changed during reading.');
        return bytes;
      } finally {
        await file.close();
      }
    }
    if (source.arrayBuffer instanceof ArrayBuffer) return Buffer.from(source.arrayBuffer);
    if (typeof source.text === 'string') return Buffer.from(source.text, 'utf8');
    throw new Error(
      'IMPORT_SOURCE_REQUIRED: Supply source text, bytes, or a current project file.'
    );
  };
  const planner: LimsImportPlannerDependencies = {
    async queryEntities(input) {
      assertCommittedDatabaseReadAllowed(options.db());
      const admitted = new Set(options.workspaceRoots().map((root) => workspace(root)?.id));
      return queryLimsEntitiesInDb(options.db(), input).filter(
        (entity) => entity.workspaceId == null || admitted.has(entity.workspaceId)
      );
    },
    async applyBatch(input) {
      const db = options.db();
      if (db.inTransaction)
        throw new Error(
          'IMPORT_DATABASE_BUSY: Import apply needs its own committed database boundary.'
        );
      const admittedRoots = options.workspaceRoots().map(workspaceMutationRootIdentity);
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const record of input.records.filter(
          (entry) => entry.accepted && !entry.duplicateOf && !entry.errors?.length
        )) {
          const artifact = record.entity.fields?.artifact as { relativePath?: unknown } | undefined;
          if (!record.entity.id || typeof artifact?.relativePath !== 'string') continue;
          const project = db
            .prepare(
              'SELECT path FROM workspaces WHERE id=? AND archived_at IS NULL AND trashed_at IS NULL'
            )
            .get(record.entity.workspaceId) as { path: string } | undefined;
          if (!project || !admittedRoots.includes(workspaceMutationRootIdentity(project.path)))
            throw new Error(
              'IMPORT_PROJECT_UNAVAILABLE: The Registry projection project is no longer admitted.'
            );
          const repository = createNativeCatalogRepository(db, {
            assertCurrent: () => {
              if (!workspace(project.path)) throw new Error('IMPORT_PROJECT_UNAVAILABLE');
            },
            withMutation: async (_root, operation) => operation(),
          });
          const path = join(project.path, artifact.relativePath);
          const catalog = await repository.registerCatalogEntity({
            id: record.entity.id,
            type: 'file',
            name: record.entity.name,
            locator: `file://${path}`,
            storageType: 'file',
            workspaceRoot: project.path,
          });
          if (catalog.id !== record.entity.id || catalog.workspace_id !== record.entity.workspaceId)
            throw new Error(
              'Import artifact catalog identity differs from its reviewed Registry record.'
            );
          await repository.bindCatalogEntityToFile({
            entityId: record.entity.id,
            path,
            workspaceRoot: project.path,
            fileKind: 'waypoint-entity',
          });
        }
        const result = applyLimsImportBatchInDb(db, input);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const fs: ImportSetPersistenceDependencies['fs'] = {
    exists: async (path) => {
      try {
        const file = await open(path, 'r');
        await file.close();
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
    readFile: async (path) => new Uint8Array(await readFile(path)),
    readTextFile: (path) => readFile(path, 'utf8'),
    sha256File: async (path) =>
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    writeWorkspaceBinaryFileAtomic: (input) => writeWorkspaceBinaryFileAtomicInMain(input),
    writeWorkspaceTextFileAtomic: (input) => writeWorkspaceTextFileAtomicInMain(input),
  };
  const persistence: ImportSetPersistenceDependencies = {
    fs,
    isGitRepo: async (root) => isGitRepo(root),
    commitPaths: async (root, message, paths) => {
      if (!root) throw new Error('An admitted project is required to commit imported files.');
      await commitPathsIfDirty(root, message, { paths });
    },
  };
  const artifacts: ImportedEntityArtifactDependencies = {
    ...persistence,
    resolveSchemaSnapshot: async (kind) => {
      const matches = listLimsEntitySchemasInDb(options.db()).filter(
        (schema) => schema.entityKind === kind
      );
      if (matches.length !== 1)
        throw new Error(`No unique Registry schema is provisioned for ${kind}.`);
      const snapshot = entityArtifactSchemaSnapshot(matches[0]);
      return { ...snapshot, fields: requireSupportedLimsFieldDefinitions(snapshot.fields) };
    },
    resolveWorkspaceId: async (root) => (root ? (workspace(root)?.id ?? null) : null),
    withMutation: (root, operation) =>
      withKnownWorkspacePathMutation(options.db(), [root], async () => {
        await assertAuthority(root, true);
        return withWorkspaceSyncDatabaseFence(options.db(), () => operation());
      }),
    applyPlan: (plan, applyOptions) => applyAcceptedLimsImportPlan(plan, applyOptions, planner),
    persistSet: (input) => persistImportSet({ ...input, mergePartitions: true }, persistence),
  };
  const owner = new ImportReviewOwner<NativeImportReviewAgentExecution>({
    newId: () => `import-review:${randomUUID()}`,
    assertAuthority,
    validateDestination,
    fingerprint: async (source) =>
      `sha256:${createHash('sha256')
        .update(await sourceBytes(source))
        .digest('hex')}`,
    async read(id) {
      try {
        const stored = JSON.parse(await readFile(reviewPath(id), 'utf8'));
        if (
          stored.version !== 1 ||
          stored.document?.id !== id ||
          typeof stored.document?.revision !== 'string' ||
          !Array.isArray(stored.document?.plan?.records)
        )
          throw new Error('INVALID_IMPORT_REVIEW_RECORD');
        const document: ImportReviewDocument = stored.document;
        if (stored.bytesBase64)
          document.source.arrayBuffer = Uint8Array.from(
            Buffer.from(stored.bytesBase64, 'base64')
          ).buffer;
        return document;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async write(document) {
      const path = reviewPath(document.id);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const source = { ...document.source, arrayBuffer: undefined };
      await writeTextFileAtomicInMain({
        path,
        content: JSON.stringify({
          version: 1,
          document: { ...document, source },
          ...(document.source.arrayBuffer
            ? { bytesBase64: Buffer.from(document.source.arrayBuffer).toString('base64') }
            : {}),
        }),
      });
      await syncDirectory(dirname(path));
      const event: ImportReviewChanged = {
        id: document.id,
        revision: document.revision,
        workspaceRoot: document.workspaceRoot,
        phase: document.phase,
      };
      for (const listener of listeners) listener(event);
    },
    async build(source) {
      const kind = source.forcedKind ?? source.defaultKind;
      const schema = kind ? await artifacts.resolveSchemaSnapshot(kind) : null;
      const importFamily =
        schema?.baseKind === 'primer'
          ? schema.fields.some((field) => field.key === 'sequence' && field.type === 'rna_sequence')
            ? 'rna_oligo'
            : 'oligo'
          : schema?.baseKind === 'protein'
            ? 'protein'
            : kind && ['oligo', 'rna_oligo', 'protein', 'sequence'].includes(kind)
              ? kind
              : undefined;
      return createLimsImportPlan(
        {
          ...source,
          schemaFields: schema ? requireSupportedLimsFieldDefinitions(schema.fields) : undefined,
          schemaRevisionId: schema?.schemaRevisionId,
          importFamily,
        },
        planner
      );
    },
    map: (plan, mappings) =>
      applyImportPlanColumnMappings(plan, mappings, 'user_overridden', planner),
    accept: setImportPlanRecordsAccepted,
    resolveLink: (plan, command) => resolveImportPlanLink(plan, command, planner),
    resolveDuplicate: (plan, command) => resolveImportPlanDuplicate(plan, command, planner),
    async preflightApply(document, agent) {
      if (agent) {
        try {
          agent.assertCurrent();
          const required = ['read-workspace', 'write-workspace'];
          if (
            await nativeImportNeedsExternalTm(document, {
              db: options.db(),
              persistence,
              assertCurrent: agent.assertCurrent,
              agentAuthority: agent,
            })
          )
            required.push('external-compute:tm');
          if (!hasRequiredCapabilities(agent.capabilities, required))
            throw new Error(
              'IMPORT_REVIEW_CAPABILITY_DENIED: external-compute:tm is required before sending accepted primer sequence externally.'
            );
          await agent.authorize(required);
          agent.assertCurrent();
        } catch (error) {
          throw refusal(error);
        }
      }
      const families = new Set(
        document.plan.records
          .filter((record) => record.accepted && record.action === 'create')
          .map((record) => {
            const family = document.plan.importFamily ?? record.entityDraft.kind;
            return ['oligo', 'rna_oligo', 'protein', 'sequence'].includes(family)
              ? family
              : 'record';
          })
      );
      if (families.size > 1 && [...families].some((family) => family !== 'record'))
        throw new Error(
          'IMPORT_MIXED_SCHEMA_REVIEW_REQUIRED: Accept one scientific import family per review.'
        );
      if (
        document.plan.schemaRevisionId &&
        document.plan.forcedKind &&
        (await artifacts.resolveSchemaSnapshot(document.plan.forcedKind)).schemaRevisionId !==
          document.plan.schemaRevisionId
      )
        throw new Error('IMPORT_SCHEMA_CHANGED: Review the changed schema before importing.');
    },
    async apply(document, agent) {
      await validateDestination(document.workspaceRoot, document.destinationDir);
      const capture = options.captureWorkspace?.(document.workspaceRoot);
      const assertCurrent = () => {
        agent?.assertCurrent();
        capture?.();
        if (
          !options
            .workspaceRoots()
            .some(
              (root) =>
                workspaceMutationRootIdentity(root) ===
                workspaceMutationRootIdentity(document.workspaceRoot)
            ) ||
          workspace(document.workspaceRoot)?.access_mode !== 'writable' ||
          findKnownWorkspaceRoot(options.db(), document.destinationDir) !==
            workspaceMutationRootIdentity(document.workspaceRoot)
        )
          throw new Error(
            'IMPORT_PROJECT_UNAVAILABLE: The owning project changed before publication.'
          );
      };
      assertCurrent();
      const sequence = document.plan.records.filter(
        (record) =>
          record.accepted && record.action === 'create' && record.entityDraft.kind === 'sequence'
      );
      if (sequence.length > 0) {
        if (
          sequence.length !== 1 ||
          document.plan.records.length !== 1 ||
          typeof document.source.text !== 'string'
        )
          throw new Error(
            'IMPORT_SEQUENCE_SELECTION_UNAVAILABLE: This source needs an exact supported single-sequence review.'
          );
        const result = await withKnownWorkspacePathMutation(
          options.db(),
          [document.workspaceRoot],
          () =>
            registerImportedSequenceFromContent(
              {
                content: document.source.text!,
                fileName: document.source.fileName,
                targetRoot: document.destinationDir,
                kind: 'sequence',
                expectedSourceSha256: document.sourceFingerprint.slice(7),
                batchId: document.id,
              },
              {
                db: options.db(),
                managedRootDir: join(options.profileDirectory(), 'managed-workspaces'),
              }
            )
        );
        assertCurrent();
        if (result.registered) {
          await withKnownWorkspacePathMutation(options.db(), [document.workspaceRoot], async () => {
            await assertAuthority(document.workspaceRoot, true);
            await withWorkspaceSyncDatabaseFence(options.db(), async () => {
              const repository = createNativeCatalogRepository(options.db(), {
                assertCurrent,
                withMutation: async (_root, operation) => operation(),
              });
              const workspaceId = workspace(document.workspaceRoot)!.id;
              for (const id of result.entityIds) {
                const entity = queryLimsEntitiesInDb(options.db(), { id, limit: 1 })[0];
                const managed =
                  entity &&
                  readManagedSequenceDocumentRef(entity.fields[MANAGED_SEQUENCE_DOCUMENT_FIELD]);
                if (!entity || !managed || managed.packageId !== id)
                  throw new Error('Imported sequence lacks an exact managed package identity.');
                const catalog = await repository.registerCatalogEntity({
                  id,
                  type: 'sequence',
                  name: entity.name,
                  locator: `waypoint://sequence/${id}`,
                  storageType: 'file',
                  workspaceRoot: document.workspaceRoot,
                });
                if (catalog.id !== id)
                  throw new Error('Imported sequence catalog identity changed.');
                await repository.bindCatalogEntityToFile({
                  entityId: id,
                  path: managed.packageRoot,
                  fileKind: SEQUENCE_PACKAGE_FILE_KIND,
                  workspaceRoot: document.workspaceRoot,
                });
                if (entity.workspaceId !== workspaceId)
                  updateLimsEntityInDb(options.db(), {
                    id,
                    workspaceId,
                    actor: 'native-import-projection',
                  });
              }
            });
          });
          try {
            materializeLimsGlobalRegistryExportInDb(
              options.db(),
              join(options.profileDirectory(), 'lims-registry')
            );
          } catch (error) {
            console.warn(
              `[LIMS] global registry export after sequence import failed: ${String(error)}`
            );
          }
        }
        return {
          changed: true,
          artifactPaths: (result.packageProductPaths ?? [result.destPath]).map(
            (path) => pathRelativeToBoundary(path, document.workspaceRoot) ?? path
          ),
          imported: result.entityIds.length,
          skipped: result.copySkipped ? 1 : 0,
          failed: result.registered ? 0 : 1,
          ...(result.batchId ? { batchId: result.batchId } : {}),
          gitCommitted: result.committed,
          ...(result.reason ? { partialEffects: [result.reason] } : {}),
          ...(result.userMessagePayload || !result.registered
            ? {
                userMessagePayload:
                  result.userMessagePayload ??
                  userMessagePayload('registry.receipt.registrationFailed'),
              }
            : {}),
        };
      }
      const specialized = document.plan.records.find(
        (record) =>
          record.accepted &&
          record.action === 'create' &&
          ['protein', 'oligo', 'rna_oligo'].includes(
            document.plan.importFamily ?? record.entityDraft.kind
          )
      );
      const placeSource = async () => {
        const sourceName = basename(document.source.fileName.replace(/\\/g, '/'));
        const existingSourcePath = join(document.destinationDir, sourceName);
        let identicalSource = false;
        try {
          const checked = await canonicalWorkspacePath({
            workspaceRoot: document.workspaceRoot,
            path: existingSourcePath,
            allowMissing: true,
            artifactNoun: 'import source',
          });
          identicalSource =
            `sha256:${createHash('sha256')
              .update(await readFile(checked.candidate))
              .digest('hex')}` === document.sourceFingerprint;
        } catch {
          identicalSource = false;
        }
        return identicalSource
          ? { destPath: existingSourcePath, relPath: sourceName, committed: false, skipped: true }
          : await withKnownWorkspacePathMutation(options.db(), [document.workspaceRoot], () =>
              importContentIntoWorkspaceRoot(
                {
                  targetRoot: document.destinationDir,
                  fileName: document.source.fileName,
                  ...(document.source.arrayBuffer
                    ? { contentBytes: document.source.arrayBuffer }
                    : { content: document.source.text }),
                },
                {
                  db: options.db(),
                  managedRootDir: join(options.profileDirectory(), 'managed-workspaces'),
                }
              )
            );
      };
      const copy = specialized ? undefined : await placeSource();
      const sourcePath =
        copy && (pathRelativeToBoundary(copy.destPath, document.workspaceRoot) ?? copy.relPath);
      const sourceSaved = copy !== undefined && !copy.skipped;
      try {
        assertCurrent();
        const guardedFs = {
          ...fs,
          writeWorkspaceTextFileAtomic: (
            input: Parameters<typeof fs.writeWorkspaceTextFileAtomic>[0]
          ) => writeWorkspaceTextFileAtomicInMain(input, { beforePublish: assertCurrent }),
          writeWorkspaceBinaryFileAtomic: (
            input: Parameters<typeof fs.writeWorkspaceBinaryFileAtomic>[0]
          ) => writeWorkspaceBinaryFileAtomicInMain(input, { beforePublish: assertCurrent }),
        };
        if (document.plan.schemaRevisionId && document.plan.forcedKind) {
          const schema = await artifacts.resolveSchemaSnapshot(document.plan.forcedKind);
          if (schema.schemaRevisionId !== document.plan.schemaRevisionId)
            throw new Error('IMPORT_SCHEMA_CHANGED: Review the changed schema before importing.');
        }
        if (specialized) {
          return await withKnownWorkspacePathsMutationAcrossWorkspaces(
            options.db(),
            [document.workspaceRoot],
            async (leases) => {
              await assertAuthority(document.workspaceRoot, true);
              return withWorkspaceSyncDatabaseFence(options.db(), (release) =>
                applyNativeSpecializedImport(document, {
                  db: options.db(),
                  persistence: { ...persistence, fs: guardedFs },
                  assertCurrent,
                  publicationAuthority: {
                    mutationLease: leases.get(
                      workspaceMutationRootIdentity(document.workspaceRoot)
                    )!,
                    databaseFence: release,
                  },
                  agentAuthority: agent,
                })
              );
            }
          );
        }
        const result = await recordImportedEntityArtifacts(
          {
            plan: document.plan,
            workspaceRoot: document.workspaceRoot,
            destinationDir: document.destinationDir,
            ...(sourcePath
              ? {
                  fileProvenance: {
                    managedRelPath: sourcePath,
                    workspaceRootPath: document.workspaceRoot,
                  },
                }
              : {}),
            source: { text: document.source.text, arrayBuffer: document.source.arrayBuffer },
          },
          {
            ...artifacts,
            fs: guardedFs,
            persistSet: (input) =>
              persistImportSet(
                { ...input, mergePartitions: true },
                { ...persistence, fs: guardedFs }
              ),
          }
        );
        return {
          changed: result.artifactPaths.length > 0,
          artifactPaths: result.artifactPaths,
          imported: result.applyResult.insertedEntities,
          skipped: result.applyResult.skipped,
          failed: (result.importSetError ? 1 : 0) + (result.artifactWarnings?.length ?? 0),
          batchId: result.applyResult.batchId,
          insertedLinks: result.applyResult.insertedLinks,
          gitCommitted: result.gitCommitted,
          importSet: result.importSet,
          members: result.members,
          ...(sourcePath ? { sourcePath } : {}),
          partialEffects: [
            ...(result.importSetError ? [result.importSetError] : []),
            ...(result.artifactWarnings ?? []),
          ],
        };
      } catch (error) {
        const receipt = failedImportReceipt(error);
        throw new NativeImportApplyError(error, {
          ...receipt,
          changed: sourceSaved ? true : receipt.changed,
          ...(sourcePath ? { sourcePath } : {}),
          partialEffects: [
            ...(sourceSaved ? [`Source file saved at ${copy.relPath}.`] : []),
            ...(receipt.partialEffects ?? []),
          ],
        });
      }
    },
    failureReceipt: failedImportReceipt,
  });
  const service = {
    async executeAgent(
      input: ImportReviewAgentInput,
      agent: NativeAgentAuthority,
      assertCurrent: () => void = () => {}
    ) {
      if (!agent?.identityId?.trim() || !Array.isArray(agent.capabilities))
        throw refusal(
          new Error(
            'IMPORT_REVIEW_AGENT_AUTHORITY_REQUIRED: Use the authenticated native agent command route.'
          )
        );
      const trusted = { identityId: agent.identityId, capabilities: [...agent.capabilities] };
      const authority: NativeImportReviewAgentExecution = {
        ...trusted,
        assertCurrent,
        authorize: (required) => authorizeAgent(trusted, required),
      };
      const required =
        input.operation.kind === 'execute' && input.operation.command.kind === 'inspect'
          ? ['read-workspace']
          : ['read-workspace', 'write-workspace'];
      try {
        assertCurrent();
        if (!hasRequiredCapabilities(trusted.capabilities, required))
          throw new Error(
            'IMPORT_REVIEW_CAPABILITY_DENIED: This agent does not hold the required workspace capabilities.'
          );
        await authority.authorize(required);
        assertCurrent();
      } catch (error) {
        throw refusal(error);
      }
      return executeImportReviewAgent(input, {
        projects: () =>
          options.workspaceRoots().flatMap((path) => {
            const row = workspace(path);
            if (!row) return [];
            const named = options
              .db()
              .prepare('SELECT name FROM workspaces WHERE id=?')
              .get(row.id) as { name: string };
            return [{ path, name: named.name, pinned: row.access_mode !== 'writable' }];
          }),
        call: (request) => service.call(request, authority),
      });
    },
    async call(request: ImportReviewRequest, authority?: NativeImportReviewAgentExecution) {
      if (request.kind === 'execute') return owner.execute(request, authority);
      if (
        request.kind !== 'prepare' ||
        typeof request.source?.fileName !== 'string' ||
        !request.source.fileName.trim()
      )
        throw new Error('INVALID_IMPORT_REVIEW_REQUEST');
      const bytes = await sourceBytes(request.source);
      const binary = /\.(?:xlsx|xls|xlsm)$/i.test(request.source.fileName);
      const source: ImportReviewSource = {
        ...request.source,
        schemaFields: undefined,
        schemaRevisionId: undefined,
        ...(binary
          ? { arrayBuffer: Uint8Array.from(bytes).buffer, text: undefined }
          : { text: bytes.toString('utf8'), arrayBuffer: undefined }),
      };
      return owner.prepare({ ...request, source });
    },
    snapshot: (id: string) => owner.snapshot(id),
    subscribe(listener: (event: ImportReviewChanged) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return service;
}

export type NativeImportReviews = ReturnType<typeof createNativeImportReviews>;
