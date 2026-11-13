import { assertCanonicalSequenceSourceInDb } from './sequence-index-command';
import { createPrimerRecoveryServices } from '../shared/primer-artifacts/primer-recovery-owner';
import {
  readPrimerArtifactRevisionStateInMain,
  publishPrimerArtifactRevision,
  resumePrimerArtifactPublication,
} from './primer-artifact-mutations';
import { getActiveStoredSession } from './auth/session-store';
import { getLimsRegistryPreviewInDb, archiveLimsEntityInDb } from './lims';
import { createNativeScientificArtifactPort } from './native-scientific-artifact-port';
import { primerSchemaSnapshot } from '../shared/primer-artifacts/primer-entity-schema';
import { z } from 'zod';
import { createSequenceIdentityRepository } from '../db/sequence-identity-repository';
import { createDnaSequenceOwner } from '../shared/registry-artifacts/dna-sequence-owner';
import { inferCatalogFileKind } from '../shared/catalog-file-kind';
import { createNativeSequenceDocumentResolver } from './native-sequence-document-resolver';
import { nativeFilesystemStat } from './native-catalog-repository';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { CatalogDatabase } from '../db/catalog-repository';
import {
  createNativeCatalogRepository,
  createNativeCatalogDatabase,
} from './native-catalog-repository';
import {
  createPrimerArtifactOwner,
  type PrimerArtifactDependencies,
} from '../shared/primer-artifacts/primer-artifact-owner';
import { createPrimerRecorder } from '../shared/primer-artifacts/record-primers-owner';
import { createPrimerImportWriter } from '../shared/registry-artifacts/import-primer-owner';
import { createProteinImportWriter } from '../shared/registry-artifacts/import-protein-owner';
import { createProteinArtifactOwner } from '../shared/protein-artifacts/protein-artifact-owner';
import { createEntityArtifactOwner } from '../shared/registry-artifacts/entity-artifact-owner';
import { buildInlineDnaSequenceRef } from '../shared/registry-artifacts/dna-sequence-value';
import {
  createTmCalculator,
  LOCAL_TM_CALCULATOR,
} from '../shared/primer-thermodynamics/tm-service';
import type { PrimerTmCalculationService } from '../shared/primer-tm-contract';
import type { ImportReviewDocument, ImportReviewReceipt } from '../shared/import-review';
import type { WorkflowOperation } from '../shared/workflow-operation';
import {
  persistImportSet,
  type ImportSetPersistenceDependencies,
} from '../shared/registry-artifacts/import-set-core';

import {
  allocatePrimerCatalogNumberInDb,
  replacePrimerLegacyProjectionInDb,
} from './primer-projection';
import {
  queryLimsEntitiesInDb,
  registerLimsEntityInDb,
  updateLimsEntityInDb,
  restoreLimsEntityInDb,
  repairLimsEntityProjectionFromAuditInDb,
} from './lims';
import { listLimsEntitySchemasInDb } from './lims-engine-core';
import { canonicalWorkspacePath } from './primer-artifact-files';
import { managedGitStatus } from './workspace-git/native';
import { nativeDocumentFetch } from './sidecar-session-runtime';
import type { NativeAgentAuthority } from './agent-grant-authority';
import { hasRequiredCapabilities } from '../shared/capability-policy';
import { pathIsAtOrUnder } from '../shared/path-boundary';
import type { WorkspacePathValidationInput } from '../shared/workspace-file-atomic';

async function canonicalNativeArtifactPath(input: WorkspacePathValidationInput) {
  const root = await realpath(input.workspaceRoot);
  return canonicalWorkspacePath({
    ...input,
    workspaceRoot: pathIsAtOrUnder(input.path, root) ? root : input.workspaceRoot,
  });
}

