import { createNotebookConflictRecovery } from './notebook-conflict-recovery';
import { createNotebookResourceReferences } from './notebook-resource-references';
import type { RegisteredProjectAuthority } from './registered-project-authority';
import { prepareNotebookReferenceInsertion } from './notebook-reference-insertion';
import { resolvePortablePrimerReferencePath } from '../shared/primer-reference-path';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type Database from 'better-sqlite3';
import {
  NativeNotebookWorkingCopyOwner,
  type NativeNotebookRecord,
  type NativeNotebookScope,
  type NativeNotebookSource,
} from './notebook-document-owner';
import { readCanonicalNotebookPackage } from '../db/notebook-package-migration';
import { notebookPackagePaths, parseNotebookPackageDocument } from '../db/notebook-package';
import { contentFingerprint } from '../shared/content-fingerprint';
import { canonicalNotebookJson } from '../db/notebook-markdown-codec';
import {
  stripWorkspaceScope,
  scopedProjectionId,
  workspaceScopeKey,
} from '../shared/workspace-scoped-identity';
import { canonicalWorkspacePath } from './primer-artifact-files';
import {
  publishNotebookPackageV2InMain,
  prepareNotebookPackageRenameInMain,
  recoverNotebookPackageRenameIfNeededInMain,
} from './notebook-package-authority';
import {
  workspaceMutationRootIdentity,
  findKnownWorkspaceRoot,
  withKnownWorkspacePathMutation,
} from './workspace-sync-mutation-lease';
import { assertKnownWorkspaceContentWritable } from './workspace-content-write-access';
import { createNativeCatalogRepository } from './native-catalog-repository';
import { bindCatalogEntityFileInDb } from './catalog-file-binding';
import { syncDirectory } from './fs-durability';
import { createConfiguredTableBlock } from '../shared/notebook-model/table/configuration';
import { structureFileSource } from '../shared/notebook-model/structure-file-source';
import { IMAGE_CONSTANTS } from '../shared/notebook-model/image-types';
import { NativeDocumentCommandError } from '../shared/native-document-error';
import { notebookProjectionFingerprint } from '../shared/notebook-projection';
import {
  readNotebookPublicationInDb,
  settleNotebookPublicationInMain,
} from './notebook-publication';
import { NotebookDocumentModel } from '../shared/notebook-model/document';
import {
  createArtifactCreatedProjectMemoryEvent,
  createArtifactRenamedProjectMemoryEvent,
} from '../db/project-memory-owner';
import { appendProjectMemoryEventInMain } from './project-memory';
import { runWorkspaceFileTrash } from './workspace-file-trash';
import { MolecularDocumentLibrary } from './molecular-document-library';
import {
  MOLECULAR_DOCUMENT_SUFFIX,
  getCurrentMolecularSnapshot,
} from '../shared/molecular-document';
import {
  molecularDocumentReferenceFor,
  molecularDocumentReferenceHref,
} from '../shared/molecular-document-reference';
import { notebookReferenceFromHref } from '../shared/notebook-reference-normalization';
import type {
  RelocateEntityFileInput,
  RelocateEntityFileResult,
} from '../shared/workspace-relocate-types';

