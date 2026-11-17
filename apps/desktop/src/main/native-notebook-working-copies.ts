import { TABLE_REFERENCE_NOTEBOOK_BLOCK } from '../shared/table-reference-notebook-contract';
import { notebookTableReference, tableDocumentKey } from '../shared/table-document-reference';
import { createNotebookTableAliases } from './notebook-table-aliases';
import type { NativeTableDocumentCommands } from './table-document-commands';
import { createNotebookConflictRecovery } from './notebook-conflict-recovery';
import { createNotebookResourceReferences } from './notebook-resource-references';
import type { RegisteredProjectAuthority } from './registered-project-authority';
import { prepareNotebookReferenceInsertion } from './notebook-reference-insertion';
import { resolvePortablePrimerReferencePath } from '../shared/primer-reference-path';
import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type Database from 'better-sqlite3';
import {
  NativeNotebookWorkingCopyOwner,
  type NativeNotebookRecord,
  type NativeNotebookScope,
  type NativeNotebookSource,
} from './notebook-document-owner';
import {
  readCanonicalNotebookPackage,
  type PublishNotebookPackageResult,
} from '../db/notebook-package-migration';
import { notebookPackagePaths, parseNotebookPackageDocument } from '../db/notebook-package';
import { contentFingerprint } from '../shared/content-fingerprint';
import {
  canonicalNotebookJson,
  notebookMarkdownPreamble,
  notebookPayloadPathsFromMarkdown,
} from '../db/notebook-markdown-codec';
import { migrateFlatNotebookInMain } from './notebook-flat-migration';
import { captureSequenceMigrationAdmission } from './workspace-git/sequence-migration-admission';
import { captureMigrationGitContent } from './workspace-git/migration-paths';
import { publishFileContentNoClobber } from './workspace-git/exclusive-file-claim';
import type { NotebookLegacyProjectMigrationResult } from '../shared/notebook-document';
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
  workspaceAccess?(root: string): { readOnly: boolean } | null;
  profileDirectory(): string;
  captureWorkspace(root: string, mutating: boolean): () => void;
  relocateEntityFile(input: RelocateEntityFileInput): Promise<RelocateEntityFileResult>;
  registeredProjects?: RegisteredProjectAuthority;
  tableDocuments?: () => Pick<NativeTableDocumentCommands, 'execute'>;
}): NativeNotebookWorkingCopyOwner {
  const resourceReferences = createNotebookResourceReferences(options);
  const tableAliases = createNotebookTableAliases(options);
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
        "SELECT e.id,f.id AS bindingId,f.object_uuid AS objectUuid,f.path,w.path AS root,w.access_mode FROM catalog_entities e JOIN catalog_entity_files f ON f.entity_id=e.id JOIN workspaces w ON w.id=f.workspace_id WHERE e.id=? AND e.type IN ('notebook','page') AND e.status='active' AND f.status='current' AND w.archived_at IS NULL AND w.trashed_at IS NULL LIMIT 2"
      )
      .all(id) as Array<{
      id: string;
      path: string;
      root: string;
      access_mode: string;
      bindingId: string;
      objectUuid: string | null;
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
        allowMissing: row.path.toLowerCase().endsWith('.wpnote.json'),
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
      options.workspaceAccess
        ? options.workspaceAccess(root)?.readOnly === false
        : options
            .writableWorkspaceRoots()
            .some((candidate) => workspaceMutationRootIdentity(candidate) === root);
    let readOnly = row.access_mode !== 'writable' || !writable();
    try {
      assertKnownWorkspaceContentWritable(options.db(), row.root);
    } catch {
      readOnly = true;
    }
    const assertCurrent = () => {
      assertEnrollment();
      if (
        options.workspaceAccess
          ? !options.workspaceAccess(root)
          : !options
              .workspaceRoots()
              .some((candidate) => workspaceMutationRootIdentity(candidate) === root)
      )
        throw new NativeDocumentCommandError(
          'OUTSIDE_WORKSPACE',
          'This notebook project is no longer enrolled.',
          false
        );
      const current = options
        .db()
        .prepare(
          "SELECT f.id AS bindingId,f.object_uuid AS objectUuid,f.path,w.path AS root FROM catalog_entities e JOIN catalog_entity_files f ON f.entity_id=e.id JOIN workspaces w ON w.id=f.workspace_id WHERE e.id=? AND e.type IN ('notebook','page') AND e.status='active' AND f.status='current' AND w.archived_at IS NULL AND w.trashed_at IS NULL LIMIT 2"
        )
        .all(id) as Array<{
        path: string;
        root: string;
        bindingId: string;
        objectUuid: string | null;
      }>;
      if (
        findKnownWorkspaceRoot(options.db(), currentPath) !== root ||
        current.length !== 1 ||
        current[0].bindingId !== row.bindingId ||
        current[0].objectUuid !== row.objectUuid ||
        workspaceMutationRootIdentity(current[0].root) !== root ||
        workspaceMutationRootIdentity(current[0].path) !== currentPath
      )
        throw new NativeDocumentCommandError(
          'NOTEBOOK_BINDING_CHANGED',
          'The notebook package identity changed.',
          false
        );
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
    return { documentId: id, path: currentPath, workspaceRoot: root, readOnly, assertCurrent };
  };
  const load = async (scope: NativeNotebookScope): Promise<NativeNotebookSource> => {
    const reads = new Map<string, Buffer>(),
      missing = new Set<string>();
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
      return member.candidate;
    };
    const read = async (path: string) => {
      const bytes = await readFile(await safe(path));
      reads.set(path, bytes);
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
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
      if (!(await readFile(await safe(path))).equals(value))
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
      sourceFileHashes: Object.fromEntries(
        [...reads].map(([path, bytes]) => [
          relative(scope.path, path).replace(/\\/g, '/'),
          createHash('sha256').update(bytes).digest('hex'),
        ])
      ),
      metadataRaw,
      preservedPreamble: result.parsed.preservedPreamble,
      preservedTitleProjection: result.parsed.preservedTitleProjection,
      sourceShape: 'v2-package',
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
  const readRetainedRecord = async (id: string): Promise<NativeNotebookRecord | undefined> => {
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
  };
  const migrationPublications = (root: string) =>
    join(root, '.dnaforge-notebook-migrations', 'publications');
  const flatMigrationAuthority = (scope: NativeNotebookScope) => {
    const admitted = captureSequenceMigrationAdmission(options.db(), scope.workspaceRoot, {
      requireWritable: true,
    });
    const foreign = options
      .db()
      .prepare('SELECT path FROM catalog_entity_files WHERE entity_id<>?')
      .all(scope.documentId) as Array<{ path: string }>;
    return {
      protectedPaths: [...admitted.protectedPaths, ...foreign.map((row) => row.path)],
      assertCurrent: () => {
        scope.assertCurrent();
        admitted.assertCurrent();
      },
    };
  };
  const planMigration = async (
    scope: NativeNotebookScope,
    raw: string,
    content: import('@tiptap/core').JSONContent,
    title: string
  ) => {
    const bytes = JSON.stringify({
      schema: 'dnaforge.notebook-migration-plan.v1',
      documentId: stripWorkspaceScope(scope.documentId),
      package: relative(scope.workspaceRoot, scope.path).split(sep).join('/'),
      originalRaw: raw,
      content,
      title,
    });
    const directory = migrationPublications(scope.workspaceRoot);
    await canonicalWorkspacePath({
      workspaceRoot: scope.workspaceRoot,
      path: directory,
      allowMissing: true,
      artifactNoun: 'notebook migration',
    });
    scope.assertCurrent();
    await mkdir(directory, { recursive: true });
    const path = join(
      directory,
      'plan-' + createHash('sha256').update(bytes).digest('hex') + '.json'
    );
    try {
      await publishFileContentNoClobber(path, bytes);
      await syncDirectory(directory);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        (await readFile(path, 'utf8')) !== bytes
      )
        throw error;
    }
    return path;
  };
  const captureMigration = async (
    scope: NativeNotebookScope,
    result: PublishNotebookPackageResult,
    additional: string[] = [],
    additionalPins?: Record<string, string | null>
  ) => {
    const paths = notebookPackagePaths(scope.path);
    const markdown = await readFile(paths.markdownPath, 'utf8');
    if (contentFingerprint(markdown) !== result.canonicalFingerprint)
      throw new Error('The migrated notebook changed before publication.');
    const files = [
      paths.metaPath,
      paths.markdownPath,
      paths.migrationJournalPath,
      ...additional,
      ...notebookPayloadPathsFromMarkdown(markdown).map((path) => join(scope.path, path)),
    ];
    if (result.metadata.migration)
      files.push(join(paths.metaDir, result.metadata.migration.archivePath));
    for (const path of files)
      await canonicalWorkspacePath({
        workspaceRoot: scope.workspaceRoot,
        path,
        allowMissing: true,
        artifactNoun: 'notebook migration',
      });
    const pins = await captureMigrationGitContent(scope.workspaceRoot, files);
    for (const [path, expected] of Object.entries(additionalPins ?? {})) {
      const member = relative(scope.workspaceRoot, path).split(sep).join('/');
      if (pins.expectedContentSha256[member] !== expected)
        throw new Error(`The retained notebook source changed before publication: ${path}`);
    }
    const publication = JSON.stringify({
      schema: 'dnaforge.notebook-migration-publication.v1',
      documentId: stripWorkspaceScope(scope.documentId),
      expectedContentSha256: pins.expectedContentSha256,
    });
    const publications = migrationPublications(scope.workspaceRoot);
    await canonicalWorkspacePath({
      workspaceRoot: scope.workspaceRoot,
      path: publications,
      allowMissing: true,
      artifactNoun: 'notebook migration',
    });
    scope.assertCurrent();
    await mkdir(publications, { recursive: true });
    const receipt = join(
      publications,
      createHash('sha256').update(publication).digest('hex') + '.json'
    );
    try {
      await publishFileContentNoClobber(receipt, publication);
      await syncDirectory(publications);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        (await readFile(receipt, 'utf8')) !== publication
      )
        throw error;
    }
    return captureMigrationGitContent(scope.workspaceRoot, [...files, receipt]);
  };
  const prepareLegacyNotebook = async (
    scope: NativeNotebookScope,
    record?: NativeNotebookRecord
  ): Promise<{ scope: NativeNotebookScope; migrated: boolean }> => {
    if (scope.readOnly) return { scope, migrated: false };
    const legacyFlat = scope.path.toLowerCase().endsWith('.wpnote.json');
    let resuming = false;
    if (legacyFlat) {
      try {
        await lstat(scope.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        resuming = true;
      }
    }
    if (record?.dirty && !resuming) return { scope, migrated: false };
    const state = await currentLegacyMigration();
    if (!resuming && (!state || state.pendingIds.includes(scope.documentId)))
      return { scope, migrated: false };
    if (!legacyFlat) {
      const metadata = JSON.parse(
        await readFile(notebookPackagePaths(scope.path).metaPath, 'utf8')
      ) as Record<string, unknown>;
      if ('formatVersion' in metadata) {
        const directory = migrationPublications(scope.workspaceRoot);
        let names: string[] = [];
        try {
          names = await readdir(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        for (const name of names.filter((name) => /^plan-[a-f0-9]{64}\.json$/u.test(name))) {
          const path = join(directory, name);
          await canonicalWorkspacePath({
            workspaceRoot: scope.workspaceRoot,
            path,
            allowMissing: false,
            artifactNoun: 'notebook migration',
          });
          const bytes = await readFile(path, 'utf8');
          if ('plan-' + createHash('sha256').update(bytes).digest('hex') + '.json' !== name)
            throw new Error('The notebook migration plan changed.');
          const plan = JSON.parse(bytes) as {
            schema: string;
            documentId: string;
            package: string;
            originalRaw: string;
            content: import('@tiptap/core').JSONContent;
            title: string;
          };
          if (
            plan.schema !== 'dnaforge.notebook-migration-plan.v1' ||
            plan.documentId !== stripWorkspaceScope(scope.documentId) ||
            plan.package !== relative(scope.workspaceRoot, scope.path).split(sep).join('/')
          )
            continue;
          const relativePlan = relative(scope.workspaceRoot, path).split(sep).join('/');
          let captured = false;
          for (const receiptName of names.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))) {
            await canonicalWorkspacePath({
              workspaceRoot: scope.workspaceRoot,
              path: join(directory, receiptName),
              allowMissing: false,
              artifactNoun: 'notebook migration',
            });
            const receiptBytes = await readFile(join(directory, receiptName), 'utf8');
            if (createHash('sha256').update(receiptBytes).digest('hex') + '.json' !== receiptName)
              throw new Error('The notebook migration publication changed.');
            const receipt = JSON.parse(receiptBytes) as {
              expectedContentSha256?: Record<string, string | null>;
            };
            if (
              receipt.expectedContentSha256?.[relativePlan] ===
              createHash('sha256').update(bytes).digest('hex')
            )
              captured = true;
          }
          if (captured) continue;
          await withKnownWorkspacePathMutation(options.db(), [scope.path], async () => {
            scope = await resolveDocument(scope.documentId, true);
            const current = await readCanonicalNotebookPackage(
              {
                exists: async (path) => {
                  try {
                    await access(path);
                    return true;
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
                    throw error;
                  }
                },
                readTextFile: (path) => readFile(path, 'utf8'),
              },
              scope.path
            );
            if (
              current.metadata.id !== stripWorkspaceScope(scope.documentId) ||
              current.parsed.title !== plan.title ||
              canonicalNotebookJson(current.parsed.content) !==
                canonicalNotebookJson(plan.content) ||
              !current.metadata.migration
            )
              throw new Error('The interrupted notebook migration changed.');
            const archived = join(
              notebookPackagePaths(scope.path).metaDir,
              current.metadata.migration.archivePath
            );
            await canonicalWorkspacePath({
              workspaceRoot: scope.workspaceRoot,
              path: archived,
              allowMissing: false,
              artifactNoun: 'notebook migration',
            });
            if ((await readFile(archived, 'utf8')) !== plan.originalRaw)
              throw new Error('The interrupted notebook source changed.');
            await captureMigration(
              scope,
              {
                ...current,
                markdownBytes: Buffer.byteLength(current.markdown),
                canonicalFingerprint: contentFingerprint(current.markdown),
                recovered: true,
                changed: false,
              },
              [path]
            );
          });
        }
        return { scope, migrated: false };
      }
    }
    return withKnownWorkspacePathMutation(options.db(), [scope.path], async () => {
      scope = await resolveDocument(scope.documentId, true);
      if ((await readRetainedRecord(scope.documentId))?.dirty && !resuming)
        return { scope, migrated: false };
      scope.assertCurrent();
      let result: PublishNotebookPackageResult;
      let retained: string[] = [];
      if (legacyFlat) {
        const oldPath = scope.path;
        const migrated = await migrateFlatNotebookInMain({
          workspaceRoot: scope.workspaceRoot,
          sourcePath: oldPath,
          documentId: scope.documentId,
          ...flatMigrationAuthority(scope),
        });
        scope.assertCurrent();
        result = migrated.result;
        retained = [...migrated.retainedPaths, oldPath];
        await captureMigration(
          { ...scope, path: migrated.packageRoot },
          result,
          retained,
          migrated.expectedContentSha256
        );
        bindCatalogEntityFileInDb(options.db(), {
          entityId: scope.documentId,
          path: migrated.packageRoot,
          fileKind: 'waypoint-notebook',
          workspaceRoot: scope.workspaceRoot,
          sizeBytes: migrated.result.markdownBytes,
          status: 'current',
        });
        scope = await resolveDocument(scope.documentId, true);
      } else {
        const paths = notebookPackagePaths(scope.path);
        const raw = await readFile(paths.metaPath, 'utf8');
        const legacy = parseNotebookPackageDocument(raw);
        if (legacy.id !== stripWorkspaceScope(scope.documentId))
          throw new Error('The legacy notebook belongs to another identity.');
        let preamble = '';
        const content = new NotebookDocumentModel(
          legacy.content as import('@tiptap/core').JSONContent,
          legacy.title
        ).content;
        const plan = await planMigration(scope, raw, content, legacy.title);
        try {
          preamble = notebookMarkdownPreamble(await readFile(paths.markdownPath, 'utf8'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        result = await publishNotebookPackageV2InMain(
          {
            packageRoot: scope.path,
            workspaceRoot: scope.workspaceRoot,
            id: legacy.id,
            title: legacy.title,
            content,
            sourceShape: 'v1-package',
            formerAuthorityRaw: raw,
            existingMetadataRaw: raw,
            preservedPreamble: preamble,
            updatedAt: legacy.updatedAt,
          },
          scope.assertCurrent
        );
        retained = [plan];
      }
      if (!legacyFlat) await captureMigration(scope, result, retained);
      await publishProjection(scope, result.parsed);
      return { scope, migrated: true };
    });
  };
  const owner: NativeNotebookWorkingCopyOwner = new NativeNotebookWorkingCopyOwner({
    async resolveTableSource(reference, context) {
      if (reference.backing.kind !== 'notebook-inline' || reference.binding.kind !== 'current')
        throw new NativeDocumentCommandError(
          'TABLE_SOURCE_UNSUPPORTED',
          'Recovery requires a current notebook-backed table source.',
          false
        );
      const root = workspaceMutationRootIdentity(context.workspaceRoot);
      if (
        !options
          .workspaceRoots()
          .some((candidate) => workspaceMutationRootIdentity(candidate) === root)
      )
        throw new NativeDocumentCommandError(
          'OUTSIDE_WORKSPACE',
          'The recovery notebook project is no longer enrolled.',
          false
        );
      const canonical = await canonicalWorkspacePath({
        workspaceRoot: root,
        path: context.sourcePath,
        allowMissing: false,
        artifactNoun: 'recovery notebook package',
      });
      const sourcePath = workspaceMutationRootIdentity(canonical.candidate);
      const rows = options
        .db()
        .prepare(
          "SELECT e.id,f.path,w.path AS root FROM catalog_entities e JOIN catalog_entity_files f ON f.entity_id=e.id JOIN workspaces w ON w.id=f.workspace_id WHERE e.type IN ('notebook','page') AND e.status='active' AND f.status='current' AND w.archived_at IS NULL AND w.trashed_at IS NULL"
        )
        .all() as Array<{ id: string; path: string; root: string }>;
      const matches = rows.filter(
        (row) =>
          workspaceMutationRootIdentity(row.root) === root &&
          workspaceMutationRootIdentity(row.path) === sourcePath
      );
      if (matches.length !== 1)
        throw new NativeDocumentCommandError(
          'TABLE_SOURCE_CONTEXT_CHANGED',
          'The recovery notebook has no unique active native binding at its verified project location.',
          false
        );
      const scope = await resolveDocument(matches[0].id, false);
      if (
        workspaceMutationRootIdentity(scope.workspaceRoot) !== root ||
        workspaceMutationRootIdentity(scope.path) !== sourcePath ||
        stripWorkspaceScope(scope.documentId) !==
          stripWorkspaceScope(reference.backing.notebookDocumentId)
      )
        throw new NativeDocumentCommandError(
          'TABLE_SOURCE_CONTEXT_CHANGED',
          'The current notebook binding does not match the archived portable identity.',
          false
        );
      await load(scope);
      scope.assertCurrent();
      return notebookTableReference(scope.documentId, reference.backing.blockId);
    },
    resolveResourceReference: resourceReferences.resolve,
    prepareResourceReferences: resourceReferences.prepare,
    prepareTableAliases: tableAliases.prepare,
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
    prepareLoad: async (scope, record) => (await prepareLegacyNotebook(scope, record)).scope,
    async migrateLegacyProjectFiles(rawRoot) {
      const root = workspaceMutationRootIdentity(rawRoot);
      const result: NotebookLegacyProjectMigrationResult = {
        migrated: 0,
        issues: [],
        mutatedGitFiles: [],
        expectedContentSha256: {},
      };
      if (
        !currentProjects().some((project) => workspaceMutationRootIdentity(project.path) === root)
      )
        throw new Error('The notebook project is not enrolled for writing.');
      const assertCurrent = options.captureWorkspace(root, true);
      assertCurrent();
      assertKnownWorkspaceContentWritable(options.db(), root);
      const rows = options
        .db()
        .prepare(
          "SELECT e.id,f.path FROM catalog_entities e JOIN catalog_entity_files f ON f.entity_id=e.id JOIN workspaces w ON w.id=f.workspace_id WHERE e.type IN ('notebook','page') AND e.status='active' AND f.status='current' AND w.archived_at IS NULL AND w.trashed_at IS NULL"
        )
        .all() as Array<{ id: string; path: string }>;
      for (const row of rows.filter(
        (row) => findKnownWorkspaceRoot(options.db(), row.path) === root
      )) {
        try {
          await owner.withCleanPaths([row.path], async () => {
            assertCurrent();
            const scope = await resolveDocument(row.id, false);
            const prepared = await prepareLegacyNotebook(scope, await readRetainedRecord(row.id));
            if (prepared.migrated) {
              result.migrated++;
              await owner.refreshAfterMigration(row.id, prepared.scope);
            }
          });
        } catch (error) {
          result.issues.push({
            path: row.path,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const publications = migrationPublications(root);
      let receipts: string[] = [];
      try {
        receipts = await readdir(publications);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const ids = new Set(
        rows
          .filter((row) => findKnownWorkspaceRoot(options.db(), row.path) === root)
          .map((row) => stripWorkspaceScope(row.id))
      );
      for (const name of receipts) {
        if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
        const path = join(publications, name);
        try {
          await canonicalWorkspacePath({
            workspaceRoot: root,
            path,
            allowMissing: false,
            artifactNoun: 'notebook migration',
          });
          const bytes = await readFile(path, 'utf8');
          if (createHash('sha256').update(bytes).digest('hex') + '.json' !== name)
            throw new Error('The notebook migration publication changed.');
          const receipt = JSON.parse(bytes) as {
            schema: string;
            documentId: string;
            expectedContentSha256: Record<string, string | null>;
          };
          if (
            receipt.schema !== 'dnaforge.notebook-migration-publication.v1' ||
            !ids.has(receipt.documentId) ||
            !receipt.expectedContentSha256 ||
            typeof receipt.expectedContentSha256 !== 'object'
          )
            continue;
          for (const [member, expected] of Object.entries(receipt.expectedContentSha256)) {
            const file = join(root, member);
            const rel = relative(root, file);
            if (
              !rel ||
              rel === '..' ||
              rel.startsWith(`..${sep}`) ||
              isAbsolute(rel) ||
              rel.split(sep).includes('.git')
            )
              throw new Error('The notebook migration publication escaped its project.');
            await canonicalWorkspacePath({
              workspaceRoot: root,
              path: file,
              allowMissing: true,
              artifactNoun: 'notebook migration',
            });
            const current = await captureMigrationGitContent(root, [file]);
            if (current.expectedContentSha256[member] === expected)
              result.expectedContentSha256[member] = expected;
          }
          result.expectedContentSha256[relative(root, path).split(sep).join('/')] = createHash(
            'sha256'
          )
            .update(bytes)
            .digest('hex');
        } catch (error) {
          result.issues.push({
            path,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      assertCurrent();
      result.mutatedGitFiles = Object.keys(result.expectedContentSha256);
      return result;
    },
    load,
    normalizePath: workspaceMutationRootIdentity,
    async publish(scope, source, content, title) {
      let phase = 'waiting-project-publication';
      const trace = (next: string) => {
        phase = next;
        try {
          console.info('[Notebook publication]', { documentId: scope.documentId, phase });
        } catch {}
      };
      trace(phase);
      return withKnownWorkspacePathMutation(options.db(), [scope.path], async () => {
        trace('reading-current-source');
        scope.assertCurrent();
        const current = await load(scope);
        scope.assertCurrent();
        if (current.fingerprint !== source.fingerprint)
          throw new NativeDocumentCommandError(
            'NOTEBOOK_EXTERNAL_CONFLICT',
            'The notebook package changed outside this working copy.',
            false
          );
        if (
          source.sourceFileHashes &&
          canonicalNotebookJson(current.sourceFileHashes) !==
            canonicalNotebookJson(source.sourceFileHashes)
        )
          throw new NativeDocumentCommandError(
            'NOTEBOOK_EXTERNAL_CONFLICT',
            'The exact saved notebook source bytes changed outside this working copy.',
            false
          );
        if (current.publication?.status === 'conflict')
          throw new NativeDocumentCommandError(
            'NOTEBOOK_EXTERNAL_CONFLICT',
            'Compare both retained notebook versions before saving.',
            false
          );
        let result: PublishNotebookPackageResult;
        trace('publishing-canonical-files');
        let nextScope = scope;
        if (current.sourceShape === 'legacy-wpnote') {
          const originalPath = scope.path;
          const migrated = await migrateFlatNotebookInMain({
            workspaceRoot: scope.workspaceRoot,
            sourcePath: scope.path,
            documentId: scope.documentId,
            ...flatMigrationAuthority(scope),
            desired: { content, title, expectedRaw: current.metadataRaw },
          });
          scope.assertCurrent();
          result = migrated.result;
          trace('canonical-files-published');
          await captureMigration(
            { ...scope, path: migrated.packageRoot },
            result,
            [...migrated.retainedPaths, originalPath],
            migrated.expectedContentSha256
          );
          bindCatalogEntityFileInDb(options.db(), {
            entityId: scope.documentId,
            path: migrated.packageRoot,
            fileKind: 'waypoint-notebook',
            workspaceRoot: scope.workspaceRoot,
            sizeBytes: migrated.result.markdownBytes,
            modifiedAt: Date.now(),
            status: 'current',
          });
          nextScope = await resolveDocument(scope.documentId, true);
        } else {
          const plan =
            current.sourceShape === 'v1-package'
              ? await planMigration(scope, current.metadataRaw, content, title)
              : undefined;
          result = await publishNotebookPackageV2InMain(
            {
              packageRoot: scope.path,
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
          trace('canonical-files-published');
          if (current.sourceShape === 'v1-package')
            await captureMigration(scope, result, plan ? [plan] : []);
        }
        const warnings: string[] = [];
        try {
          scope = nextScope;
          scope.assertCurrent();
          const db = options.db();
          trace('publishing-projection');
          await publishProjection(scope, result.parsed);
          trace('projection-published');
          db.prepare('UPDATE catalog_entities SET name=?,updated_at=? WHERE id=?').run(
            title,
            Date.now(),
            scope.documentId
          );
          const repo = catalog(scope.assertCurrent);
          trace('binding-catalog-file');
          await repo.bindCatalogEntityToFile({
            entityId: scope.documentId,
            path: scope.path,
            fileKind: 'waypoint-notebook',
            workspaceRoot: scope.workspaceRoot,
            sizeBytes: result.markdownBytes,
            modifiedAt: Date.now(),
            status: 'current',
          });
          trace('recording-catalog-event');
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
          try {
            console.error(
              '[Notebook publication]',
              { documentId: scope.documentId, phase, outcome: 'projection-pending' },
              error
            );
          } catch {}
          warnings.push(
            'The notebook package was saved, but its catalog projection needs reconciliation: ' +
              (error instanceof Error ? error.message : String(error))
          );
        }
        trace('reading-published-source');
        const publishedSource = await load(nextScope);
        trace('publication-complete');
        return {
          scope: nextScope,
          source: publishedSource,
          warnings,
        };
      }).catch((error) => {
        try {
          console.error(
            '[Notebook publication]',
            { documentId: scope.documentId, phase, outcome: 'failed' },
            error
          );
        } catch {}
        throw error;
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
    loadRecord: readRetainedRecord,
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
      if (operation.tableReference) {
        if (operation.referenceId || operation.documentReference)
          throw new Error('Supply one table, molecular document or saved result reference.');
        const data = {
          reference: operation.tableReference,
          presentation: operation.presentation ?? 'embed',
          ...(operation.label ? { label: operation.label } : {}),
        };
        const parsed = TABLE_REFERENCE_NOTEBOOK_BLOCK.parseData(data);
        if (!parsed.ok) throw new Error(parsed.reason);
        const referenceKey = tableDocumentKey(operation.tableReference);
        const verify = async () => {
          scope.assertCurrent();
          const tables = options.tableDocuments?.();
          if (!tables) throw new Error('The native table reference owner is unavailable.');
          const result = await tables.execute({
            kind: 'resolve',
            reference: operation.tableReference!,
          });
          if (
            result.kind !== 'resolved' ||
            tableDocumentKey(result.table.reference) !== referenceKey
          )
            throw new Error('The table reference changed while preparing its notebook placement.');
          scope.assertCurrent();
        };
        await verify();
        return {
          block: {
            type: 'embed',
            attrs: { type: 'table-reference', version: 1, refId: randomUUID(), data },
          },
          verify,
        };
      }
      if (operation.presentation !== undefined)
        throw new Error('A table presentation requires a table reference.');
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