export async function applyNativeSpecializedImport(
  document: ImportReviewDocument,
  options: {
    db: Database.Database;
    persistence: ImportSetPersistenceDependencies;
    assertCurrent(): void;
    publicationAuthority?: { mutationLease: () => void; databaseFence: () => void };
    agentAuthority?: NativeImportReviewAgentExecution;
  }
): Promise<ImportReviewReceipt> {
  const { db, persistence, assertCurrent } = options;
  const root = document.workspaceRoot;
  const { repository, query, getSchemas, history, workflow, withMutation, select } =
    createNativeWriterContext(root, document.id, options);
  const entityOwner = createEntityArtifactOwner({
    scientific: createNativeScientificArtifactPort({
      db,
      workspaceRoot: root,
      assertCurrent,
      files: persistence.fs,
      publicationAuthority: options.publicationAuthority,
    }),
    withRendererWorkspaceMutation: withMutation,
    queryLimsEntities: query,
    io: () => ({ fs: persistence.fs, db: { select } }),
    ...history,
    beginWorkflowAction: workflow,
    emitLimsRegistrationChanged: () => {},
    getLimsSchemas: getSchemas,
    async projectArtifact(artifact, _content, artifactPath, input) {
      assertCurrent();
      const workspaceId = await repository.resolveWorkspaceId(root);
      if (workspaceId === null) throw new Error('The import project has no durable identity.');
      const existing = queryLimsEntitiesInDb(db, {
        id: artifact.id,
        includeArchived: true,
        limit: 1,
      })[0];
      if (existing) {
        if (
          existing.tombstone ||
          existing.kind !== artifact.kind ||
          existing.name !== artifact.name ||
          !isDeepStrictEqual(existing.fields, artifact.fields)
        )
          throw new Error('An existing Registry identity differs from the reviewed protein.');
      } else {
        registerLimsEntityInDb(db, {
          id: artifact.id,
          kind: artifact.kind,
          name: artifact.name,
          fields: artifact.fields,
          schemaRevisionId: artifact.schemaRevisionId,
          schemaSnapshot: artifact.schemaSnapshot,
          registrationStatus: artifact.registrationStatus,
          domainStatus: artifact.domainStatus,
          workspaceId,
          actor: 'local-user',
        });
      }
      const catalog = await repository.registerCatalogEntity({
        id: artifact.id,
        type: 'file',
        name: artifact.name,
        locator: `file://${artifactPath}`,
        storageType: 'file',
        workspaceRoot: input.workspaceRoot,
      });
      if (catalog.id !== artifact.id || catalog.workspace_id !== workspaceId)
        throw new Error('Registry record file is bound to another catalog identity.');
      await repository.bindCatalogEntityToFile({
        entityId: artifact.id,
        path: artifactPath,
        fileKind: 'waypoint-entity',
        workspaceRoot: root,
      });
    },
  });
  const source = { text: document.source.text, arrayBuffer: document.source.arrayBuffer };
  const protein = document.plan.records.some(
    (record) =>
      record.accepted &&
      record.action === 'create' &&
      (record.entityDraft.kind === 'protein' || document.plan.importFamily === 'protein')
  );
  if (protein) {
    const proteinOwner = createProteinArtifactOwner({
      recordEntityArtifact: entityOwner.recordEntityArtifact,
      queryLimsEntities: query,
    });
    const writer = createProteinImportWriter({
      recordProtein: proteinOwner.recordProtein,
      gitCommitPaths: persistence.commitPaths,
      isGitRepo: persistence.isGitRepo,
      persistImportSet: (input) =>
        persistImportSet({ ...input, mergePartitions: true }, persistence),
      resolveEntityArtifactSchemaFields: entityOwner.resolveEntityArtifactSchemaFields,
      beginWorkflowAction: workflow,
    });
    const result = await writer.recordImportedProteins(document.plan, {
      workspaceRoot: root,
      destinationDir: document.destinationDir,
      source,
    });
    return {
      changed: result.added > 0 || result.reconciliationRequired.length > 0,
      artifactPaths: [
        ...result.artifactRelativePaths,
        ...result.reconciliationRequired.map((entry) => entry.artifactRelativePath),
      ],
      imported: result.added,
      skipped: result.skipped,
      failed:
        result.failed + result.reconciliationRequired.length + (result.importSetError ? 1 : 0),
      members: result.members,
      gitCommitted: result.gitCommitted,
      importSet: result.importSet,
      partialEffects: [
        ...result.failures.map((entry) => `${entry.name}: ${entry.message}`),
        ...result.reconciliationRequired.map((entry) => entry.message),
        ...(result.importSetError ? [result.importSetError] : []),
      ],
    };
  }
  const { writer } = createNativePrimerImportWriter(document, options);
  const result = await writer.recordImportedPrimers(document.plan, {
    workspaceRoot: root,
    destinationDir: document.destinationDir,
    source,
  });
  return {
    changed: result.added > 0 || result.artifactRelativePaths.length > 0,
    artifactPaths: result.artifactRelativePaths,
    imported: result.added,
    skipped: result.skipped,
    failed: result.failed + (result.importSetError ? 1 : 0),
    members: result.members,
    importSet: result.importSet,
    partialEffects: [
      ...result.failures.map((entry) => `${entry.name}: ${entry.message}`),
      ...(result.importSetError ? [result.importSetError] : []),
    ],
  };
}

