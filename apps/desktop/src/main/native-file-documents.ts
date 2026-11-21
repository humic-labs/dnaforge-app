import { isForgePackageMetaPath } from '../shared/forge-package-path';
import { parseTablePackageHead } from '../shared/table-package';
import { publishTablePackageInMain, readTablePackageInMain } from './table-package';
import { writeWithBoundFileRetention } from './saved-file-publication';
import { resolveProjectFilePath } from '../shared/workspace-file-path';
import { inferCatalogFileKind } from '../shared/catalog-file-kind';
import { stageCatalogFileSource, withCatalogFileSource } from './catalog-file-source-retention';
import { assertCommittedDatabaseReadAllowed } from './workspace-sync-database-fence';
import { registerWorkspaceFileInDb } from './catalog-entity-registration';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { access, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';
import type Database from 'better-sqlite3';
import { NativeFileDocumentOwner, type NativeFileDocumentRecord } from './file-document-owner';
import { canonicalWorkspacePath } from './primer-artifact-files';
import {
  findKnownWorkspaceRoot,
  workspaceMutationRootIdentity,
  withKnownWorkspacePathMutation,
} from './workspace-sync-mutation-lease';
import { assertKnownWorkspaceContentWritable } from './workspace-content-write-access';
import { writeTextFileAtomicInMain } from './text-file-atomic';
import { syncDirectory } from './fs-durability';
import { createKeyedMutex } from './workspace-git/keyed-mutex';

export function createNativeFileDocuments(options: {
  db(): Database.Database;
  workspaceRoots(): readonly string[];
  writableWorkspaceRoots?(): readonly string[];
  profileDirectory(): string;
  captureWorkspace?(root: string, mutating: boolean): () => void;
}): NativeFileDocumentOwner {
  const records = createKeyedMutex();
  const recordPath = (path: string) =>
    join(
      options.profileDirectory(),
      'file-document-drafts',
      `${createHash('sha256').update(path).digest('hex')}.json`
    );
  const identityPath = (documentId: string) => {
    if (
      !/^file-document:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        documentId
      )
    ) {
      if (!documentId.trim() || /[\\/]/.test(documentId) || documentId.length > 512)
        throw new Error('Invalid native file identity.');
      return join(
        options.profileDirectory(),
        'file-document-identities',
        `catalog-${createHash('sha256').update(documentId).digest('hex')}.json`
      );
    }
    return join(
      options.profileDirectory(),
      'file-document-identities',
      documentId.slice(14) + '.json'
    );
  };
  const resolveIdentity = async (documentId: string): Promise<string | undefined> => {
    try {
      const record: unknown = JSON.parse(await readFile(identityPath(documentId), 'utf8'));
      if (
        !record ||
        typeof record !== 'object' ||
        !('documentId' in record) ||
        record.documentId !== documentId ||
        !('path' in record) ||
        typeof record.path !== 'string'
      )
        throw new Error('The native file identity is invalid.');
      return record.path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const identityRecords = async () => {
    const directory = join(options.profileDirectory(), 'file-document-identities');
    const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const result: Array<{ documentId: string; path: string; dirty: boolean }> = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const record: unknown = JSON.parse(await readFile(join(directory, entry), 'utf8'));
      if (
        !record ||
        typeof record !== 'object' ||
        !('documentId' in record) ||
        typeof record.documentId !== 'string' ||
        !('path' in record) ||
        typeof record.path !== 'string' ||
        !('dirty' in record) ||
        typeof record.dirty !== 'boolean'
      )
        throw new Error('The native file identity is invalid.');
      identityPath(record.documentId);
      result.push({ documentId: record.documentId, path: record.path, dirty: record.dirty });
    }
    return result;
  };
  const publishIdentity = async (
    record: Pick<NativeFileDocumentRecord, 'documentId' | 'path' | 'dirty'>
  ) => {
    const directory = join(options.profileDirectory(), 'file-document-identities');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = identityPath(record.documentId),
      temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(
        JSON.stringify({ documentId: record.documentId, path: record.path, dirty: record.dirty }),
        'utf8'
      );
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, path);
      await syncDirectory(directory);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  };
  const storeRecord = (record: NativeFileDocumentRecord) =>
    records(record.documentId, async () => {
      if (record.dirty) await publishIdentity(record);
      const directory = join(options.profileDirectory(), 'file-document-drafts');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = recordPath(record.path),
        temporary = `${path}.${randomUUID()}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(record), 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await rename(temporary, path);
        await syncDirectory(directory);
        if (!record.dirty) await publishIdentity(record);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    });
  let migrationState: { pendingPaths: readonly string[] } | undefined;
  let finishMigration: (() => void) | undefined;
  let migrationRunning = false;
  let migrationFinished = new Promise<void>((resolve) => {
    finishMigration = resolve;
  });
  const migrationPath = () =>
    join(options.profileDirectory(), 'file-document-drafts', 'legacy-migration-v1.json');
  const currentMigration = async () => {
    if (migrationRunning) return undefined;
    if (migrationState) return migrationState;
    try {
      const input: unknown = JSON.parse(await readFile(migrationPath(), 'utf8'));
      if (
        !input ||
        typeof input !== 'object' ||
        !('complete' in input) ||
        input.complete !== true ||
        !('pendingPaths' in input) ||
        !Array.isArray(input.pendingPaths) ||
        input.pendingPaths.some((path) => typeof path !== 'string')
      )
        throw new Error('The legacy file recovery migration record is invalid.');
      migrationState = { pendingPaths: input.pendingPaths as string[] };
      return migrationState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await access(join(options.profileDirectory(), 'IndexedDB'));
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      migrationState = { pendingPaths: [] };
      return migrationState;
    }
  };
  const waitForMigration = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        migrationFinished,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  'LEGACY_FILE_DRAFT_MIGRATION_REQUIRED: Native recovery is waiting for the legacy draft transfer.'
                )
              ),
            10000
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return new NativeFileDocumentOwner({
    normalizePath: workspaceMutationRootIdentity,
    beginLegacyMigration() {
      if (migrationRunning) return;
      migrationRunning = true;
      migrationFinished = new Promise<void>((resolve) => {
        finishMigration = resolve;
      });
    },
    async beforeExecute(path, client) {
      let state = await currentMigration();
      if (!state && client === 'renderer') {
        await waitForMigration();
        state = await currentMigration();
      }
      if (!state)
        throw new Error(
          'LEGACY_FILE_DRAFT_MIGRATION_REQUIRED: Start the desktop once to transfer its earlier file recovery records.'
        );
      if (
        state.pendingPaths.some(
          (candidate) =>
            workspaceMutationRootIdentity(candidate) === workspaceMutationRootIdentity(path)
        )
      )
        throw new Error(
          'LEGACY_FILE_DRAFT_CONFLICT: An earlier draft for this file remains preserved and needs recovery.'
        );
    },
    async completeLegacyMigration(pendingPaths) {
      if (
        pendingPaths.length > 10000 ||
        pendingPaths.some((path) => typeof path !== 'string' || !isAbsolute(path))
      )
        throw new Error('Invalid legacy file migration results.');
      const directory = join(options.profileDirectory(), 'file-document-drafts');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = migrationPath(),
        temporary = `${path}.${randomUUID()}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify({ version: 1, complete: true, pendingPaths }), 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      await syncDirectory(directory);
      migrationState = { pendingPaths: [...pendingPaths] };
      migrationRunning = false;
      finishMigration?.();
    },
    resolveIdentity,
    async retireReboundIdentity({ path, previousDocumentId, documentId }) {
      const previousPath = identityPath(previousDocumentId);
      let previous: unknown;
      try {
        previous = JSON.parse(await readFile(previousPath, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (
        !previous ||
        typeof previous !== 'object' ||
        !('path' in previous) ||
        previous.path !== path ||
        !('documentId' in previous) ||
        previous.documentId !== previousDocumentId ||
        !('dirty' in previous) ||
        previous.dirty !== false
      )
        throw new Error('The prior pending table identity is not a clean matching native binding.');
      const current = JSON.parse(
        await readFile(recordPath(path), 'utf8')
      ) as NativeFileDocumentRecord;
      if (
        current.documentId !== documentId ||
        current.path !== path ||
        current.dirty ||
        !isForgePackageMetaPath(path, 'table.json')
      )
        throw new Error('The active native table binding was not durably recorded.');
      await rm(previousPath);
      await syncDirectory(dirname(previousPath));
    },
    async listRetainedDirty() {
      return (await identityRecords()).filter(
        (record) =>
          record.dirty &&
          options.workspaceRoots().some((root) => {
            const parent = workspaceMutationRootIdentity(root),
              path = workspaceMutationRootIdentity(record.path);
            return path === parent || path.startsWith(parent.replace(/[\\/]+$/, '') + '/');
          })
      );
    },
    async rootRelinkBlocker(rootPath) {
      const root = workspaceMutationRootIdentity(rootPath),
        prefix = root.replace(/[\\/]+$/, '') + '/';
      const current = options
        .db()
        .prepare(
          "SELECT f.path FROM catalog_entity_files f JOIN catalog_entities e ON e.id=f.entity_id WHERE f.entity_id=? AND f.status='current' AND e.status='active' AND e.type='file' LIMIT 2"
        );
      for (const identity of await identityRecords()) {
        const path = workspaceMutationRootIdentity(identity.path);
        if (path !== root && !path.startsWith(prefix)) continue;
        const bindings = current.all(identity.documentId) as Array<{ path: string }>;
        if (bindings.length !== 1 || workspaceMutationRootIdentity(bindings[0].path) !== path)
          return 'unbound-file-document';
      }
      return null;
    },
    async identityForPath(path) {
      const db = options.db(),
        root = findKnownWorkspaceRoot(db, path);
      const owner = root
        ? (
            db
              .prepare(
                'SELECT id,path,repo_uuid FROM workspaces WHERE path IS NOT NULL AND archived_at IS NULL AND trashed_at IS NULL'
              )
              .all() as Array<{ id:number; path: string; repo_uuid: string | null }>
          ).find((row) => workspaceMutationRootIdentity(row.path) === root)
        : undefined;
      const storedPath = owner && root ? join(owner.path, relative(root, path)) : path;
      const rows = db
        .prepare(
          "SELECT e.id FROM catalog_entity_files f JOIN catalog_entities e ON e.id=f.entity_id WHERE f.status='current' AND e.status='active' AND e.type='file' AND (f.path=? OR f.path=?) LIMIT 2"
        )
        .all(path, storedPath) as Array<{ id: string }>;
      if (rows.length > 1)
        throw new Error('AMBIGUOUS_FILE_DOCUMENT: Multiple catalog identities claim this file.');
      const retained = (await identityRecords()).find((record) => record.path === path);
      let documentId = rows[0]?.id ?? retained?.documentId;
      if (!documentId && owner?.repo_uuid) {
        const input = {
          path: storedPath,
          workspaceRoot: owner.path,
          entityType: 'file',
          fileKind: inferCatalogFileKind(storedPath),
        } as const;
        const assertCurrent = options.captureWorkspace?.(owner.path, false) ?? (() => assertCommittedDatabaseReadAllowed(db));
        const row = await withCatalogFileSource(
          db, input, () => registerWorkspaceFileInDb(db, input), (result) => result.id, assertCurrent
        );
        documentId = row.id;
      }
      documentId ??= `file-document:${randomUUID()}`;
      const workspaceId = owner?.id ?? null;
      if (!db.prepare("SELECT 1 FROM retained_file_source_revisions WHERE workspace_id IS ? AND entity_id=? AND status='committed' LIMIT 1").get(workspaceId, documentId)) {
        const assertCurrent = (owner && options.captureWorkspace?.(owner.path, false)) ?? (() => assertCommittedDatabaseReadAllowed(db));
        const stage = await stageCatalogFileSource(db,{path:storedPath,workspaceRoot:owner?.path},assertCurrent);
        assertCurrent();
        stage?.({workspaceId,entityId:documentId});
      }
      await publishIdentity({ documentId, path, dirty: false });
      return documentId;
    },
    async relocateRecords(sourcePath, destinationPath, loadedIds) {
      const source = workspaceMutationRootIdentity(sourcePath),
        destination = workspaceMutationRootIdentity(destinationPath);
      const prefix = source.replace(/[\\/]+$/, '') + '/';
      const moved: Array<{ documentId: string; path: string }> = [];
      for (const identity of await identityRecords()) {
        const path = workspaceMutationRootIdentity(identity.path);
        if (loadedIds.has(identity.documentId) || (path !== source && !path.startsWith(prefix)))
          continue;
        if (identity.dirty)
          throw new Error('DIRTY_FILE_DRAFT: A retained draft cannot be rebound by a file move.');
        const record = JSON.parse(
          await readFile(recordPath(identity.path), 'utf8')
        ) as NativeFileDocumentRecord;
        if (
          record.version !== 1 ||
          record.documentId !== identity.documentId ||
          record.path !== identity.path ||
          record.dirty
        )
          throw new Error(
            'The native file recovery record does not match its relocation identity.'
          );
        const next = {
          ...record,
          path: destination + path.slice(source.length),
          revision: (record.revision ?? 1) + 1,
        };
        await storeRecord(next);
        moved.push({ documentId: identity.documentId, path: next.path });
      }
      return moved;
    },
    async assertRecoveryClean(path) {
      let legacy = await currentMigration();
      if (!legacy && migrationRunning) {
        await waitForMigration();
        legacy = await currentMigration();
      }
      const canonical = workspaceMutationRootIdentity(path);
      if (
        !legacy ||
        legacy.pendingPaths.some((candidate) => {
          const pending = workspaceMutationRootIdentity(candidate);
          return (
            pending === canonical || pending.startsWith(canonical.replace(/[\\/]+$/, '') + '/')
          );
        })
      )
        throw new Error(
          'LEGACY_FILE_DRAFT_MIGRATION_REQUIRED: Resolve the earlier file recovery records before moving or deleting this file or project.'
        );
      const prefix = canonical.replace(/[\\/]+$/, '') + '/';
      for (const record of await identityRecords()) {
        const candidate = workspaceMutationRootIdentity(record.path);
        if (record.dirty && (candidate === canonical || candidate.startsWith(prefix)))
          throw new Error(
            'DIRTY_FILE_DRAFT: Resolve the retained native file draft before moving or deleting its file.'
          );
      }
    },
    async admit(path, requestedRoot, mutating) {
      const db = options.db();
      const enrolledProjects = (
        db
          .prepare(
            'SELECT path,name,access_mode FROM workspaces WHERE path IS NOT NULL AND archived_at IS NULL AND trashed_at IS NULL'
          )
          .all() as Array<{ path: string; name: string | null; access_mode: string }>
      )
        .filter((row) =>
          options
            .workspaceRoots()
            .some(
              (candidate) =>
                workspaceMutationRootIdentity(candidate) === workspaceMutationRootIdentity(row.path)
            )
        )
        .map((row) => ({
          ...row,
          path: workspaceMutationRootIdentity(row.path),
          name: row.name ?? basename(row.path),
          pinned: !(options.writableWorkspaceRoots?.() ?? options.workspaceRoots()).some(
            (candidate) =>
              workspaceMutationRootIdentity(candidate) === workspaceMutationRootIdentity(row.path)
          ),
        }));
      let eligible = enrolledProjects;
      const selectedRoot = requestedRoot;
      if (selectedRoot) {
        eligible = enrolledProjects.filter((project) =>
          isAbsolute(selectedRoot)
            ? project.path === workspaceMutationRootIdentity(selectedRoot)
            : project.name.toLocaleLowerCase() === selectedRoot.toLocaleLowerCase()
        );
        if (eligible.length !== 1)
          throw new Error('OUTSIDE_WORKSPACE: Choose one exact admitted project.');
      }
      const lexical = resolveProjectFilePath(
        eligible.map((project) => (requestedRoot ? { ...project, pinned: false } : project)),
        path
      );
      const lexicalTable = isForgePackageMetaPath(lexical.absolutePath, 'table.json')
        ? lexical
        : null;
      const assertTableProvenance = () => {
        if (!lexicalTable) return;
        let current = lexicalTable.folder.path;
        const parts = relative(current, lexicalTable.absolutePath).split(/[\\/]/);
        for (const [index, part] of ['', ...parts].entries()) {
          if (part) current = join(current, part);
          const entry = lstatSync(current);
          if (
            entry.isSymbolicLink() ||
            (index === parts.length ? !entry.isFile() : !entry.isDirectory())
          )
            throw new Error('Table package paths must be physical files without symbolic links.');
        }
      };
      assertTableProvenance();
      const normalizedInput = isAbsolute(path) ? workspaceMutationRootIdentity(path) : path;
      const resolved = resolveProjectFilePath(
        eligible.map((project) => (requestedRoot ? { ...project, pinned: false } : project)),
        normalizedInput
      );
      path = resolved.absolutePath;
      requestedRoot = resolved.folder.path;
      const root = findKnownWorkspaceRoot(db, path);
      if (!root)
        throw new Error('OUTSIDE_WORKSPACE: This file belongs to no current native project.');
      const owners = (
        db
          .prepare(
            'SELECT path, access_mode FROM workspaces WHERE path IS NOT NULL AND archived_at IS NULL AND trashed_at IS NULL'
          )
          .all() as Array<{ path: string; access_mode: string }>
      ).filter((row) => workspaceMutationRootIdentity(row.path) === root);
      if (owners.length !== 1)
        throw new Error('OUTSIDE_WORKSPACE: The file has no unique active owning project.');
      const storedRoot = owners[0].path;
      const boundPath = join(storedRoot, relative(root, workspaceMutationRootIdentity(path)));
      const canonical = await canonicalWorkspacePath({
        workspaceRoot: storedRoot,
        path: boundPath,
        artifactNoun: 'editable file',
      });
      if (requestedRoot && workspaceMutationRootIdentity(requestedRoot) !== canonical.root)
        throw new Error('OUTSIDE_WORKSPACE: The requested project does not own this file.');
      const enrolled = () =>
        options
          .workspaceRoots()
          .some((candidate) => workspaceMutationRootIdentity(candidate) === root);
      if (!enrolled())
        throw new Error(
          'OUTSIDE_WORKSPACE: The project is not enrolled with the native document owner.'
        );
      const assertEnrollment =
        options.captureWorkspace?.(canonical.root, mutating) ??
        (() => {
          if (!enrolled())
            throw new Error('The document workspace enrollment changed before publication.');
        });
      const member = relative(canonical.root, canonical.candidate);
      const protectedParts = ['..', '.git', '.forge', '.dnaforge', '.waypoint'];
      const parts = member.split(/[\\/]/).map((part) => part.toLowerCase());
      const tableHead =
        isForgePackageMetaPath(member, 'table.json') &&
        !parts.slice(0, -2).some((part) => protectedParts.includes(part));
      if (
        !member ||
        isAbsolute(member) ||
        (!tableHead && parts.some((part) => protectedParts.includes(part)))
      )
        throw new Error(
          'INTERNAL_PROJECT_PATH: Native project metadata is not an editable ordinary file.'
        );
      const writableEnrolled = () =>
        (options.writableWorkspaceRoots?.() ?? options.workspaceRoots()).some(
          (candidate) => workspaceMutationRootIdentity(candidate) === root
        );
      let readOnly =
        /\.entity\.json$/i.test(canonical.candidate) ||
        owners[0].access_mode !== 'writable' ||
        !writableEnrolled();
      try {
        assertKnownWorkspaceContentWritable(db, storedRoot);
      } catch {
        readOnly = true;
      }
      const assertCurrent = () => {
        assertTableProvenance();
        assertEnrollment();
        if (findKnownWorkspaceRoot(options.db(), canonical.candidate) !== root || !enrolled())
          throw new Error('The owning project changed before the file command completed.');
        if (mutating) {
          if (!writableEnrolled())
            throw new Error('READ_ONLY_FILE: This project is enrolled for reading only.');
          assertKnownWorkspaceContentWritable(options.db(), storedRoot);
        }
      };
      assertCurrent();
      return {
        path: canonical.candidate,
        workspaceRoot: storedRoot,
        readOnly,
        assertCurrent,
      };
    },
    async read(path, maximumBytes) {
      const file = await open(path, 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new Error('UNSUPPORTED_FILE: Choose a physical ordinary file.');
        const bytes = Buffer.alloc(Math.min(stat.size, maximumBytes));
        let offset = 0;
        while (offset < bytes.length) {
          const read = await file.read(bytes, offset, bytes.length - offset, offset);
          if (read.bytesRead === 0) break;
          offset += read.bytesRead;
        }
        const after = await file.stat();
        if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || offset !== bytes.length)
          throw new Error('FILE_CHANGED: The file changed during loading.');
        return bytes;
      } finally {
        await file.close();
      }
    },
    async verifyTablePackage(admission, content) {
      const verified = await readTablePackageInMain({
        workspaceRoot: admission.workspaceRoot,
        packageRoot: dirname(dirname(admission.path)),
      });
      admission.assertCurrent();
      if (
        workspaceMutationRootIdentity(verified.headPath) !==
          workspaceMutationRootIdentity(admission.path) ||
        verified.headText !== content
      )
        throw new Error('FILE_CHANGED: The table package changed while it was inspected.');
    },
    async write(input, admission, documentId) {
      await withKnownWorkspacePathMutation(options.db(), [input.path], async () => {
        admission.assertCurrent();
        if (isForgePackageMetaPath(input.path, 'table.json')) {
          await publishTablePackageInMain(
            {
              workspaceRoot: admission.workspaceRoot,
              packageRoot: dirname(dirname(input.path)),
              head: parseTablePackageHead(input.content),
              mode: 'replace',
              expectedContentHash: input.expectedContentHash?.replace(/^sha256:/, ''),
            },
            { assertCurrent: admission.assertCurrent, db: options.db() }
          );
          return;
        }
        await writeWithBoundFileRetention(
          options.db(),
          { ...input, documentId, workspaceRoot:findKnownWorkspaceRoot(options.db(),input.path)??undefined,expectedSha256:input.expectedContentHash,blobRoot: join(options.profileDirectory(), 'retained-file-blobs') },
          (mark) => writeTextFileAtomicInMain(input, { beforePublish: staged=>{admission.assertCurrent();mark(staged);} })
        );
      });
    },
    async loadRecord(path) {
      try {
        const raw: unknown = JSON.parse(await readFile(recordPath(path), 'utf8'));
        if (
          raw === null ||
          typeof raw !== 'object' ||
          !('version' in raw) ||
          raw.version !== 1 ||
          !('path' in raw) ||
          raw.path !== path ||
          !('documentId' in raw) ||
          typeof raw.documentId !== 'string' ||
          !('baseline' in raw) ||
          typeof raw.baseline !== 'string' ||
          !('content' in raw) ||
          typeof raw.content !== 'string' ||
          !('dirty' in raw) ||
          typeof raw.dirty !== 'boolean'
        )
          throw new Error('The native file recovery record is invalid.');
        const record = raw as NativeFileDocumentRecord;
        const currentPath = await resolveIdentity(record.documentId);
        return currentPath && currentPath !== path ? undefined : record;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    storeRecord,
  });
}
