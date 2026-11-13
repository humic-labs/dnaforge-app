import { createPrimerBindingOwnershipStore } from '../shared/primer-artifacts/primer-binding-ownership';
import { createNativeCatalogDatabase } from './native-catalog-repository';
import { ensureSequenceIndexInDb } from './sequence-index-command';
import {
  parseScientificDocumentIdentity,
  parseWorkspaceIdentity,
  type ScientificAcceptedDocumentRevision,
} from '@waypoint/domain-services';
import {
  readScientificDocumentInMain,
  resolveMainWorkspaceIdentity,
} from './scientific-document-reader';
import { NativeDocumentCommandError } from '../shared/native-document-error';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import {
  NativeSequenceWorkingCopyOwner,
  type NativeSequenceRecord,
  type NativeSequenceScope,
} from './native-sequence-working-copy';
import { createNativeSequenceDocumentResolver } from './native-sequence-document-resolver';
import { assertNativeSequenceContentWritable } from './native-sequence-content-access';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';
import { readFileBoundedFromHandle } from './ipc/bounded-file-read';
import { parseSequenceFileAsDocument, isBinarySequencePath } from '../shared/parse-sequence-file';
import { HARD_CAP_BYTES } from '../shared/oversized-guard';
import { saveSequenceDocumentWithLineage } from './sequence-document-save';
import { commitSequenceDocumentHistory } from './sequence-document-history';
import { syncDirectory } from './fs-durability';
import { createKeyedMutex } from './workspace-git/keyed-mutex';
import { persistRichPastePrimerBindingsInMain } from './native-rich-paste-primer-bindings';
import { createSequenceIdentityRepository } from '../db/sequence-identity-repository';
import {
  acquireWorkspaceSyncDatabaseFence,
  assertWorkspaceSyncDatabaseFence,
} from './workspace-sync-database-fence';
import { isSequencePackageFileKind } from '../db/sequence-package';