export function createNativePrimerImportWriter(
  document: ImportReviewDocument,
  options: NativeWriterOptions
) {
  const root = document.workspaceRoot;
  const { getSchemas, withMutation, persistence } = createNativeWriterContext(
    root,
    document.id,
    options
  );
  const { owner: primerOwner, tm } = createNativePrimerArtifactWriter({
    ...options,
    workspaceRoot: root,
    operationId: document.id,
    primerTmSettings: document.source.primerTmSettings,
  });
  const recorder = createPrimerRecorder({
    primerServices: {
      persistence: {
        writeAndProjectArtifact: primerOwner.writeAndProjectPrimerArtifact,
        saveArtifact: primerOwner.savePrimerArtifact,
      },
    },
    withRendererWorkspaceMutation: withMutation,
  });
  const writer = createPrimerImportWriter({
    resolveEntitySchema: async (kind) => {
      const schemas = (await getSchemas()).filter((schema) => schema.entityKind === kind);
      if (schemas.length !== 1)
        throw new Error(`No unique Registry schema is provisioned for ${kind}.`);
      return primerSchemaSnapshot(schemas[0]);
    },
    commitPrimerBatchHistory: primerOwner.commitPrimerBatchHistory,
    currentDirtyLimsPaths: primerOwner.currentDirtyLimsPaths,
    recordPrimers: recorder.recordPrimers,
    primerServices: { persistence: { readArtifactAtPath: primerOwner.readPrimerArtifactAtPath } },
    persistImportSet: (input) => persistImportSet({ ...input, mergePartitions: true }, persistence),
  });
  return { writer, tm };
}
export async function nativeImportNeedsExternalTm(
  document: ImportReviewDocument,
  options: NativeWriterOptions
): Promise<boolean> {
  const { writer, tm } = createNativePrimerImportWriter(document, options);
  const primers = await writer.plannedPrimersFromImport(document.plan);
  return (
    primers.some((primer) => (primer.oligo?.orderType ?? 'dna') === 'dna') &&
    tm.createCalculator().resolution.model.kind === 'neb'
  );
}
export interface NativeImportReviewAgentExecution extends NativeAgentAuthority {
  assertCurrent(): void;
  authorize(required: readonly string[]): Promise<void>;
}
interface NativeWriterOptions {
  db: Database.Database;
  persistence: ImportSetPersistenceDependencies;
  assertCurrent(): void;
  publicationAuthority?: { mutationLease: () => void; databaseFence: () => void };
  agentAuthority?: NativeImportReviewAgentExecution;
}
function createNativeWriterContext(
  workspaceRoot: string,
  operationId: string,
  options: NativeWriterOptions
) {
  const { db, persistence, assertCurrent } = options;
  const root = workspaceRoot;
  const token = randomUUID();
  const withMutation = async <T>(
    workspaceRoot: string | null | undefined,
    operation: (mutationToken?: string) => Promise<T>
  ): Promise<T> => {
    if (workspaceRoot !== root)
      throw new Error('Import writer tried to change a different project.');
    assertCurrent();
    return operation(token);
  };
  const select: CatalogDatabase['select'] = async <T>(
    sql: string,
    params: readonly unknown[] = []
  ) => db.prepare(sql).all(...params) as T;
  const repository = createNativeCatalogRepository(db, { assertCurrent, withMutation });
  const query = async (input: Parameters<typeof queryLimsEntitiesInDb>[1]) =>
    queryLimsEntitiesInDb(db, input);
  const getSchemas = async () => listLimsEntitySchemasInDb(db);
  const history = {
    gitCommitPaths: persistence.commitPaths,
    isGitRepo: persistence.isGitRepo,
    gitStatus: async (workspaceRoot: string) =>
      new Map(
        (await managedGitStatus(workspaceRoot)).map((entry) => [entry.path, 'modified' as const])
      ),
  };
  const workflow = (): WorkflowOperation => ({
    actionId: operationId,
    consumed: false,
    complete: () => true,
    fail: () => true,
    cancel: () => true,
  });

  return {
    db,
    persistence,
    assertCurrent,
    root,
    select,
    repository,
    query,
    getSchemas,
    history,
    workflow,
    withMutation,
  };
}