export function createNativeNotebookWorkingCopies(options: {
  db(): Database.Database;
  workspaceRoots(): readonly string[];
  writableWorkspaceRoots(): readonly string[];
  profileDirectory(): string;
  captureWorkspace(root: string, mutating: boolean): () => void;
  relocateEntityFile(input: RelocateEntityFileInput): Promise<RelocateEntityFileResult>;
  registeredProjects?: RegisteredProjectAuthority;
}): NativeNotebookWorkingCopyOwner {
  const resourceReferences = createNotebookResourceReferences(options);
  const legacyFingerprint = (content: unknown) => {
    const text = JSON.stringify(content);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return `${text.length}:${(hash >>> 0).toString(16)}`;
  };
  const directory = () => join(options.profileDirectory(), 'notebook-working-copies');
  const recordPath = (id: string) =>
    join(directory(), createHash('sha256').update(id).digest('hex') + '.json');
  const identityPath = (id: string) =>
    join(directory(), createHash('sha256').update(id).digest('hex') + '.identity.json');
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
  const under = (path: string, root: string) => {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  const resolveDocument = async (id: string, mutating: boolean): Promise<NativeNotebookScope> => {
    const rows = options
      .db()
      .prepare(
        "SELECT e.id,f.id AS bindingId,f.object_uuid AS objectUuid,f.path,w.id AS workspaceId,w.repo_uuid AS workspaceScope,w.path AS root,w.access_mode FROM catalog_entities e JOIN catalog_entity_files f ON f.entity_id=e.id JOIN workspaces w ON w.id=f.workspace_id WHERE e.id=? AND e.workspace_id=f.workspace_id AND e.type IN ('notebook','page') AND e.status='active' AND f.status='current' AND w.archived_at IS NULL AND w.trashed_at IS NULL LIMIT 2"
      )
      .all(id) as Array<{
      id: string;
      path: string;
      root: string;
      access_mode: string;
      bindingId: string;
      objectUuid: string | null;
      workspaceId: number;
      workspaceScope: string | null;
    }>;
    if (rows.length !== 1)
      throw new NativeDocumentCommandError(
        'NOTEBOOK_NOT_FOUND',
        'The notebook has no unique active native package.',
        false
      );
    const row = rows[0],
      root = workspaceMutationRootIdentity(row.root),
      canonical = await canonicalWorkspacePath({
        workspaceRoot: root,
        path: row.path,
        allowMissing: false,
        artifactNoun: 'notebook package',
      });
    const currentPath = workspaceMutationRootIdentity(canonical.candidate);
    const member = relative(root, currentPath);
    if (
      !member ||
      member
        .split(/[\\/]/)
        .some((part) => ['..', '.git', '.forge', '.dnaforge', '.waypoint'].includes(part))
    )
      throw new NativeDocumentCommandError(
        'INTERNAL_PROJECT_PATH',
        'Internal project metadata is not a notebook target.',
        false
      );
    const assertEnrollment = options.captureWorkspace(root, mutating);
    const writable = () =>
      options
        .writableWorkspaceRoots()
        .some((candidate) => workspaceMutationRootIdentity(candidate) === root);
    let readOnly = row.access_mode !== 'writable' || !writable();
    try {
      assertKnownWorkspaceContentWritable(options.db(), row.root);
    } catch {
      readOnly = true;
    }
    const assertCapturedBinding = () => {
      const current = options
        .db()
        .prepare(
          "SELECT f.id AS bindingId,f.object_uuid AS objectUuid,f.path,w.id AS workspaceId,w.repo_uuid AS workspaceScope,w.path AS root FROM catalog_entities e JOIN catalog_entity_files f ON f.entity_id=e.id JOIN workspaces w ON w.id=f.workspace_id WHERE e.id=? AND e.workspace_id=f.workspace_id AND e.type IN ('notebook','page') AND e.status='active' AND f.status='current' AND w.archived_at IS NULL AND w.trashed_at IS NULL LIMIT 2"
        )
        .all(id) as Array<{
        path: string;
        root: string;
        bindingId: string;
        objectUuid: string | null;
        workspaceId: number;
        workspaceScope: string | null;
      }>;
      if (
        findKnownWorkspaceRoot(options.db(), currentPath) !== root ||
        current.length !== 1 ||
        current[0].bindingId !== row.bindingId ||
        current[0].objectUuid !== row.objectUuid ||
        current[0].workspaceId !== row.workspaceId ||
        current[0].workspaceScope !== row.workspaceScope ||
        workspaceMutationRootIdentity(current[0].root) !== root ||
        workspaceMutationRootIdentity(current[0].path) !== currentPath
      )
        throw new NativeDocumentCommandError(
          'NOTEBOOK_BINDING_CHANGED',
          'The notebook package identity changed.',
          false
        );
    };
    const assertCurrent = () => {
      assertEnrollment();
      if (
        !options
          .workspaceRoots()
          .some((candidate) => workspaceMutationRootIdentity(candidate) === root)
      )
        throw new NativeDocumentCommandError(
          'OUTSIDE_WORKSPACE',
          'This notebook project is no longer enrolled.',
          false
        );
      assertCapturedBinding();
      if (mutating) {
        if (!writable())
          throw new NativeDocumentCommandError(
            'NOTEBOOK_READ_ONLY',
            'The notebook project is enrolled for reading only.',
            false
          );
        assertKnownWorkspaceContentWritable(options.db(), row.root);
      }
    };
    assertCurrent();
    const sourceScope = workspaceScopeKey(row.workspaceScope, row.workspaceId)!;
    return {
      documentId: id,
      path: currentPath,
      workspaceRoot: root,
      readOnly,
      assertCurrent,
      assertCapturedBinding,
      ...(row.objectUuid
        ? {
            sourceIdentity: {
              projectId: sourceScope,
              workspaceScope: sourceScope,
              fileObjectUuid: row.objectUuid,
            },
          }
        : {}),
    };
  };
  const load = async (scope: NativeNotebookScope): Promise<NativeNotebookSource> => {
    const reads = new Map<string, string>(),
      missing = new Set<string>(),
      canonicalMembers = new Map<string, string>();
    const safe = async (path: string) => {
      const member = await canonicalWorkspacePath({
        workspaceRoot: scope.workspaceRoot,
        path,
        allowMissing: true,
        artifactNoun: 'notebook member',
      });
      if (!under(member.candidate, scope.path))
        throw new Error('A notebook member escaped its package.');
      scope.assertCurrent();
      canonicalMembers.set(path, member.candidate);
      return member.candidate;
    };
    const read = async (path: string) => {
      const value = await readFile(await safe(path), 'utf8');
      reads.set(path, value);
      return value;
    };
    const legacy = scope.path.toLowerCase().endsWith('.wpnote.json');
    const metadataRaw = await read(legacy ? scope.path : notebookPackagePaths(scope.path).metaPath);
    const metadata: unknown = JSON.parse(metadataRaw);
    if (legacy || (metadata && typeof metadata === 'object' && !('formatVersion' in metadata))) {
      const document = parseNotebookPackageDocument(metadataRaw);
      if (stripWorkspaceScope(document.id) !== stripWorkspaceScope(scope.documentId))
        throw new Error('The legacy notebook belongs to another identity.');
      scope.assertCurrent();
      return {
        content: new NotebookDocumentModel(
          document.content as import('@tiptap/core').JSONContent,
          document.title
        ).content,
        title: document.title,
        updatedAt: document.updatedAt,
        sizeBytes: Buffer.byteLength(metadataRaw),
        legacyBaselines: [
          legacyFingerprint(document.content),
          legacyFingerprint(
            new NotebookDocumentModel(
              document.content as import('@tiptap/core').JSONContent,
              document.title
            ).content
          ),
        ],
        fingerprint: contentFingerprint(metadataRaw),
        metadataRaw,
        preservedPreamble: '',
        preservedTitleProjection: { kind: 'missing-heading', source: '', lineEnding: '\n' },
        sourceShape: legacy ? 'legacy-wpnote' : 'v1-package',
      };
    }
    const result = await readCanonicalNotebookPackage(
      {
        readTextFile: read,
        exists: async (path) => {
          try {
            await access(await safe(path));
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              missing.add(path);
              return false;
            }
            throw error;
          }
        },
      },
      scope.path,
      metadataRaw
    );
    if (stripWorkspaceScope(scope.documentId) !== stripWorkspaceScope(result.metadata.id))
      throw new Error('The notebook package belongs to another identity.');
    for (const [path, value] of reads)
      if ((await readFile(await safe(path), 'utf8')) !== value)
        throw new Error('The notebook package changed while loading.');
    for (const path of missing) {
      try {
        await access(await safe(path));
        throw new Error('The notebook package changed while loading.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    scope.assertCurrent();
    return {
      content: new NotebookDocumentModel(result.parsed.content, result.parsed.title).content,
      title: result.parsed.title,
      updatedAt: result.metadata.updatedAt,
      sizeBytes: Buffer.byteLength(result.markdown),
      legacyBaselines: [
        legacyFingerprint(result.parsed.content),
        legacyFingerprint(
          new NotebookDocumentModel(result.parsed.content, result.parsed.title).content
        ),
      ],
      fingerprint: contentFingerprint(result.markdown),
      metadataRaw,
      preservedPreamble: result.parsed.preservedPreamble,
      preservedTitleProjection: result.parsed.preservedTitleProjection,
      sourceShape: 'v2-package',
      assertSourceCurrentSync() {
        scope.assertCapturedBinding!();
        for (const [path, bytes] of reads) {
          const canonical = canonicalMembers.get(path)!;
          if (
            realpathSync(path) !== canonical ||
            !lstatSync(canonical).isFile() ||
            readFileSync(canonical, 'utf8') !== bytes
          )
            throw new Error('The saved notebook source changed before scientific work committed.');
        }
        for (const path of missing) {
          try {
            lstatSync(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
          }
          throw new Error('The saved notebook source changed before scientific work committed.');
        }
        if (
          readNotebookPublicationInDb(options.db(), {
            ...scope,
            title: result.parsed.title,
            content: result.parsed.content,
            canonicalFingerprint: contentFingerprint(result.markdown),
          }).status !== 'settled'
        )
          throw new Error(
            'The saved notebook publication changed before scientific work committed.'
          );
      },
      publication: readNotebookPublicationInDb(options.db(), {
        ...scope,
        title: result.parsed.title,
        content: result.parsed.content,
        canonicalFingerprint: contentFingerprint(result.markdown),
      }),
    };
  };
  const publishProjection = async (
    scope: NativeNotebookScope,
    source: Pick<NativeNotebookSource, 'title' | 'content'>
  ) => {
    scope.assertCurrent();
    const db = options.db();
    const bindings = db
      .prepare(
        "SELECT f.path,w.path AS root FROM catalog_entity_files f JOIN workspaces w ON w.id=f.workspace_id WHERE f.entity_id=? AND f.status='current' LIMIT 2"
      )
      .all(scope.documentId) as Array<{ path: string; root: string }>;
    if (bindings.length !== 1)
      throw new Error('The notebook projection requires one current project file.');
    const current = db
      .prepare('SELECT title,content FROM pages WHERE id=?')
      .get(scope.documentId) as { title: string; content: string } | undefined;
    await settleNotebookPublicationInMain(db, {
      pageId: scope.documentId,
      workspaceRoot: bindings[0].root,
      sourcePath: notebookPackagePaths(bindings[0].path).metaPath,
      sourceFingerprint: notebookProjectionFingerprint(source.title, source.content),
      expectedProjectionFingerprint: current
        ? notebookProjectionFingerprint(current.title, current.content)
        : null,
    });
    scope.assertCurrent();
  };
  const catalog = (assertCurrent: () => void) =>
    createNativeCatalogRepository(options.db(), {
      assertCurrent,
      withMutation: async (_root, operation) => operation(undefined),
    });
  const projectRows = () =>
    options
      .db()
      .prepare(
        "SELECT id,name,path,repo_uuid FROM workspaces WHERE archived_at IS NULL AND trashed_at IS NULL AND access_mode='writable'"
      )
      .all() as Array<{ id: number; name: string; path: string; repo_uuid: string | null }>;
  const currentProjects = () =>
    projectRows().filter((row) =>
      options
        .writableWorkspaceRoots()
        .some(
          (root) => workspaceMutationRootIdentity(root) === workspaceMutationRootIdentity(row.path)
        )
    );
  const sourceFile = async (root: string, path: string) => {
    const input = isAbsolute(path) ? path : join(root, path),
      member = relative(root, input);
    if (
      !member ||
      member
        .split(/[\\/]/)
        .some((part) => ['..', '.git', '.forge', '.dnaforge', '.waypoint'].includes(part))
    )
      throw new Error('Choose an ordinary source file inside the notebook project.');
    const canonical = await canonicalWorkspacePath({
      workspaceRoot: root,
      path: input,
      allowMissing: false,
      artifactNoun: 'notebook source',
    });
    if (workspaceMutationRootIdentity(canonical.candidate) !== workspaceMutationRootIdentity(input))
      throw new Error('The source file has no matching physical identity.');
    const sourceStatus = await stat(input);
    if (!sourceStatus.isFile()) throw new Error('Choose a physical source file.');
    if (sourceStatus.size > IMAGE_CONSTANTS.MAX_FILE_SIZE)
      throw new Error('The notebook source exceeds the existing image and structure size limit.');
    const inspected = await runWorkspaceFileTrash({
      kind: 'inspect',
      workspaceRoot: root,
      path: input,
    });
    if (inspected.kind !== 'inspect' || inspected.source.type !== 'file')
      throw new Error('Choose a physical source file.');
    if (inspected.source.size > IMAGE_CONSTANTS.MAX_FILE_SIZE)
      throw new Error('The notebook source exceeds the existing image and structure size limit.');
    const bytes = await readFile(input);
    if (
      bytes.length !== inspected.source.size ||
      `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== inspected.source.contentHash
    )
      throw new Error('The source file changed during insertion.');
    const after = await runWorkspaceFileTrash({
      kind: 'inspect',
      workspaceRoot: root,
      path: input,
    });
    if (after.kind !== 'inspect' || after.source.revision !== inspected.source.revision)
      throw new Error('The source file changed during insertion.');
    return {
      bytes,
      hash: inspected.source.contentHash,
      revision: inspected.source.revision,
      path: input,
      member,
    };
  };
  const appendMemory = (
    scope: NativeNotebookScope,
    event: import('../db/project-memory-owner').ProjectMemoryEvent
  ) =>
    appendProjectMemoryEventInMain(
      { workspaceRoot: scope.workspaceRoot, event },
      scope.assertCurrent
    );
  const creations = new Map<
    string,
    {
      fingerprint: string;
      promise: Promise<import('../shared/notebook-document').NotebookDocumentSnapshot>;
    }
  >();
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
        throw new Error('The notebook draft migration record is invalid.');
      return (legacyState = { pendingIds: record.pendingIds as string[] });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await access(join(options.profileDirectory(), 'IndexedDB'));
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return (legacyState = { pendingIds: [] });
    }
  };
  const conflictRecovery = createNotebookConflictRecovery(options);
  const owner: NativeNotebookWorkingCopyOwner = new NativeNotebookWorkingCopyOwner({
    resolveResourceReference: resourceReferences.resolve,
    prepareResourceReferences: resourceReferences.prepare,
    inspectConflict: (scope) => conflictRecovery.inspect(scope),
    resolveConflict: (scope, request) => conflictRecovery.resolve(scope, request),
    beginLegacyMigration() {
      legacyRunning = true;
    },
    async completeLegacyMigration(pendingIds) {
      if (pendingIds.length > 10000 || pendingIds.some((id) => !id.trim() || /[\\/]/.test(id)))
        throw new NativeDocumentCommandError(
          'NOTEBOOK_LEGACY_MIGRATION_INVALID',
          'Invalid notebook draft migration identities.',
          false
        );
      await writeJson(legacyPath(), { version: 1, complete: true, pendingIds });
      legacyState = { pendingIds: [...pendingIds] };
      legacyRunning = false;
    },
    async beforeExecute(id, operation) {
      const state = await currentLegacyMigration();
      if (!state)
        throw new NativeDocumentCommandError(
          'LEGACY_NOTEBOOK_DRAFT_MIGRATION_REQUIRED',
          'Start the current desktop once to transfer its earlier notebook recovery records.',
          false
        );
      if (
        state.pendingIds.includes(id) &&
        !['inspect', 'discard', 'restore-recovery', 'reload'].includes(operation)
      )
        throw new NativeDocumentCommandError(
          'LEGACY_NOTEBOOK_DRAFT_CONFLICT',
          'An earlier notebook draft remains preserved and requires recovery.',
          false
        );
    },
    async assertRecoveryClean(path) {
      const state = await currentLegacyMigration();
      if (!state)
        throw new NativeDocumentCommandError(
          'LEGACY_NOTEBOOK_DRAFT_MIGRATION_REQUIRED',
          'Earlier notebook recovery records must be transferred before project lifecycle changes.',
          false
        );
      for (const id of state.pendingIds) {
        const rows = options
          .db()
          .prepare("SELECT path FROM catalog_entity_files WHERE entity_id=? AND status='current'")
          .all(id) as Array<{ path: string }>;
        if (
          rows.some(
            (row) =>
              under(workspaceMutationRootIdentity(row.path), workspaceMutationRootIdentity(path)) ||
              under(workspaceMutationRootIdentity(path), workspaceMutationRootIdentity(row.path))
          )
        )
          throw new NativeDocumentCommandError(
            'LEGACY_NOTEBOOK_DRAFT_CONFLICT',
            'A preserved earlier notebook draft protects this path.',
            false
          );
      }
    },
    resolve: resolveDocument,
    load,
    normalizePath: workspaceMutationRootIdentity,
    async publish(scope, source, content, title) {
      return withKnownWorkspacePathMutation(options.db(), [scope.path], async () => {
        scope.assertCurrent();
        const current = await load(scope);
        scope.assertCurrent();
        if (current.fingerprint !== source.fingerprint)
          throw new NativeDocumentCommandError(
            'NOTEBOOK_EXTERNAL_CONFLICT',
            'The notebook package changed outside this working copy.',
            false
          );
        if (current.publication?.status === 'conflict')
          throw new NativeDocumentCommandError(
            'NOTEBOOK_EXTERNAL_CONFLICT',
            'Compare both retained notebook versions before saving.',
            false
          );
        let packageRoot = scope.path;
        if (current.sourceShape === 'legacy-wpnote') {
          const stem =
            basename(scope.path)
              .replace(/\.wpnote\.json$/i, '')
              .replace(/[/:\\?%*"<>|]/g, '-') || 'Untitled';
          packageRoot = join(dirname(scope.path), stem);
          for (let suffix = 2; ; suffix++) {
            try {
              await access(packageRoot);
              packageRoot = join(dirname(scope.path), `${stem} (${suffix})`);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
              throw error;
            }
          }
          scope.assertCurrent();
          await mkdir(packageRoot, { recursive: false });
        }
        const result = await publishNotebookPackageV2InMain(
          {
            packageRoot,
            workspaceRoot: scope.workspaceRoot,
            id: stripWorkspaceScope(scope.documentId),
            title,
            content,
            sourceShape: current.sourceShape ?? 'v2-package',
            formerAuthorityRaw:
              current.sourceShape !== 'v2-package' ? current.metadataRaw : undefined,
            existingMetadataRaw: current.metadataRaw,
            preservedPreamble: current.preservedPreamble,
            preservedTitleProjection: current.preservedTitleProjection,
            expectedCanonicalFingerprint:
              current.sourceShape === 'v2-package' ? source.fingerprint : undefined,
          },
          scope.assertCurrent
        );
        const warnings: string[] = [];
        let nextScope = scope;
        if (packageRoot !== scope.path) {
          if ((await readFile(scope.path, 'utf8')) !== current.metadataRaw)
            throw new NativeDocumentCommandError(
              'NOTEBOOK_MIGRATION_PARTIAL',
              'The new package was published, but the legacy source changed before cutover.',
              true,
              [{ path: packageRoot, published: true }]
            );
          scope.assertCurrent();
          await rename(scope.path, scope.path + '.legacy');
          try {
            scope.assertCurrent();
            bindCatalogEntityFileInDb(options.db(), {
              entityId: scope.documentId,
              path: packageRoot,
              fileKind: 'waypoint-notebook',
              workspaceRoot: scope.workspaceRoot,
              sizeBytes: result.markdownBytes,
              modifiedAt: Date.now(),
              status: 'current',
            });
            nextScope = await resolveDocument(scope.documentId, true);
          } catch (error) {
            throw new NativeDocumentCommandError(
              'NOTEBOOK_MIGRATION_PARTIAL',
              error instanceof Error ? error.message : String(error),
              true,
              [
                { path: packageRoot, published: true },
                { path: scope.path + '.legacy', preserved: true },
              ]
            );
          }
        }
        try {
          scope = nextScope;
          scope.assertCurrent();
          const db = options.db();
          await publishProjection(scope, result.parsed);
          db.prepare('UPDATE catalog_entities SET name=?,updated_at=? WHERE id=?').run(
            title,
            Date.now(),
            scope.documentId
          );
          const repo = catalog(scope.assertCurrent);
          await repo.bindCatalogEntityToFile({
            entityId: scope.documentId,
            path: scope.path,
            fileKind: 'waypoint-notebook',
            workspaceRoot: scope.workspaceRoot,
            sizeBytes: result.markdownBytes,
            modifiedAt: Date.now(),
            status: 'current',
          });
          await repo.recordCatalogEvent({
            entityId: scope.documentId,
            eventType: 'artifact_updated',
            summary: 'Updated notebook package snapshot',
            payload: {
              filePath: scope.path,
              artifactSchema: 'waypoint.notebook.v1',
              packageFormat: 'vault-shaped',
            },
          });
        } catch (error) {
          warnings.push(
            'The notebook package was saved, but its catalog projection needs reconciliation: ' +
              (error instanceof Error ? error.message : String(error))
          );
        }
        return {
          scope: nextScope,
          source: {
            sourceShape: 'v2-package' as const,
            content: new NotebookDocumentModel(result.parsed.content, result.parsed.title).content,
            title: result.parsed.title,
            updatedAt: result.metadata.updatedAt,
            sizeBytes: result.markdownBytes,
            fingerprint: result.canonicalFingerprint,
            metadataRaw: JSON.stringify(result.metadata),
            preservedPreamble: result.parsed.preservedPreamble,
            preservedTitleProjection: result.parsed.preservedTitleProjection,
            publication: readNotebookPublicationInDb(options.db(), {
              ...nextScope,
              title: result.parsed.title,
              content: result.parsed.content,
              canonicalFingerprint: result.canonicalFingerprint,
            }),
          },
          warnings,
        };
      });
    },
    async rename(scope, title) {
      const normalized = (title.trim() || 'Untitled')
        .replace(/[/:\\?%*"<>|]/g, '-')
        .replace(/\s+/g, ' ')
        .slice(0, 80);
      if (normalized === '.' || normalized === '..' || normalized.startsWith('.'))
        throw new NativeDocumentCommandError(
          'NOTEBOOK_NAME_INVALID',
          'Choose a visible notebook name.',
          false
        );
      const nextPath = join(dirname(scope.path), normalized);
      if (nextPath === scope.path) return { scope, source: await load(scope) };
      try {
        await access(nextPath);
        throw new NativeDocumentCommandError(
          'NOTEBOOK_DESTINATION_EXISTS',
          'A notebook or file already uses this name.',
          false
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const before = await load(scope);
      scope.assertCurrent();
      await prepareNotebookPackageRenameInMain(
        {
          packageRoot: scope.path,
          nextPackageRoot: nextPath,
          title: normalized,
          workspaceRoot: scope.workspaceRoot,
          expectedCanonicalFingerprint: before.fingerprint,
        },
        scope.assertCurrent
      );
      let moved = false;
      try {
        scope.assertCurrent();
        const result = await options.relocateEntityFile({
          workspaceRoot: scope.workspaceRoot,
          oldPath: scope.path,
          newPath: nextPath,
          actor: 'user',
        });
        moved = true;
        const oldName = basename(notebookPackagePaths(scope.path).markdownPath),
          newPaths = notebookPackagePaths(nextPath);
        if (oldName !== basename(newPaths.markdownPath)) {
          try {
            await access(join(nextPath, oldName));
            await rename(join(nextPath, oldName), newPaths.markdownPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        const nextScope = await resolveDocument(scope.documentId, true);
        const recovered = await recoverNotebookPackageRenameIfNeededInMain({
          workspaceRoot: scope.workspaceRoot,
          packageRoot: nextPath,
        });
        nextScope.assertCurrent();
        if (!recovered)
          throw new Error('The prepared notebook rename did not publish its canonical result.');
        await publishProjection(nextScope, recovered.parsed);
        options
          .db()
          .prepare('UPDATE catalog_entities SET name=?,updated_at=? WHERE id=?')
          .run(normalized, Date.now(), scope.documentId);
        await appendMemory(
          nextScope,
          createArtifactRenamedProjectMemoryEvent({
            workspaceRoot: scope.workspaceRoot,
            entityId: scope.documentId,
            oldPath: scope.path,
            newPath: nextPath,
            artifactSchema: 'waypoint.notebook.v1',
          })
        );
        return { scope: nextScope, source: await load(nextScope), warnings: result.warnings };
      } catch (error) {
        throw new NativeDocumentCommandError(
          'NOTEBOOK_RENAME_FAILED',
          error instanceof Error ? error.message : String(error),
          moved ? true : 'unknown',
          moved ? [{ documentId: scope.documentId, path: nextPath, moved: true }] : []
        );
      }
    },
    async loadRecord(id) {
      try {
        const record = JSON.parse(await readFile(recordPath(id), 'utf8')) as NativeNotebookRecord;
        if (
          record.version !== 1 ||
          record.documentId !== id ||
          !record.path ||
          typeof record.baselineFingerprint !== 'string' ||
          typeof record.dirty !== 'boolean'
        )
          throw new Error('The retained notebook record is invalid.');
        return record;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async storeRecord(record) {
      const identity = { documentId: record.documentId, path: record.path, dirty: record.dirty };
      if (record.dirty) await writeJson(identityPath(record.documentId), identity);
      await writeJson(recordPath(record.documentId), record);
      if (!record.dirty) await writeJson(identityPath(record.documentId), identity);
    },
    async retainedDirty() {
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
          options
            .workspaceRoots()
            .some((root) =>
              under(workspaceMutationRootIdentity(record.path), workspaceMutationRootIdentity(root))
            )
        )
          result.push(record);
      }
      return result;
    },
    async list() {
      const roots = options.workspaceRoots().map(workspaceMutationRootIdentity);
      return (
        options
          .db()
          .prepare(
            "SELECT e.id AS pageId,e.name AS title,f.path,w.path AS workspaceRoot FROM catalog_entities e JOIN catalog_entity_files f ON f.entity_id=e.id JOIN workspaces w ON w.id=f.workspace_id WHERE e.type IN ('notebook','page') AND e.status='active' AND f.status='current' AND w.archived_at IS NULL AND w.trashed_at IS NULL ORDER BY e.updated_at DESC"
          )
          .all() as Array<{ workspaceRoot: string }>
      ).filter((row) => roots.includes(workspaceMutationRootIdentity(row.workspaceRoot)));
    },
    async search(root, query, type, limit) {
      const pattern = '%' + query.replace(/[\\%_]/g, '\\$&') + '%';
      const rows = options
        .db()
        .prepare(
          "SELECT e.id AS entityId,e.name,e.type FROM catalog_entities e JOIN workspaces w ON w.id=e.workspace_id WHERE w.path=? AND e.status='active' AND e.type IN ('sequence','notebook','page') AND e.name LIKE ? ESCAPE '\\' ORDER BY e.updated_at DESC LIMIT ?"
        )
        .all(root, pattern, limit) as Array<{ entityId: string; name: string; type: string }>;
      const items = rows.map((row) => ({
        ...row,
        type: row.type === 'notebook' ? 'page' : row.type,
      }));
      if (!type || type === 'primer') {
        const primers = options
          .db()
          .prepare(
            "SELECT id AS entityId,name,'primer' AS type FROM primers WHERE name LIKE ? ESCAPE '\\' OR sequence LIKE ? ESCAPE '\\' OR catalog_number LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?"
          )
          .all(pattern, pattern, pattern, limit) as Array<{
          entityId: string;
          name: string;
          type: string;
        }>;
        items.push(...primers);
      }
      return items.filter((item) => !type || item.type === type).slice(0, limit);
    },
    async prepareReferenceInsertion(scope, operation) {
      return prepareNotebookReferenceInsertion(options.db(), scope, operation);
    },
    async prepareInsertion(scope, source) {
      if (source.kind === 'table')
        return {
          block: createConfiguredTableBlock(randomUUID(), {
            rows: source.rows,
            columns: source.columns,
          }),
          verify: async () => scope.assertCurrent(),
        };
      if (source.kind === 'file') {
        const before = await sourceFile(scope.workspaceRoot, source.path);
        if (before.revision !== source.expectedRevision)
          throw new Error('Inspect this source file again before insertion.');
        if (before.path.toLowerCase().endsWith(MOLECULAR_DOCUMENT_SUFFIX)) {
          const saved = await new MolecularDocumentLibrary().read({
            path: before.path,
            workspaceRoot: scope.workspaceRoot,
          });
          if (`sha256:${saved.revision}` !== before.hash)
            throw new Error('The molecular document changed while preparing insertion.');
          const project = projectRows().find(
            (row) =>
              workspaceMutationRootIdentity(row.path) ===
              workspaceMutationRootIdentity(scope.workspaceRoot)
          );
          if (!project) throw new Error('The molecular document project identity is unavailable.');
          const projectId = workspaceScopeKey(project.repo_uuid, project.id);
          if (!projectId)
            throw new Error('The molecular document project identity is unavailable.');
          const reference = await molecularDocumentReferenceFor(projectId, saved.document);
          const chip = notebookReferenceFromHref(
            molecularDocumentReferenceHref(reference),
            getCurrentMolecularSnapshot(saved.document).title
          );
          if (!chip) throw new Error('The saved molecular document reference is unavailable.');
          return {
            block: { type: 'paragraph', content: [chip] },
            verify: async () => {
              const after = await sourceFile(scope.workspaceRoot, source.path);
              scope.assertCurrent();
              if (after.revision !== before.revision)
                throw new Error('The insertion source file changed.');
            },
          };
        }
        const extension = basename(before.path).split('.').pop()?.toLowerCase(),
          mediaTypes: Record<string, string> = {
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            gif: 'image/gif',
            webp: 'image/webp',
          },
          mediaType = mediaTypes[extension ?? ''];
        if (!mediaType && !['pdb', 'cif', 'mmcif', 'ent'].includes(extension ?? ''))
          throw new Error('This file has no native image or structure embed.');
        const block = {
          type: 'embed',
          attrs: {
            type: mediaType ? 'image' : 'structure3d',
            version: 1,
            refId: (mediaType ? 'img-' : 'structure3d-') + randomUUID(),
            data: mediaType
              ? {
                  src: `data:${mediaType};base64,${before.bytes.toString('base64')}`,
                  fileName: basename(before.path),
                  source: 'upload',
                }
              : structureFileSource({}, before.bytes.toString('utf8'), basename(before.path)),
          },
        };
        return {
          block,
          verify: async () => {
            const after = await sourceFile(scope.workspaceRoot, source.path);
            scope.assertCurrent();
            if (after.revision !== before.revision)
              throw new Error('The insertion source file changed.');
          },
        };
      }
      const repo = catalog(scope.assertCurrent);
      if (source.type === 'primer') {
        const lookup = () =>
          options
            .db()
            .prepare(
              'SELECT p.id,p.name,p.updated_at,p.origin_details,w.path AS workspace_path FROM primers p LEFT JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=?'
            )
            .get(source.entityId) as
            | {
                id: string;
                name: string;
                updated_at: number;
                origin_details: string | null;
                workspace_path: string | null;
              }
            | undefined;
        const row = lookup();
        if (!row) throw new Error('Search for the exact native primer identity.');
        const portable = resolvePortablePrimerReferencePath(row, scope.workspaceRoot),
          file = portable ? await sourceFile(scope.workspaceRoot, portable) : undefined;
        return {
          block: {
            type: 'paragraph',
            content: [
              {
                type: 'mention',
                attrs: {
                  entityType: 'primer',
                  entityId: row.id,
                  label: row.name,
                  path: portable,
                  contentHash: file?.hash ?? null,
                },
              },
            ],
          },
          verify: async () => {
            scope.assertCurrent();
            if (
              canonicalNotebookJson(lookup()) !== canonicalNotebookJson(row) ||
              (file &&
                (await sourceFile(scope.workspaceRoot, portable!)).revision !== file.revision)
            )
              throw new Error('The primer or its source changed during insertion.');
          },
        };
      }
      const entity = await repo.getCatalogEntityForWorkspaceRoot(
          source.entityId,
          scope.workspaceRoot
        ),
        binding = entity ? await repo.getCurrentCatalogFileForEntity(entity.id) : null;
      if (
        !entity ||
        entity.status !== 'active' ||
        entity.type !== (source.type === 'page' ? 'notebook' : 'sequence') ||
        !binding ||
        !under(workspaceMutationRootIdentity(binding.path), scope.workspaceRoot)
      )
        throw new Error('Search for this exact entity in the notebook project.');
      const file =
        source.type === 'sequence'
          ? await sourceFile(scope.workspaceRoot, binding.path)
          : undefined;
      const block = {
        type: 'paragraph',
        content: [
          {
            type: 'mention',
            attrs: {
              entityType: source.type,
              entityId: entity.id,
              label: entity.name,
              ...(file
                ? { path: file.member, contentHash: file.hash, objectUuid: binding.object_uuid }
                : {}),
            },
          },
        ],
      };
      return {
        block,
        verify: async () => {
          const after = await repo.getCatalogEntityForWorkspaceRoot(entity.id, scope.workspaceRoot),
            next = await repo.getCurrentCatalogFileForEntity(entity.id);
          scope.assertCurrent();
          if (
            after?.name !== entity.name ||
            after.updated_at !== entity.updated_at ||
            next?.path !== binding.path ||
            next.object_uuid !== binding.object_uuid ||
            (file &&
              (await sourceFile(scope.workspaceRoot, binding.path)).revision !== file.revision)
          )
            throw new Error('The entity or its source changed during insertion.');
        },
      };
    },
    async create(input, providedRequestId, extra) {
      const requestId = providedRequestId ?? randomUUID();
      const inputFingerprint = createHash('sha256')
        .update(canonicalNotebookJson({ input, extra }))
        .digest('hex');
      const inFlight = creations.get(requestId);
      if (inFlight) {
        if (inFlight.fingerprint !== inputFingerprint)
          throw new NativeDocumentCommandError(
            'NOTEBOOK_REQUEST_ID_REUSED',
            'This creation request is already bound to another input.',
            false
          );
        return inFlight.promise;
      }
      const run = (async () => {
        const projects = currentProjects().filter(
          (row) =>
            !input.destinationProject ||
            row.path === input.destinationProject ||
            row.name === input.destinationProject
        );
        if (projects.length !== 1)
          throw new NativeDocumentCommandError(
            'NOTEBOOK_DESTINATION_REQUIRED',
            'Choose the exact enrolled writable destination project.',
            false
          );
        const project = projects[0],
          root = workspaceMutationRootIdentity(project.path),
          assertEnrollment = options.captureWorkspace(root, true);
        const assertCurrent = () => {
          assertEnrollment();
          if (
            !currentProjects().some(
              (current) =>
                current.id === project.id && workspaceMutationRootIdentity(current.path) === root
            )
          )
            throw new NativeDocumentCommandError(
              'NOTEBOOK_DESTINATION_CHANGED',
              'The notebook destination is no longer enrolled and writable.',
              false
            );
          assertKnownWorkspaceContentWritable(options.db(), project.path);
        };
        const receiptPath = join(
            directory(),
            'create-' + createHash('sha256').update(requestId).digest('hex') + '.json'
          ),
          fingerprint = createHash('sha256')
            .update(canonicalNotebookJson({ input, root, extra }))
            .digest('hex');
        try {
          const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
            fingerprint: string;
            documentId: string;
            state: string;
            path: string;
          };
          if (receipt.fingerprint !== fingerprint)
            throw new NativeDocumentCommandError(
              'NOTEBOOK_REQUEST_ID_REUSED',
              'The creation request identity is bound to another input or project.',
              false
            );
          if (receipt.state === 'created')
            return owner.execute({
              documentId: receipt.documentId,
              operation: { kind: 'inspect-copy' },
            });
          throw new NativeDocumentCommandError(
            'NOTEBOOK_CREATION_UNRESOLVED',
            'This creation attempt already has a retained outcome. Inspect its existing package before preparing another creation.',
            receipt.state === 'refused' ? false : 'unknown',
            [{ pageId: receipt.documentId, path: receipt.path, state: receipt.state }]
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const context = extra?.context;
        if (context?.workspaceRoot && workspaceMutationRootIdentity(context.workspaceRoot) !== root)
          throw new NativeDocumentCommandError(
            'NOTEBOOK_CREATION_CONTEXT_CHANGED',
            'The selected notebook location belongs to another project.',
            false
          );
        if (context?.targetPath) {
          const target =
            workspaceMutationRootIdentity(context.targetPath) === root
              ? { candidate: root }
              : await canonicalWorkspacePath({
                  workspaceRoot: root,
                  path: context.targetPath,
                  allowMissing: false,
                  artifactNoun: 'notebook creation target',
                });
          const member = relative(root, target.candidate);
          if (
            member
              .split(/[\\/]/)
              .some((part) => ['..', '.git', '.forge', '.waypoint', '.dnaforge'].includes(part))
          )
            throw new NativeDocumentCommandError(
              'INTERNAL_PROJECT_PATH',
              'Choose a visible notebook creation target.',
              false
            );
          assertCurrent();
        }
        const requestedParent =
          context?.targetKind === 'folder' && context.targetPath
            ? context.targetPath
            : (context?.parentPath ?? root);
        const parent =
          workspaceMutationRootIdentity(requestedParent) === root
            ? root
            : (
                await canonicalWorkspacePath({
                  workspaceRoot: root,
                  path: requestedParent,
                  allowMissing: false,
                  artifactNoun: 'notebook folder',
                })
              ).candidate;
        const member = relative(root, parent);
        if (
          member
            .split(/[\\/]/)
            .some((part) => ['..', '.git', '.forge', '.waypoint', '.dnaforge'].includes(part))
        )
          throw new NativeDocumentCommandError(
            'INTERNAL_PROJECT_PATH',
            'Choose a visible project folder for the notebook.',
            false
          );
        assertCurrent();
        if (!(await stat(parent).then((value) => value.isDirectory())))
          throw new Error('The notebook destination is not a folder.');
        const id = scopedProjectionId(
            workspaceScopeKey(project.repo_uuid, project.id),
            randomUUID()
          ),
          stem = (
            (context?.artifactFileName?.replace(/\.wpnote\.json$/i, '') ?? input.title).trim() ||
            'Untitled'
          )
            .replace(/[/:\\?%*"<>|]/g, '-')
            .replace(/\s+/g, ' ')
            .slice(0, 80);
        if (stem === '.' || stem === '..' || stem.startsWith('.'))
          throw new NativeDocumentCommandError(
            'NOTEBOOK_NAME_INVALID',
            'Choose a visible notebook title.',
            false
          );
        let path = join(parent, stem),
          created = false,
          published = false,
          settled = false;
        const receipt = (state: string) => ({
          version: 1,
          requestId,
          fingerprint,
          documentId: id,
          path,
          workspaceRoot: root,
          state,
        });
        await writeJson(receiptPath, receipt('creating'));
        try {
          return await withKnownWorkspacePathMutation(options.db(), [root], async () => {
            assertCurrent();
            assertKnownWorkspaceContentWritable(options.db(), project.path);
            for (let suffix = 2; ; suffix++) {
              try {
                await mkdir(path, { recursive: false });
                break;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                if (context?.artifactFileName)
                  throw new NativeDocumentCommandError(
                    'NOTEBOOK_DESTINATION_EXISTS',
                    'A file already uses the selected notebook name.',
                    false
                  );
                path = join(parent, `${stem} (${suffix})`);
              }
            }
            created = true;
            await writeJson(receiptPath, receipt('creating'));
            assertCurrent();
            const saved = await publishNotebookPackageV2InMain(
              {
                packageRoot: path,
                workspaceRoot: root,
                id: stripWorkspaceScope(id),
                title: input.title,
                content: { type: 'doc', content: [{ type: 'paragraph' }] },
                sourceShape: 'new-package',
              },
              assertCurrent
            );
            published = true;
            assertCurrent();
            const repo = catalog(assertCurrent);
            await repo.registerContextualCatalogEntity({
              id,
              context,
              type: 'notebook',
              name: input.title,
              locator: `entity://page/${id}`,
              storageType: 'database',
              workspaceRoot: project.path,
              metadata: { createdBy: extra?.source ?? 'agent', backingStore: 'pages' },
            });
            await repo.bindCatalogEntityToFile({
              entityId: id,
              path,
              fileKind: 'waypoint-notebook',
              workspaceRoot: project.path,
              sizeBytes: saved.markdownBytes,
              status: 'current',
            });
            await publishProjection(
              { documentId: id, path, workspaceRoot: root, readOnly: false, assertCurrent },
              saved.parsed
            );
            await appendMemory(
              { documentId: id, path, workspaceRoot: root, readOnly: false, assertCurrent },
              createArtifactCreatedProjectMemoryEvent({
                workspaceRoot: root,
                entityId: id,
                entityKind: 'notebook',
                displayName: input.title,
                filePath: path,
                fileKind: 'notebook',
                sizeBytes: saved.markdownBytes,
                artifactSchema: 'waypoint.notebook.v1',
                operationId: requestId,
              })
            );
            await writeJson(receiptPath, receipt('created'));
            settled = true;
            return owner.execute({ documentId: id, operation: { kind: 'inspect-copy' } });
          });
        } catch (error) {
          try {
            await writeJson(
              receiptPath,
              receipt(settled ? 'created' : created ? 'partial' : 'refused')
            );
          } catch {}
          throw new NativeDocumentCommandError(
            'NOTEBOOK_CREATE_FAILED',
            error instanceof Error ? error.message : String(error),
            created,
            [{ pageId: id, path, created, saved: published }]
          );
        }
      })();
      creations.set(requestId, { fingerprint: inputFingerprint, promise: run });
      void run
        .finally(() => {
          if (creations.get(requestId)?.promise === run) creations.delete(requestId);
        })
        .catch(() => {});
      return run;
    },
  });
  return owner;
}
