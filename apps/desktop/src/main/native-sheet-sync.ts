import type { PrimerTmSettings } from '../shared/primer-tm-settings';
import { randomUUID } from 'node:crypto';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { join, dirname } from 'node:path';
import { subscribeAuthState } from './auth/controller';
import type Database from 'better-sqlite3';
import {
  createLimsImportPlan,
  type DryRunLimsImportInput,
} from '../shared/registry-artifacts/ingress-core';
import {
  createSheetSyncPersistence,
  sheetSyncConnectionRelativePath,
  sheetSyncWorkspacePath,
  type SheetSyncConnection,
  type StoredSheetSyncConnection,
} from '../shared/registry-artifacts/sheet-sync/persistence';
import { createSheetSyncLocalState } from '../shared/registry-artifacts/sheet-sync/local-state';
import {
  createSheetSyncSources,
  type GoogleSheetsPort,
} from '../shared/registry-artifacts/sheet-sync/sources';
import { createSheetSyncArtifacts } from '../shared/registry-artifacts/sheet-sync/artifacts';
import { createSheetSyncRuntime } from '../shared/registry-artifacts/sheet-sync/runtime';
import {
  sheetSyncCommandSchema,
  sheetSyncCommandIsReadOnly,
  type SheetSyncRequest,
  type SheetSyncResult,
  type SheetSyncConnectOutcome,
  type SheetSyncPrepared,
} from '../shared/registry-artifacts/sheet-sync/command';
import type { SheetSyncArtifactPorts } from '../shared/registry-artifacts/sheet-sync/ports';
import {
  persistImportSet,
  type ImportSetPersistenceDependencies,
} from '../shared/registry-artifacts/import-set-core';
import {
  entityArtifactSchemaSnapshot,
  parseEntityArtifact,
  serializeEntityArtifact,
} from '../shared/entity-artifact';
import { primerSchemaSnapshot } from '../shared/primer-artifacts/primer-entity-schema';
import {
  requireSupportedLimsFieldDefinitions,
  classifyLimsEntityFieldIssues,
} from '../shared/lims';
import { workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { isSafeWorkspaceRelativePath, normalizePathForBoundary } from '../shared/path-boundary';
import { type WorkspaceMutationRunner } from '../shared/artifact-operation-ports';
import {
  canonicalWorkspacePath,
  writeWorkspaceTextFileAtomicInMain,
  writeWorkspaceBinaryFileAtomicInMain,
} from './primer-artifact-files';
import { queryLimsEntitiesInDb } from './lims';
import { listLimsEntitySchemasInDb } from './lims-engine-core';
import {
  createNativeEntityArtifactWriter,
  createNativePrimerArtifactWriter,
  type NativeImportReviewAgentExecution,
} from './native-import-writers';
import type { GoogleSheetsController } from './google-sheets/controller';
import { resolveSelectedLocalFilePath } from './local-indexed-track-authority';
import {
  findKnownWorkspaceRoot,
  withKnownWorkspacePathsMutationAcrossWorkspaces,
  workspaceMutationRootIdentity,
} from './workspace-sync-mutation-lease';
import { withWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';
import { managedGitStatus } from './workspace-git/native';
import { resolveHeadCommit, readBlobBytesAtCommit } from './workspace-git';
import { materializeLimsGitReadableExportInDb } from './lims-git-export';
import { mutateEntityArtifact } from './entity-artifact-mutation';
import { createNativeScientificArtifactPort } from './native-scientific-artifact-port';
import { ScientificObjectStore } from './scientific-object-store';
import { scientificIdentityPath } from '@waypoint/scientific-objects';

type Prepared = {
  database: Database.Database;
  workspaceRoot: string;
  actor: string;
  command: Extract<SheetSyncRequest['command'], { kind: 'prepare' }>;
  result: SheetSyncPrepared;
};
type Connect = {
  prepared: Prepared;
  connectionId: string;
  requestId: string;
  outcome?: SheetSyncConnectOutcome;
  publicationPossible?: boolean;
  running?: Promise<SheetSyncConnectOutcome>;
};
export function createNativeSheetSync(options: {
  db(): Database.Database;
  workspaceRoots(): readonly string[];
  captureWorkspace?(root: string): () => void;
  assertAuthority(root: string, mutating: boolean): Promise<void>;
  validateDestination(root: string, destination: string): Promise<void>;
  persistence: ImportSetPersistenceDependencies;
}) {
  let googleController: GoogleSheetsController | undefined;
  let providerEpoch = 0;
  subscribeAuthState(() => {
    providerEpoch += 1;
  });
  const prepared = new Map<string, Prepared>();
  const connects = new Map<string, Connect>();
  const tails = new Map<string, Promise<unknown>>();
  const actor = (authority?: NativeImportReviewAgentExecution) =>
    authority ? `agent:${authority.identityId}` : 'desktop';
  const requestKey = (root: string, id: string, authority?: NativeImportReviewAgentExecution) =>
    JSON.stringify([workspaceMutationRootIdentity(root), actor(authority), id]);
  async function ordered<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = tails.get(key) ?? Promise.resolve();
    const task = prior.catch(() => {}).then(operation);
    tails.set(key, task);
    try {
      return await task;
    } finally {
      if (tails.get(key) === task) tails.delete(key);
    }
  }
  const currentWorkspace = (root: string) =>
    options
      .db()
      .prepare(
        'SELECT id, repo_uuid, path, access_mode FROM workspaces WHERE path=? AND archived_at IS NULL AND trashed_at IS NULL'
      )
      .get(root) as
      | { id: number; repo_uuid: string | null; path: string; access_mode: string }
      | undefined;
  const googleSheets: GoogleSheetsPort = {
    status: () => {
      if (!googleController)
        throw new Error('Google Sheets is not available in this native session.');
      return googleController.status();
    },
    worksheet: (input) => {
      if (!googleController)
        throw new Error('Google Sheets is not available in this native session.');
      return googleController.worksheet(input);
    },
  };
  function refuseUnboundGoogle(authority?: NativeImportReviewAgentExecution) {
    if (authority)
      throw new Error(
        'SHEET_SYNC_PROVIDER_AUTHORITY_REQUIRED: This agent has no verified Google account binding.'
      );
  }
  function ordinaryDestination(value: string) {
    if (value !== '' && !isSafeWorkspaceRelativePath(value))
      throw new Error('Choose a project-relative spreadsheet destination.');
    if (
      value
        .split(/[\\/]/)
        .some((part) => ['.git', '.forge', '.waypoint', '.dnaforge'].includes(part.toLowerCase()))
    )
      throw new Error('Project metadata cannot be a spreadsheet destination.');
  }
  async function validateDestination(root: string, destination: string) {
    ordinaryDestination(destination);
    await options.validateDestination(root, root);
    const path = destination ? join(root, destination) : root;
    const canonical = await canonicalWorkspacePath({
      workspaceRoot: root,
      path: join(path, '.sheet-sync-boundary'),
      allowMissing: true,
      artifactNoun: 'spreadsheet',
    });
    if (
      findKnownWorkspaceRoot(options.db(), dirname(canonical.candidate)) !==
      workspaceMutationRootIdentity(root)
    )
      throw new Error('The spreadsheet destination belongs to another project.');
    try {
      if (!(await stat(path)).isDirectory())
        throw new Error('The spreadsheet destination is not a folder.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  async function context(
    root: string,
    authority?: NativeImportReviewAgentExecution,
    connectionId: string = randomUUID(),
    primerTmSettings?: PrimerTmSettings
  ) {
    await options.assertAuthority(root, false);
    const database = options.db();
    const captured = currentWorkspace(root);
    if (!captured) throw new Error('Spreadsheet project ownership is unavailable.');
    const capture =
      captured.access_mode === 'writable' ? options.captureWorkspace?.(root) : undefined;
    const pins = new Map<string, string>();
    let expectedProviderEpoch: number | undefined;
    let expectedSourceRevision: string | undefined;
    const assertCurrent = () => {
      authority?.assertCurrent();
      if (options.db() !== database)
        throw new Error('The native spreadsheet profile changed. Prepare it again.');
      if (expectedProviderEpoch !== undefined && expectedProviderEpoch !== providerEpoch)
        throw new Error(
          'The spreadsheet provider authority changed. Inspect and authorize it again.'
        );
      capture?.();
      const current = currentWorkspace(root);
      if (
        !current ||
        current.id !== captured.id ||
        current.repo_uuid !== captured.repo_uuid ||
        current.access_mode !== captured.access_mode ||
        !options
          .workspaceRoots()
          .some(
            (value) => workspaceMutationRootIdentity(value) === workspaceMutationRootIdentity(root)
          )
      )
        throw new Error('The owning spreadsheet project changed. Inspect it before continuing.');
      for (const [kind, revision] of pins) {
        const matches = listLimsEntitySchemasInDb(options.db()).filter(
          (schema) => schema.entityKind === kind
        );
        if (matches.length !== 1 || matches[0].currentRevisionId !== revision)
          throw new Error('The spreadsheet record definition changed. Prepare the source again.');
      }
    };
    const provider: GoogleSheetsPort = {
      status: async () => {
        expectedProviderEpoch ??= providerEpoch;
        const value = await googleSheets.status();
        assertCurrent();
        return value;
      },
      worksheet: async (input) => {
        refuseUnboundGoogle(authority);
        expectedProviderEpoch ??= providerEpoch;
        const value = await googleSheets.worksheet(input);
        assertCurrent();
        return value;
      },
    };
    const schema = (kind: string) => {
      assertCurrent();
      const matches = listLimsEntitySchemasInDb(options.db()).filter(
        (value) => value.entityKind === kind
      );
      if (matches.length !== 1)
        throw new Error(`No unique Registry schema is provisioned for ${kind}.`);
      return matches[0];
    };
    const pin = (kind: string, revision: string) => {
      if (pins.has(kind) && pins.get(kind) !== revision)
        throw new Error('Spreadsheet schema changed during preparation.');
      pins.set(kind, revision);
      assertCurrent();
    };
    let active:
      | {
          token: string;
          publicationAuthority: { mutationLease: () => void; databaseFence: () => void };
        }
      | undefined;
    const withMutation: WorkspaceMutationRunner = async (requestedRoot, operation, parentToken) => {
      if (requestedRoot !== root)
        throw new Error('Spreadsheet publication changed its owning project.');
      if (active && parentToken === active.token) {
        assertCurrent();
        return operation(active.token);
      }
      if (active) {
        assertCurrent();
        return operation(active.token);
      }
      await authority?.authorize(['read-workspace', 'write-workspace']);
      await options.assertAuthority(root, true);
      assertCurrent();
      return withKnownWorkspacePathsMutationAcrossWorkspaces(options.db(), [root], (leases) =>
        withWorkspaceSyncDatabaseFence(options.db(), async (release) => {
          assertCurrent();
          active = {
            token: randomUUID(),
            publicationAuthority: {
              mutationLease: leases.get(workspaceMutationRootIdentity(root))!,
              databaseFence: release,
            },
          };
          try {
            return await operation(active.token);
          } finally {
            active = undefined;
          }
        })
      );
    };
    const readOwned = async <T>(path: string, read: () => Promise<T>): Promise<T> => {
      assertCurrent();
      if (normalizePathForBoundary(path) === normalizePathForBoundary(root)) {
        const canonicalRoot = await realpath(root);
        const before = await stat(path);
        assertCurrent();
        if (!before.isDirectory())
          throw new Error('The owning spreadsheet project is not a folder.');
        const value = await read();
        const currentRoot = await realpath(root);
        const after = await stat(path);
        assertCurrent();
        if (
          canonicalRoot !== currentRoot ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          !after.isDirectory()
        )
          throw new Error('The owning spreadsheet project changed during its root read.');
        return value;
      }
      await canonicalWorkspacePath({
        workspaceRoot: root,
        path,
        allowMissing: true,
        artifactNoun: 'spreadsheet',
      });
      assertCurrent();
      const value = await read();
      assertCurrent();
      return value;
    };
    const fs = {
      ...options.persistence.fs,
      exists: (path: string) => readOwned(path, () => options.persistence.fs.exists(path)),
      readTextFile: (path: string) =>
        readOwned(path, () => options.persistence.fs.readTextFile(path)),
      readFile: (path: string) => readOwned(path, () => options.persistence.fs.readFile(path)),
      sha256File: (path: string) => readOwned(path, () => options.persistence.fs.sha256File(path)),
      readDir: async (path: string) =>
        readOwned(path, async () =>
          (await readdir(path, { withFileTypes: true })).map((entry) => ({
            name: entry.name,
            isFile: entry.isFile(),
            isDirectory: entry.isDirectory(),
          }))
        ),
      writeWorkspaceTextFileAtomic: (
        input: Parameters<typeof writeWorkspaceTextFileAtomicInMain>[0]
      ) => {
        assertCurrent();
        if (!active || input.workspaceRoot !== root)
          throw new Error('Spreadsheet publication requires its native mutation owner.');
        return writeWorkspaceTextFileAtomicInMain(input, { beforePublish: assertCurrent });
      },
      writeWorkspaceBinaryFileAtomic: (
        input: Parameters<typeof writeWorkspaceBinaryFileAtomicInMain>[0]
      ) => {
        assertCurrent();
        if (!active || input.workspaceRoot !== root)
          throw new Error('Spreadsheet publication requires its native mutation owner.');
        return writeWorkspaceBinaryFileAtomicInMain(input, { beforePublish: assertCurrent });
      },
    };
    const persistence = { ...options.persistence, fs };
    const metadata = createSheetSyncPersistence(fs);
    const local = createSheetSyncLocalState({
      db: {
        select: async <T>(
          sql: string,
          params: import('../shared/sqlite-ipc').SqliteIpcValue[] = []
        ) => {
          assertCurrent();
          return options
            .db()
            .prepare(sql)
            .all(...params) as T;
        },
        execute: async (sql, params = []) => {
          assertCurrent();
          const result = options
            .db()
            .prepare(sql)
            .run(...params);
          return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
        },
      },
      resolveWorkspaceScope: async (requestedRoot) =>
        requestedRoot === root ? workspaceScopeKey(captured.repo_uuid, captured.id) : null,
      googleSheets: provider,
    });
    const selectedPath = async (path: string) => {
      const selected = resolveSelectedLocalFilePath(path);
      const canonical = await realpath(path);
      assertCurrent();
      if (normalizePathForBoundary(selected) !== normalizePathForBoundary(canonical))
        throw new Error('Choose this workbook in the native file picker before synchronizing.');
      return canonical;
    };
    const authorizeLocal = async (
      requestedRoot: string,
      connection: SheetSyncConnection,
      path: string
    ) => {
      const selected = await selectedPath(path);
      if ('provider' in connection.source || selected !== (await realpath(connection.source.path)))
        throw new Error('Choose the workbook recorded for this connection.');
      assertCurrent();
      return local.authorizeLocalSheetSync(requestedRoot, connection, connection.source.path);
    };
    const createPlan = async (input: DryRunLimsImportInput) => {
      if (!input.forcedKind) throw new Error('Choose the spreadsheet record kind.');
      const snapshot = entityArtifactSchemaSnapshot(schema(input.forcedKind));
      const fields = requireSupportedLimsFieldDefinitions(snapshot.fields);
      pin(input.forcedKind, snapshot.schemaRevisionId);
      const plan = await createLimsImportPlan(
        { ...input, schemaFields: fields, schemaRevisionId: snapshot.schemaRevisionId },
        {
          queryEntities: async (query) => {
            assertCurrent();
            return queryLimsEntitiesInDb(options.db(), query);
          },
          applyBatch: async () => {
            throw new Error('Spreadsheet preparation cannot apply an import batch.');
          },
        }
      );
      assertCurrent();
      return plan;
    };
    const sourceReaders = createSheetSyncSources({
      createLimsImportPlan: createPlan,
      readFile: async (path) => {
        const canonical = await selectedPath(path);
        const file = await open(canonical, 'r');
        try {
          const before = await file.stat();
          if (!before.isFile()) throw new Error('The selected workbook is not a regular file.');
          const bytes = new Uint8Array(await file.readFile());
          const after = await file.stat();
          assertCurrent();
          if (
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs ||
            bytes.length !== before.size ||
            canonical !== (await realpath(path))
          )
            throw new Error('The workbook changed while reading. Synchronize it again.');
          return bytes;
        } finally {
          await file.close();
        }
      },
    });
    const checkRevision = <T extends { revision: string }>(result: T): T => {
      assertCurrent();
      if (expectedSourceRevision && result.revision !== expectedSourceRevision)
        throw new Error(
          'The spreadsheet changed since preview. Prepare it again before connecting.'
        );
      return result;
    };
    const sources = {
      ...sourceReaders,
      readExcelSyncSource: async (...args: Parameters<typeof sourceReaders.readExcelSyncSource>) =>
        checkRevision(await sourceReaders.readExcelSyncSource(...args)),
      parseGoogleSyncSource: async (
        ...args: Parameters<typeof sourceReaders.parseGoogleSyncSource>
      ) => checkRevision(await sourceReaders.parseGoogleSyncSource(...args)),
    };
    const writerOptions = () => ({
      db: options.db(),
      persistence,
      assertCurrent,
      workspaceRoot: root,
      workspaceRoots: options.workspaceRoots,
      operationId: connectionId,
      publicationAuthority: active?.publicationAuthority,
      agentAuthority: authority,
      primerTmSettings,
    });
    const primerWriter = () => createNativePrimerArtifactWriter(writerOptions());
    const entityWriter = () => createNativeEntityArtifactWriter(writerOptions());
    const query: SheetSyncArtifactPorts['queryLimsEntities'] = async (input) => {
      assertCurrent();
      return queryLimsEntitiesInDb(options.db(), input);
    };
    const reconcile = async () => {
      assertCurrent();
      for (const entry of await metadata.listSheetSyncConnections(root)) {
        if (entry.kind !== 'connection') continue;
        for (const checkpoint of entry.stored.connection.checkpoints) {
          const path = sheetSyncWorkspacePath(root, checkpoint.artifactRelativePath);
          ordinaryDestination(checkpoint.artifactRelativePath);
          if (checkpoint.source.kind === 'oligo' || checkpoint.source.kind === 'rna_oligo') {
            await primerWriter().owner.reconcilePrimerArtifact(path, root, {
              mutationToken: active?.token,
            });
          } else {
            const content = await fs.readTextFile(path),
              artifact = parseEntityArtifact(content);
            if (artifact.id !== checkpoint.entityId)
              throw new Error('Spreadsheet checkpoint record identity changed.');
            if (
              artifact.kind === 'strain' &&
              new ScientificObjectStore(options.db(), captured.id).catalog().head !== null
            ) {
              const projected = (
                await query({ id: artifact.id, workspaceId: captured.id, limit: 1 })
              )[0];
              if (
                !projected ||
                projected.name !== artifact.name ||
                !isDeepStrictEqual(projected.fields, artifact.fields)
              )
                throw new Error('Accepted spreadsheet record reconstruction remains incomplete.');
            } else
              await entityWriter().projectArtifact(
                artifact as import('../shared/entity-artifact').EntityArtifactV2,
                content,
                path,
                {
                  workspaceRoot: root,
                  destinationDir: root,
                  kind: artifact.kind,
                  name: artifact.name,
                  fields: artifact.fields,
                }
              );
          }
        }
      }
      assertCurrent();
      materializeLimsGitReadableExportInDb(options.db(), {
        workspaceId: captured.id,
        durable: true,
      });
    };
    const artifactPorts: SheetSyncArtifactPorts = {
      fs,
      withRendererWorkspaceMutation: withMutation,
      resolveWorkspaceId: async (requestedRoot) => (requestedRoot === root ? captured.id : null),
      queryLimsEntities: query,
      resolvePrimerSchema: async (kind) => {
        const current = schema(kind);
        pin(kind, current.currentRevisionId);
        return primerSchemaSnapshot(current);
      },
      calculatePrimerTm: async (sequence) => {
        if (active) throw new Error('Primer provider calculation must finish before publication.');
        const result = await primerWriter().tm.calculate(sequence);
        assertCurrent();
        return result;
      },
      readPrimerArtifactAtPath: (...args) => primerWriter().owner.readPrimerArtifactAtPath(...args),
      reconcilePrimerArtifact: (...args) => primerWriter().owner.reconcilePrimerArtifact(...args),
      updatePrimerArtifactContent: (...args) =>
        primerWriter().owner.updatePrimerArtifactContent(...args),
      recordPrimers: async (input) => {
        const result: import('../shared/primer-artifacts/record-primers-owner').RecordPrimersResult =
          { recorded: [], skipped: [], failed: [] };
        for (const primer of input.primers) {
          if (!primer.artifactPath)
            throw new Error('Spreadsheet primer publication requires its retained path.');
          const saved = await primerWriter().owner.writeAndProjectPrimerArtifact(
            {
              ...primer,
              notes: primer.notes ?? undefined,
              artifactPath: primer.artifactPath,
              workspaceRoot: root,
              requireRegistry: true,
              origin: input.origin,
            },
            { mutationToken: active?.token }
          );
          if (saved.created) result.recorded.push({ ...saved, gitCommitted: false });
          else result.skipped.push({ input: primer, reason: 'duplicate' });
        }
        return result;
      },
      recordEntityArtifact: (input) =>
        withMutation(root, async (token) =>
          entityWriter().entityOwner.recordEntityArtifact({ ...input, mutationToken: token })
        ),
      recordProtein: async (input) => {
        const { createProteinArtifactOwner } =
          await import('../shared/protein-artifacts/protein-artifact-owner');
        return createProteinArtifactOwner({
          queryLimsEntities: query,
          recordEntityArtifact: artifactPorts.recordEntityArtifact,
        }).recordProtein(input);
      },
      reconcileWorkspaceAfterFilesChanged: () => withMutation(root, reconcile),
    };
    const artifacts = createSheetSyncArtifacts(artifactPorts);
    const runtime = createSheetSyncRuntime({
      ...artifactPorts,
      ...metadata,
      ...local,
      ...sources,
      ...artifacts,
      loadSheetSyncConnection: async (_root, id) => load(id),
      publicationPaths: async (requestedRoot, dirty) => {
        const scientific = createNativeScientificArtifactPort({
          db: options.db(),
          workspaceRoot: root,
          assertCurrent,
          files: fs,
          publicationAuthority: active?.publicationAuthority,
        });
        return [
          ...((await fs.exists(sheetSyncWorkspacePath(root, scientificIdentityPath)))
            ? [scientificIdentityPath]
            : []),
          ...(await scientific.relationshipGitPaths(requestedRoot, dirty)),
        ];
      },
      googleSheets: provider,
      authorizeLocalSheetSync: authorizeLocal,
      newConnectionId: () => connectionId,
      persistImportSet: (input) => persistImportSet(input, persistence),
      isGitRepo: options.persistence.isGitRepo,
      gitCommitPaths: options.persistence.commitPaths,
      gitStatus: async (requestedRoot) =>
        new Map(
          (await managedGitStatus(requestedRoot)).map((entry) => [entry.path, 'modified' as const])
        ),
      gitHead: resolveHeadCommit,
      gitShowCommit: async (path, commit, requestedRoot) => {
        try {
          return new TextDecoder().decode(await readBlobBytesAtCommit(requestedRoot, commit, path));
        } catch {
          return null;
        }
      },
      updateLimsEntity: (input) =>
        withMutation(root, async () => {
          assertCurrent();
          const target = (
            await query({ id: input.id, workspaceId: captured.id, includeArchived: true, limit: 1 })
          )[0];
          if (!target || target.tombstone || target.archivedAt != null)
            throw new Error('Spreadsheet target is missing or archived.');
          const scientific = createNativeScientificArtifactPort({
            db: options.db(),
            workspaceRoot: root,
            assertCurrent,
            files: fs,
            publicationAuthority: active?.publicationAuthority,
          });
          const locator = target.fields.artifact;
          if (
            target.kind === 'strain' &&
            locator &&
            typeof locator === 'object' &&
            'relativePath' in locator &&
            typeof locator.relativePath === 'string'
          ) {
            ordinaryDestination(locator.relativePath);
            const path = sheetSyncWorkspacePath(root, locator.relativePath),
              loaded = await scientific.readText(path, root);
            if (loaded.acceptedRevision) {
              const before = parseEntityArtifact(loaded.content);
              const fields = { ...input.fields };
              for (const key of ['artifact', 'sourceMetadata'])
                if (!isDeepStrictEqual(fields[key], before.fields[key]))
                  throw new Error(
                    'Spreadsheet updates cannot replace artifact ownership or provenance.'
                  );
              if (target.eventSeq !== input.expectedEventSeq) {
                if (before.name === input.name && isDeepStrictEqual(before.fields, fields))
                  return target;
                throw new Error('Spreadsheet record changed; inspect it before retrying.');
              }
              const issues = classifyLimsEntityFieldIssues(
                before.kind,
                fields,
                requireSupportedLimsFieldDefinitions(before.schemaSnapshot?.fields ?? [])
              );
              if (issues.incomplete.length || issues.malformed.length)
                throw new Error([...issues.incomplete, ...issues.malformed].join('; '));
              const content = serializeEntityArtifact({
                ...before,
                name: input.name ?? before.name,
                fields,
              });
              assertCurrent();
              if (
                (await query({ id: target.id, limit: 1 }))[0]?.eventSeq !== input.expectedEventSeq
              )
                throw new Error('Spreadsheet record changed before publication.');
              await scientific.publish({
                workspaceRoot: root,
                artifactPath: path,
                resourceId: target.id,
                prior: loaded.acceptedRevision,
                representation: { format: 'strain-entity-v1', text: content },
                mutationToken: active?.token,
              });
              const current = (
                await query({ id: target.id, workspaceId: captured.id, limit: 1 })
              )[0];
              if (
                !current ||
                current.name !== input.name ||
                !isDeepStrictEqual(current.fields, fields)
              )
                throw new Error('Spreadsheet accepted record reconstruction remains incomplete.');
              return current;
            }
          }
          return (
            await mutateEntityArtifact({
              db: options.db(),
              runDatabase: (operation) => {
                assertCurrent();
                return operation();
              },
              action: 'update',
              input,
            })
          ).entity;
        }),
    });
    const validateConnection = (connection: SheetSyncConnection) => {
      ordinaryDestination(connection.destinationRelativePath);
      for (const checkpoint of connection.checkpoints)
        ordinaryDestination(checkpoint.artifactRelativePath);
      for (const path of connection.finalization?.snapshotPaths ?? [])
        if (!/^\.waypoint\/sheet-sync\/snapshots\/[a-f0-9]{64}\.json$/.test(path))
          throw new Error('Spreadsheet finalization contains an invalid snapshot identity.');
    };
    const load = async (id: string) => {
      const value = await metadata.loadSheetSyncConnection(root, id);
      validateConnection(value.connection);
      return value;
    };
    return {
      root,
      assertCurrent,
      pin,
      schema,
      metadata,
      local,
      sources,
      runtime,
      googleSheets: provider,
      selectedPath,
      authorizeLocal,
      withMutation,
      load,
      validateConnection,
      expectSourceRevision(revision: string) {
        expectedSourceRevision = revision;
      },
    };
  }
  async function call(
    supplied: SheetSyncRequest,
    authority?: NativeImportReviewAgentExecution
  ): Promise<SheetSyncResult> {
    const command = sheetSyncCommandSchema.parse(supplied.command),
      root = supplied.workspaceRoot;
    await options.assertAuthority(root, !sheetSyncCommandIsReadOnly(command));
    const ctx = await context(
      root,
      authority,
      randomUUID(),
      command.kind === 'pull' ? command.primerTmSettings : undefined
    );
    if (command.kind === 'prepare') {
      ordinaryDestination(command.destinationRelativePath);
      await validateDestination(root, command.destinationRelativePath);
      const source =
        'provider' in command.source
          ? command.source
          : { ...command.source, path: await ctx.selectedPath(command.source.path) };
      if ('provider' in source) {
        refuseUnboundGoogle(authority);
        if (!command.grantId)
          throw new Error('Choose a connected Google account before preparing this worksheet.');
      }
      const read =
        'provider' in source
          ? await ctx.sources.parseGoogleSyncSource(
              source,
              await ctx.googleSheets.worksheet({
                grantId: command.grantId ?? '',
                spreadsheetId: source.spreadsheetId,
                sheetId: source.sheetId,
              })
            )
          : await ctx.sources.readExcelSyncSource(source);
      if (!read.plan.schemaRevisionId)
        throw new Error('Spreadsheet preparation lacks its native record definition.');
      ctx.assertCurrent();
      const result: SheetSyncPrepared = {
        kind: 'prepared',
        preparedId: randomUUID(),
        sourceRevision: read.revision,
        schemaRevisionId: read.plan.schemaRevisionId,
        plan: read.plan,
      };
      prepared.set(result.preparedId, {
        database: options.db(),
        workspaceRoot: root,
        actor: actor(authority),
        command: { ...command, source },
        result,
      });
      return structuredClone(result);
    }
    if (
      command.kind === 'connect' ||
      command.kind === 'recover-connect' ||
      command.kind === 'inspect-connect'
    ) {
      const key = requestKey(root, command.requestId, authority);
      let attempt = connects.get(key);
      if (command.kind === 'connect') {
        const prep = prepared.get(command.preparedId);
        if (
          !prep ||
          prep.database !== options.db() ||
          prep.workspaceRoot !== root ||
          prep.actor !== actor(authority)
        )
          throw new Error('Prepare this spreadsheet in the current project and authority first.');
        if (attempt && attempt.prepared !== prep)
          throw new Error('Spreadsheet request ID was reused for a different preparation.');
        if (!attempt) {
          const sourceIdentity = (source: SheetSyncConnection['source']) =>
            'provider' in source
              ? JSON.stringify(['google', source.spreadsheetId, source.sheetId])
              : JSON.stringify([
                  'excel',
                  normalizePathForBoundary(source.path),
                  source.sheetName.toLowerCase(),
                ]);
          for (const existing of connects.values()) {
            if (
              existing.prepared.database === options.db() &&
              existing.prepared.workspaceRoot === root &&
              sourceIdentity(existing.prepared.command.source) ===
                sourceIdentity(prep.command.source) &&
              (existing.running ||
                (existing.outcome?.kind === 'partial' && existing.publicationPossible))
            )
              throw new Error(
                `SHEET_SYNC_CONNECT_UNRESOLVED: Inspect request ${existing.requestId} and connection ${existing.connectionId} before reconnecting this source.`
              );
          }
          attempt = { prepared: prep, connectionId: randomUUID(), requestId: command.requestId };
          connects.set(key, attempt);
        }
      }
      if (!attempt || attempt.prepared.database !== options.db())
        throw new Error(
          'No retained Connect attempt exists in this native session. Inspect the existing connections before creating one.'
        );
      if (command.kind === 'inspect-connect') {
        if (attempt.running) return attempt.running;
        if (!attempt.outcome)
          throw new Error('The retained spreadsheet connection has no outcome yet.');
        return structuredClone(attempt.outcome);
      }
      if (attempt.running) return attempt.running;
      if (
        attempt.outcome &&
        (command.kind !== 'recover-connect' || attempt.outcome.kind === 'connected')
      )
        return structuredClone(attempt.outcome);
      const currentAttempt = attempt;
      const operation = ordered(JSON.stringify([root, 'connect']), async () => {
        const selected = currentAttempt.prepared.command;
        const owner = await context(
          root,
          authority,
          currentAttempt.connectionId,
          selected.primerTmSettings
        );
        if ('provider' in selected.source) refuseUnboundGoogle(authority);
        owner.pin(selected.source.forcedKind, currentAttempt.prepared.result.schemaRevisionId);
        await validateDestination(root, selected.destinationRelativePath);
        let stored: StoredSheetSyncConnection | null = null;
        try {
          if (command.kind === 'recover-connect') {
            try {
              stored = await owner.load(currentAttempt.connectionId);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
          if (stored) {
            currentAttempt.publicationPossible = true;
            if (
              JSON.stringify(stored.connection.source) !== JSON.stringify(selected.source) ||
              stored.connection.destinationRelativePath !== selected.destinationRelativePath
            )
              throw new Error('The retained connection changed. Inspect it before recovering.');
            if ('provider' in stored.connection.source)
              await owner.local.authorizeGoogleSheetSync(
                root,
                stored.connection,
                selected.grantId ?? ''
              );
            else await owner.authorizeLocal(root, stored.connection, stored.connection.source.path);
            await owner.runtime.pullExcelSheetConnection({
              workspaceRoot: root,
              id: stored.connection.id,
              assertCurrent: owner.assertCurrent,
            });
            stored = await owner.load(stored.connection.id);
          } else {
            owner.expectSourceRevision(currentAttempt.prepared.result.sourceRevision);
            const fresh =
              'provider' in selected.source
                ? await owner.sources.parseGoogleSyncSource(
                    selected.source,
                    await owner.googleSheets.worksheet({
                      grantId: selected.grantId ?? '',
                      spreadsheetId: selected.source.spreadsheetId,
                      sheetId: selected.source.sheetId,
                    })
                  )
                : await owner.sources.readExcelSyncSource(selected.source);
            if (fresh.revision !== currentAttempt.prepared.result.sourceRevision)
              throw new Error(
                'The spreadsheet changed since preview. Prepare it again before connecting.'
              );
            currentAttempt.publicationPossible = true;
            stored =
              'provider' in selected.source
                ? await owner.runtime.createGoogleSheetSyncConnection({
                    workspaceRoot: root,
                    source: selected.source,
                    grantId: selected.grantId ?? '',
                    destinationRelativePath: selected.destinationRelativePath,
                  })
                : await owner.runtime.createExcelSheetSyncConnection({
                    workspaceRoot: root,
                    source: selected.source,
                    destinationRelativePath: selected.destinationRelativePath,
                  });
          }
          owner.assertCurrent();
          return {
            kind: 'connected' as const,
            requestId: command.requestId,
            connectionId: currentAttempt.connectionId,
            stored,
          };
        } catch (error) {
          try {
            stored = await owner.load(currentAttempt.connectionId);
          } catch {}
          return {
            kind: 'partial' as const,
            requestId: command.requestId,
            connectionId: currentAttempt.connectionId,
            stored,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      });
      const retained = operation.catch(
        (error): SheetSyncConnectOutcome => ({
          kind: 'partial',
          requestId: command.requestId,
          connectionId: currentAttempt.connectionId,
          stored: null,
          message: error instanceof Error ? error.message : String(error),
        })
      );
      currentAttempt.running = retained;
      try {
        const result = await retained;
        currentAttempt.outcome = result;
        return structuredClone(result);
      } finally {
        currentAttempt.running = undefined;
      }
    }
    if (command.kind === 'list') {
      const entries = (await ctx.metadata.listSheetSyncConnections(root)).map((entry) => {
        if (entry.kind !== 'connection') return entry;
        try {
          ctx.validateConnection(entry.stored.connection);
          return entry;
        } catch (error) {
          return {
            kind: 'invalid' as const,
            name: `${entry.stored.connection.id}.json`,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      });
      ctx.assertCurrent();
      return { kind: 'connections', entries };
    }
    const stored = await ctx.load(command.id);
    if (command.kind === 'inspect') return { kind: 'connection', stored };
    if (command.kind === 'authorization')
      return {
        kind: 'authorization',
        state: await ctx.local.localSheetSyncAuthorization(root, stored.connection),
      };
    if ('provider' in stored.connection.source) refuseUnboundGoogle(authority);
    return ordered(JSON.stringify([root, command.id]), async () => {
      ctx.assertCurrent();
      if (command.kind === 'pull')
        return {
          kind: 'pulled',
          summary: await ctx.runtime.pullExcelSheetConnection({
            workspaceRoot: root,
            id: command.id,
            assertCurrent: ctx.assertCurrent,
          }),
        };
      if (command.kind === 'set-enabled')
        await ctx.withMutation(root, () =>
          ctx.runtime.setSheetSyncEnabled(root, command.id, command.enabled)
        );
      if (command.kind === 'authorize-excel')
        await ctx.withMutation(root, () =>
          ctx.authorizeLocal(root, stored.connection, command.selectedPath)
        );
      if (command.kind === 'authorize-google')
        await ctx.withMutation(root, () =>
          ctx.local.authorizeGoogleSheetSync(root, stored.connection, command.grantId)
        );
      ctx.assertCurrent();
      return { kind: 'changed' };
    });
  }
  return {
    call,
    setGoogleSheetsController(controller: GoogleSheetsController) {
      if (googleController && googleController !== controller)
        throw new Error(
          'Spreadsheet provider ownership cannot be replaced during a native session.'
        );
      if (googleController === controller) return;
      googleController = controller;
      controller.subscribe(() => {
        providerEpoch += 1;
      });
    },
  };
}