export function createNativeSequenceWorkingCopies(options: {
  db(): Database.Database;
  workspaceRoots(): readonly string[];
  writableWorkspaceRoots(): readonly string[];
  profileDirectory(): string;
  captureWorkspace(root: string, mutating: boolean): () => void;
}): NativeSequenceWorkingCopyOwner {
  const resolveDocument = createNativeSequenceDocumentResolver({
    db: options.db,
    workspaceRoots: options.workspaceRoots,
    allowArchived: true,
  });
  const locks = createKeyedMutex();
  const directory = () => join(options.profileDirectory(), 'sequence-working-copies');
  const recordPath = (id: string) =>
    join(directory(), createHash('sha256').update(id).digest('hex') + '.json');
  const metadataPath = (id: string) =>
    join(directory(), createHash('sha256').update(id).digest('hex') + '.identity.json');
  const hash = (content: Uint8Array) =>
    `sha256:${createHash('sha256').update(content).digest('hex')}`;
  const writeJson = async (path: string, value: unknown) => {
    await mkdir(directory(), { recursive: true, mode: 0o700 });
    const temporary = path + '.' + randomUUID() + '.tmp',
      file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value), 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, path);
      await syncDirectory(directory());
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  };
  let legacyRunning = false,
    legacyState: { pendingIds: readonly string[] } | undefined;
  const legacyPath = () => join(directory(), 'legacy-migration-v1.json');
  const currentLegacyMigration = async () => {
    if (legacyRunning) return undefined;
    if (legacyState) return legacyState;
    try {
      const record: unknown = JSON.parse(await readFile(legacyPath(), 'utf8'));
      if (
        !record ||
        typeof record !== 'object' ||
        !('complete' in record) ||
        record.complete !== true ||
        !('pendingIds' in record) ||
        !Array.isArray(record.pendingIds) ||
        record.pendingIds.some((id) => typeof id !== 'string')
      )
        throw new Error('The native sequence migration record is invalid.');
      legacyState = { pendingIds: record.pendingIds as string[] };
      return legacyState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await access(join(options.profileDirectory(), 'IndexedDB'));
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      legacyState = { pendingIds: [] };
      return legacyState;
    }
  };
  const resolve = async (id: string, mutating: boolean): Promise<NativeSequenceScope> => {
    const database = options.db();
    const readBinding = () =>
      database
        .prepare(
          "SELECT f.id AS bindingId,f.path,w.path AS root,w.id AS workspaceId,f.file_kind AS fileKind FROM catalog_entity_files f JOIN workspaces w ON w.id=f.workspace_id WHERE f.entity_id=? AND f.status='current' AND w.archived_at IS NULL AND w.trashed_at IS NULL LIMIT 2"
        )
        .all(id) as Array<{
        bindingId: string;
        path: string;
        root: string;
        workspaceId: number;
        fileKind: string;
      }>;
    const bindings = readBinding();
    if (bindings.length !== 1) throw new Error('The sequence has no unique owning project.');
    const binding = bindings[0];
    const document = await resolveDocument({
      operationId: 'native-sequence-working-copy',
      targetDocumentId: id,
    });
    const root = workspaceMutationRootIdentity(document.workspaceRoot),
      path = workspaceMutationRootIdentity(document.sourcePath),
      bindingPath = workspaceMutationRootIdentity(binding.path);
    const assertEnrollment = options.captureWorkspace(root, mutating);
    const writable = () =>
      options
        .writableWorkspaceRoots()
        .some((candidate) => workspaceMutationRootIdentity(candidate) === root);
    let readOnly = !writable();
    try {
      assertNativeSequenceContentWritable(options.db(), id, root);
    } catch {
      readOnly = true;
    }
    const assertBinding = () => {
      if (options.db() !== database)
        throw new Error('The sequence database changed during the native command.');
      const current = readBinding();
      if (
        current.length !== 1 ||
        current[0].bindingId !== binding.bindingId ||
        workspaceMutationRootIdentity(current[0].root) !== root ||
        current[0].workspaceId !== binding.workspaceId ||
        workspaceMutationRootIdentity(current[0].path) !== bindingPath ||
        current[0].fileKind !== binding.fileKind
      )
        throw new Error('The sequence owner changed during the native command.');
    };
    const assertCurrent = () => {
      assertEnrollment();
      if (
        !options
          .workspaceRoots()
          .some((candidate) => workspaceMutationRootIdentity(candidate) === root)
      )
        throw new Error('OUTSIDE_WORKSPACE: The sequence project is no longer enrolled.');
      assertBinding();
      if (mutating) {
        if (!writable())
          throw new Error('READ_ONLY_SEQUENCE: The sequence project is enrolled for reading only.');
        assertNativeSequenceContentWritable(options.db(), id, root);
      }
    };
    assertCurrent();
    const assertIdentityCurrent = () => {
      assertEnrollment();
      if (
        !options
          .workspaceRoots()
          .some((candidate) => workspaceMutationRootIdentity(candidate) === root) ||
        (mutating && !writable())
      )
        throw new Error('The sequence project enrollment changed.');
    };
    return {
      documentId: id,
      bindingIdentity: JSON.stringify([
        binding.bindingId,
        binding.workspaceId,
        root,
        bindingPath,
        binding.fileKind,
      ]),
      managed: isSequencePackageFileKind(binding.fileKind),
      path,
      workspaceRoot: root,
      recordedWorkspaceRoot: binding.root,
      readOnly,
      assertCurrent,
      assertIdentityCurrent,
      captureForSave() {
        assertCurrent();
        assertNativeSequenceContentWritable(database, id, root);
        const readAuthority = () =>
          database
            .prepare<[string]>(
              `SELECT e.type,e.status,e.storage_type,w.repo_uuid,w.access_mode,
              COALESCE(l.tombstone,0) AS tombstone,l.archived_at,
              b.workspace_uuid,b.access_role,b.owner_account_id,b.owner_org_id,
              b.remote_workspace_id,b.enabled
              FROM catalog_entities e
              JOIN catalog_entity_files f ON f.entity_id=e.id AND f.status='current'
              JOIN workspaces w ON w.id=f.workspace_id
              LEFT JOIN lims_entity l ON l.id=e.id
              LEFT JOIN workspace_sync_bindings b ON b.workspace_id=w.id
              WHERE e.id=? ORDER BY f.id,b.workspace_uuid`
            )
            .all(id);
        const authority = readAuthority();
        const assertSavedIdentity = () => {
          assertBinding();
          if (!isDeepStrictEqual(readAuthority(), authority))
            throw new Error('The captured sequence write authority changed before acceptance.');
        };
        const assertSavedResource = () => {
          assertSavedIdentity();
          assertNativeSequenceContentWritable(database, id, root);
        };
        assertSavedResource();
        return {
          documentId: id,
          managed: isSequencePackageFileKind(binding.fileKind),
          path,
          workspaceRoot: root,
          recordedWorkspaceRoot: binding.root,
          readOnly: false,
          assertCurrent: assertSavedResource,
          assertIdentityCurrent: assertSavedIdentity,
        };
      },
    };
  };
  return new NativeSequenceWorkingCopyOwner({
    async available(documentId) {
      const bindings = options
        .db()
        .prepare(
          "SELECT w.path AS root FROM catalog_entity_files f JOIN workspaces w ON w.id=f.workspace_id WHERE f.entity_id=? AND f.status='current' AND w.archived_at IS NULL AND w.trashed_at IS NULL LIMIT 2"
        )
        .all(documentId) as Array<{ root: string }>;
      if (bindings.length === 0) return false;
      if (bindings.length !== 1) throw new Error('The sequence has no unique owning project.');
      try {
        const root = await realpath(bindings[0].root);
        for (const enrolled of options.workspaceRoots()) {
          try {
            if ((await realpath(enrolled)) === root) return true;
          } catch (error) {
            if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
              throw error;
          }
        }
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error;
      }
      return false;
    },
    beginLegacyMigration() {
      legacyRunning = true;
    },
    async completeLegacyMigration(pendingIds) {
      if (pendingIds.length > 10000 || pendingIds.some((id) => !id.trim() || /[\\/]/.test(id)))
        throw new Error('Invalid native sequence migration results.');
      await writeJson(legacyPath(), { version: 1, complete: true, pendingIds });
      legacyState = { pendingIds: [...pendingIds] };
      legacyRunning = false;
    },
    async beforeExecute(documentId, operation) {
      const state = await currentLegacyMigration();
      if (!state)
        throw new Error(
          'LEGACY_SEQUENCE_DRAFT_MIGRATION_REQUIRED: Start the desktop once to transfer its earlier sequence recovery records.'
        );
      if (
        state.pendingIds.includes(documentId) &&
        !['inspect', 'discard', 'restore-recovery', 'reload'].includes(operation)
      )
        throw new Error(
          'LEGACY_SEQUENCE_DRAFT_CONFLICT: An earlier sequence draft remains preserved and requires recovery.'
        );
    },
    async listRetainedDirty() {
      const entries = await readdir(directory()).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const result: Array<{ documentId: string; path: string }> = [];
      for (const entry of entries) {
        if (!entry.endsWith('.identity.json')) continue;
        const record = JSON.parse(await readFile(join(directory(), entry), 'utf8')) as {
          documentId: string;
          path: string;
          dirty: boolean;
        };
        if (
          record.dirty &&
          options.workspaceRoots().some((root) => {
            const parent = workspaceMutationRootIdentity(root),
              path = workspaceMutationRootIdentity(record.path);
            return path === parent || path.startsWith(parent.replace(/[\\/]+$/, '') + '/');
          })
        )
          result.push(record);
      }
      return result;
    },
    normalizePath: workspaceMutationRootIdentity,
    resolve,
    async load(scope) {
      const status = await stat(scope.path);
      if (!status.isFile() || status.size > HARD_CAP_BYTES)
        throw new Error(
          'SEQUENCE_SIZE_POLICY: This source requires its indexed or large-file viewer.'
        );
      const bytes = await readFileBoundedFromHandle(scope.path, HARD_CAP_BYTES);
      let content: string | Uint8Array = isBinarySequencePath(scope.path)
        ? bytes
        : Buffer.from(bytes).toString('utf8');
      let acceptedRevision: ScientificAcceptedDocumentRevision | undefined;
      const db = options.db();
      if (
        !isBinarySequencePath(scope.path) &&
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scientific_revision_records'"
          )
          .get()
      ) {
        const root = scope.recordedWorkspaceRoot ?? scope.workspaceRoot;
        const workspace = resolveMainWorkspaceIdentity(root, db);
        if (!workspace) throw new Error('The sequence project identity is unavailable.');
        const document = parseScientificDocumentIdentity(
          relative(
            workspaceMutationRootIdentity(root),
            workspaceMutationRootIdentity(scope.path)
          ).replace(/\\/g, '/')
        );
        const result = await readScientificDocumentInMain(
          {
            operationId: randomUUID(),
            workspaceRoot: root,
            workspace: parseWorkspaceIdentity(workspace),
            document,
          },
          { database: db }
        );
        scope.assertCurrent();
        if (!result.ok)
          throw Object.assign(new Error(result.error.message), { code: result.error.code });
        content = result.document.content;
        if (result.document.revision.kind === 'accepted-object') {
          acceptedRevision = result.document.revision;
          if (acceptedRevision.resourceId !== scope.documentId)
            throw new Error('The accepted sequence no longer matches its catalog identity.');
        }
      }
      const document = parseSequenceFileAsDocument(content, scope.path);
      return {
        sequence: { ...document.sequence, id: scope.documentId },
        sha256: hash(bytes),
        ...(acceptedRevision ? { acceptedRevision } : {}),
      };
    },
    async readSha256(path) {
      return hash(await readFileBoundedFromHandle(path, HARD_CAP_BYTES));
    },
    async save(input, scope, baselineSha256) {
      scope.assertCurrent();
      let fileSha256: string | undefined;
      const result = await saveSequenceDocumentWithLineage(input, {
        includeWriteReceipt: true,
        db: options.db(),
        readText: async (path) =>
          Buffer.from(await readFileBoundedFromHandle(path, HARD_CAP_BYTES)).toString('utf8'),
        resolve: async (id) => {
          if (id !== scope.documentId)
            throw new Error('The sequence binding changed before publication.');
          scope.assertCurrent();
          const current = await createNativeSequenceDocumentResolver({
            db: options.db,
            workspaceRoots: () => [scope.workspaceRoot],
          })({ operationId: 'native-sequence-captured-save', targetDocumentId: id });
          if (
            workspaceMutationRootIdentity(current.sourcePath) !== scope.path ||
            workspaceMutationRootIdentity(current.workspaceRoot) !== scope.workspaceRoot
          )
            throw new Error('The sequence binding changed before publication.');
          scope.assertCurrent();
          return current;
        },
        runDatabase: (operation) => {
          scope.assertCurrent();
          return operation();
        },
        expectedFileSha256: baselineSha256,
        assertCurrent: scope.assertIdentityCurrent ?? scope.assertCurrent,
        onPublished: (hash) => {
          fileSha256 = hash;
        },
      });
      if (result.status === 'accepted-pending') return { result };
      if (!fileSha256 && result.status === 'saved' && result.accepted) {
        const observed = hash(await readFileBoundedFromHandle(scope.path, HARD_CAP_BYTES));
        scope.assertCurrent();
        if (observed !== `sha256:${result.accepted.contentSha256}`)
          throw new NativeDocumentCommandError(
            'FILE_CHANGED',
            'Accepted sequence file delivery is not current.',
            true,
            [{ documentId: input.documentId, path: scope.path, ...result }]
          );
        fileSha256 = observed;
      }
      if (!fileSha256)
        throw new Error('The native sequence writer did not return its published digest.');
      return { result, fileSha256 };
    },
    async persistPendingPrimerBindings(capture, scope, fileSha256, receipt) {
      const primerPublicationIds: string[] = [];
      scope.assertCurrent();
      const db = options.db(),
        release = await acquireWorkspaceSyncDatabaseFence(db);
      let sequenceId: number;
      try {
        const assertCurrent = () => {
          assertWorkspaceSyncDatabaseFence(db, release);
          (scope.assertIdentityCurrent ?? scope.assertCurrent)();
        };
        assertCurrent();
        assertNativeSequenceContentWritable(db, scope.documentId, scope.workspaceRoot, release);
        const ownership = createPrimerBindingOwnershipStore(() =>
          createNativeCatalogDatabase(db, { assertCurrent })
        );
        if (
          capture.pendingPrimerBindings.length === 0 &&
          (await ownership.load(scope.documentId, capture.draftLineageId)).length === 0
        )
          return;
        const identities = createSequenceIdentityRepository({
          select: async <T>(
            sql: string,
            params: import('../shared/sqlite-ipc').SqliteIpcValue[] = []
          ) => db.prepare(sql).all(...params) as T,
          ensureSequenceIndex: async (input) => {
            assertCurrent();
            return ensureSequenceIndexInDb(db, input);
          },
        });
        sequenceId = await identities.ensureSequenceIdentity(
          scope.documentId,
          scope.path,
          capture.sequence.name ?? 'Sequence',
          capture.sequence.length,
          Boolean(capture.sequence.circular),
          scope.recordedWorkspaceRoot ?? scope.workspaceRoot
        );
      } finally {
        release();
      }
      await persistRichPastePrimerBindingsInMain(
        {
          bindings: capture.pendingPrimerBindings,
          draftLineageId: capture.draftLineageId,
          expectedFileSha256: fileSha256,
          targetDocumentId: scope.documentId,
          targetFilePath: scope.path,
          targetSequenceId: sequenceId,
          targetWorkspaceRoot: scope.recordedWorkspaceRoot ?? scope.workspaceRoot,
        },
        {
          db,
          workspaceRoots: () => [scope.workspaceRoot],
          assertCurrent: scope.assertIdentityCurrent ?? scope.assertCurrent,
          expectedTargetContentHash: fileSha256,
          sequenceSave: { receipt, onPublication: (id) => primerPublicationIds.push(id) },
        }
      );
      return primerPublicationIds;
    },
    async completeSave(scope, message, receipt) {
      scope.assertCurrent();
      const history = await commitSequenceDocumentHistory(
        { documentId: scope.documentId, sourcePath: scope.path, message, ...receipt },
        {
          db: options.db(),
          resolve: async (id) => {
            if (id !== scope.documentId) throw new Error('The captured History binding changed.');
            scope.assertCurrent();
            return { documentId: id, workspaceRoot: scope.workspaceRoot, sourcePath: scope.path };
          },
          assertCurrent: scope.assertCurrent,
        }
      );
      return {
        status:
          history.status === 'committed'
            ? 'committed'
            : history.status === 'already-committed' || history.status === 'not-a-repository'
              ? 'unchanged'
              : 'failed',
        historyStatus: history.status,
        nativeActionId: history.nativeActionId,
        ...(history.status === 'failed' ||
        history.status === 'unavailable' ||
        history.status === 'revision-changed'
          ? { error: 'The sequence bytes were saved; their History checkpoint needs attention.' }
          : {}),
      };
    },
    async loadRecord(id) {
      try {
        return JSON.parse(await readFile(recordPath(id), 'utf8')) as NativeSequenceRecord;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    storeRecord: (record) =>
      locks(record.documentId, async () => {
        const metadata = { documentId: record.documentId, path: record.path, dirty: record.dirty };
        if (record.dirty) await writeJson(metadataPath(record.documentId), metadata);
        await writeJson(recordPath(record.documentId), record);
        if (!record.dirty) await writeJson(metadataPath(record.documentId), metadata);
      }),
    async assertRecoveryClean(path) {
      const legacy = await currentLegacyMigration();
      if (!legacy)
        throw new Error(
          'LEGACY_SEQUENCE_DRAFT_MIGRATION_REQUIRED: Transfer the earlier sequence recovery records before changing project lifecycle.'
        );
      const canonical = workspaceMutationRootIdentity(path),
        canonicalPrefix = canonical.replace(/[\\/]+$/, '') + '/';
      for (const documentId of legacy.pendingIds) {
        const rows = options
          .db()
          .prepare("SELECT path FROM catalog_entity_files WHERE entity_id=? AND status='current'")
          .all(documentId) as Array<{ path: string }>;
        if (
          rows.some((row) => {
            const candidate = workspaceMutationRootIdentity(row.path);
            return candidate === canonical || candidate.startsWith(canonicalPrefix);
          })
        )
          throw new Error(
            'LEGACY_SEQUENCE_DRAFT_CONFLICT: A retained sequence draft protects this project from lifecycle changes.'
          );
      }
      const entries = await readdir(directory()).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const root = workspaceMutationRootIdentity(path),
        prefix = root.replace(/[\\/]+$/, '') + '/';
      for (const entry of entries) {
        if (!entry.endsWith('.identity.json')) continue;
        const identity = JSON.parse(await readFile(join(directory(), entry), 'utf8')) as {
          path: string;
          dirty: boolean;
        };
        const candidate = workspaceMutationRootIdentity(identity.path);
        if (identity.dirty && (candidate === root || candidate.startsWith(prefix)))
          throw new Error(
            'DIRTY_SEQUENCE_DRAFT: A retained sequence working copy must be resolved before moving or deleting its file.'
          );
      }
    },
  });
}