export function createNativePrimerArtifactWriter(
  options: NativeWriterOptions & {
    workspaceRoot: string;
    operationId?: string;
    primerTmSettings?: ImportReviewDocument['source']['primerTmSettings'];
    workspaceRoots?(): readonly string[];
  }
) {
  const { db, persistence, assertCurrent, root, select, repository, query, history, withMutation } =
    createNativeWriterContext(options.workspaceRoot, options.operationId ?? randomUUID(), options);
  const database = {
    select,
    execute: async (sql: string, params: import('../shared/sqlite-ipc').SqliteIpcValue[] = []) => {
      assertCurrent();
      const result = db.prepare(sql).run(...params);
      return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
    },
  };
  const identities = createSequenceIdentityRepository(
    createNativeCatalogDatabase(db, { assertCurrent })
  );
  const sequences = createDnaSequenceOwner({
    io: () => ({ fs: { ...persistence.fs, stat: nativeFilesystemStat } }),
    assertCanonicalSequenceSource: async (documentId, filePath) => {
      assertCurrent();
      assertCanonicalSequenceSourceInDb(db, { documentId, filePath });
    },
    ensureSequenceIdentity: identities.ensureSequenceIdentity,
    getCatalogEntityForFilePath: repository.getCatalogEntityForFilePath,
    inferCatalogFileKind,
    registerWorkspaceFile: repository.registerWorkspaceFile,
  });
  const resolveDocument = createNativeSequenceDocumentResolver({
    db: () => db,
    workspaceRoots: () => options.workspaceRoots?.() ?? [root],
  });
  const resolveSequenceDocumentById: PrimerArtifactDependencies['resolveSequenceDocumentById'] =
    async (id) => {
      const resolved = await resolveDocument({
        operationId: options.operationId ?? 'native-primer-binding',
        targetDocumentId: id,
      });
      assertCurrent();
      return {
        ref: { kind: 'catalog-sequence', entityId: id },
        documentId: id,
        sourcePath: resolved.sourcePath,
      };
    };
  const buildFileDnaSequenceRef: PrimerArtifactDependencies['buildFileDnaSequenceRef'] = async (
    path,
    target = {}
  ) => {
    if (!target.documentId)
      throw new Error('A native primer binding requires a stable target document ID.');
    const resolved = await resolveSequenceDocumentById(target.documentId, [root]);
    const requested = await canonicalNativeArtifactPath({
      workspaceRoot: root,
      path,
      artifactNoun: 'primer target',
    });
    if (requested.candidate !== resolved.sourcePath)
      throw new Error('Primer target path differs from its current native document.');
    const snapshot = await sequences.buildFileDnaSequenceRef(resolved.sourcePath, {
      workspaceRoot: root,
      documentId: target.documentId,
    });
    assertCurrent();
    return snapshot;
  };
  const createCalculator: PrimerTmCalculationService['createCalculator'] = (context = {}) => {
    let authorizationError: unknown;
    const calculator = createTmCalculator({
      ...options.primerTmSettings,
      override: context.override,
      reaction: { polymerase: context.polymerase ?? null },
      online: context.online,
      onNebError: (error) => {
        if (!authorizationError) context.onProviderError?.(error);
      },
      nebFetch: async ({ seq, prodcode, conc_nM, signal }) => {
        try {
          assertCurrent();
          if (options.agentAuthority) {
            if (
              !hasRequiredCapabilities(options.agentAuthority.capabilities, ['external-compute:tm'])
            )
              throw new Error(
                'IMPORT_REVIEW_CAPABILITY_DENIED: external-compute:tm is required before sending primer sequence externally.'
              );
            await options.agentAuthority.authorize([
              'read-workspace',
              'write-workspace',
              'external-compute:tm',
            ]);
            options.agentAuthority.assertCurrent();
          }
          assertCurrent();
        } catch (error) {
          authorizationError = error;
          throw error;
        }
        const response = await nativeDocumentFetch('/external/neb/tm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            seq1: seq,
            prodcode,
            conc_nm: conc_nM,
            granted_capabilities: options.agentAuthority?.capabilities ??
              context.grantedCapabilities ?? ['external-compute:tm'],
          }),
          signal,
        });
        if (!response.ok) throw new Error(`NEB Tm request failed (${response.status}).`);
        const parsed = z
          .object({
            p1: z.object({ tm: z.number().finite() }),
            ta: z.unknown().optional(),
            api_version: z.unknown().optional(),
          })
          .safeParse(await response.json());
        if (!parsed.success) throw new Error('NEB Tm response lacks a finite primary result.');
        const value = parsed.data;
        return {
          tm: value.p1.tm,
          ta: typeof value.ta === 'number' && Number.isFinite(value.ta) ? value.ta : undefined,
          nebApiVersion: typeof value.api_version === 'string' ? value.api_version : '',
          fetchedAt: new Date().toISOString(),
        };
      },
    });
    return {
      ...calculator,
      compute: async (...args: Parameters<typeof calculator.compute>) => {
        const result = await calculator.compute(...args);
        if (authorizationError) throw authorizationError;
        return result;
      },
    };
  };
  const tm: PrimerTmCalculationService = {
    createCalculator,
    estimate: (sequence, context) => createCalculator(context).estimateWithProvenance(sequence),
    estimateLegacyLocal: (sequence) => LOCAL_TM_CALCULATOR.estimate(sequence),
    calculate: async (sequence, context = {}) => {
      const calculator = createCalculator(context);
      const result = await calculator.compute(sequence, { signal: context.signal });
      return {
        model: calculator.resolution.model,
        source: calculator.resolution.source,
        reason: calculator.resolution.reason,
        valueC: result.tm,
        status: result.verified ? 'verified' : result.pendingNebVerification ? 'fallback' : 'local',
        provider: result.provenance,
      };
    },
  };
  const publicationContext = {
    db,
    runDatabase: <T>(operation: () => T): T => {
      assertCurrent();
      return operation();
    },
    getActiveAccountId: async () => (await getActiveStoredSession())?.accountId ?? null,
  };
  const assertPrimerOwner = async (id: string) => {
    assertCurrent();
    const entity = queryLimsEntitiesInDb(db, { id, limit: 1 })[0];
    const workspaceId = await repository.resolveWorkspaceId(root);
    assertCurrent();
    if (entity?.workspaceId != null && entity.workspaceId !== workspaceId)
      throw new Error('Primer publication belongs to another project.');
  };
  const nativeIO: PrimerArtifactDependencies['io'] = () => ({
    fs: {
      ...persistence.fs,
      stat: nativeFilesystemStat,
      readDir: async (path) =>
        (await readdir(path, { withFileTypes: true })).map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
        })),
      validateWorkspacePath: async (input) => {
        try {
          await canonicalNativeArtifactPath(input);
          return true;
        } catch {
          return false;
        }
      },
    },
    db: {
      select,
      execute: async (sql, params = []) => {
        assertCurrent();
        const result = db.prepare(sql).run(...params);
        return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
      },
      replacePrimerProjection: async (input) => {
        assertCurrent();
        replacePrimerLegacyProjectionInDb(db, input);
      },
    },
    lims: {
      readPrimerArtifactRevisionState: async (input) => {
        await assertPrimerOwner(input.entityId);
        return readPrimerArtifactRevisionStateInMain({
          ...publicationContext,
          entityId: input.entityId,
        });
      },
      revisePrimerArtifact: async ({ mutationToken: _token, ...request }) => {
        await assertPrimerOwner(request.entityId);
        return publishPrimerArtifactRevision({ ...publicationContext, request });
      },
      resumePrimerArtifactPublication: async (request) => {
        await assertPrimerOwner(request.entityId);
        return resumePrimerArtifactPublication({
          ...publicationContext,
          entityId: request.entityId,
          operationId: request.operationId,
        });
      },
      repairEntityProjectionFromAudit: async (id) =>
        repairLimsEntityProjectionFromAuditInDb(db, id),
    },
  });
  const recovery = createPrimerRecoveryServices({
    io: () => ({
      ...nativeIO(),
      workspace: {
        getOriginalDefaultProject: async () => {
          throw new Error('Original-project discovery is outside this scoped import command.');
        },
      },
    }),
    setSetting: async (key, value) => {
      assertCurrent();
      if (!key.startsWith('primer_recovery_')) throw new Error('Unexpected recovery setting.');
      db.prepare(
        'INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at'
      ).run(key, value, Date.now());
    },
    withRendererWorkspaceMutation: withMutation,
    getLimsRegistryPreview: async (input) => {
      assertCurrent();
      if (!input) throw new Error('A Registry preview requires an entity identity.');
      return getLimsRegistryPreviewInDb(db, input);
    },
    buildFileDnaSequenceRef,
    generateCatalogNumber: async (id) => allocatePrimerCatalogNumberInDb(db, id),
  });
  const primerOwner = createPrimerArtifactOwner({
    recovery,
    archiveLimsEntity: async (input) => {
      assertCurrent();
      return archiveLimsEntityInDb(db, input);
    },
    scientific: createNativeScientificArtifactPort({
      db,
      workspaceRoot: root,
      assertCurrent,
      files: persistence.fs,
      publicationAuthority: options.publicationAuthority,
    }),
    io: nativeIO,
    ...history,
    ...repository,
    buildFileDnaSequenceRef,
    buildInlineDnaSequenceRef,
    queryLimsEntities: query,
    registerLimsEntity: async (input) => registerLimsEntityInDb(db, input),
    restoreLimsEntity: async (input) => restoreLimsEntityInDb(db, input),
    updateLimsEntity: async (input) => updateLimsEntityInDb(db, input),
    generateCatalogNumber: async (id) => allocatePrimerCatalogNumberInDb(db, id),
    cooperateWithRendererInteraction: async () => {},
    primerTmCalculationService: tm,
    resolveSequenceDocumentById,
    withRendererWorkspaceMutation: withMutation,
  });

  const recoverSelectedLegacyPrimers = (
    selection: readonly { id: string; sourceFingerprint: string }[]
  ) =>
    recovery.recoverPrimerRecordsInWorkspace(
      root,
      {
        read: recovery.readPrimerRecoveryDocument,
        project: primerOwner.projectPrimerArtifact,
        commit: primerOwner.commitPrimerBatchHistory,
        dirtyPaths: primerOwner.currentDirtyLimsPaths,
        retireTrashed: primerOwner.retireTrashedPrimerArtifact,
      },
      { legacySelection: selection }
    );
  return { owner: primerOwner, database, tm, withMutation, recoverSelectedLegacyPrimers };
}
