import type Database from 'better-sqlite3';
import type { JSONContent } from '@tiptap/core';
import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '../shared/canonical-json';
import {
  tableDocumentCommandSchema,
  type ResolvedTableDocument,
  type TableDocumentCommand,
  type TableDocumentCommandResult,
  type TablePackageDestination,
} from '../shared/table-document-command';
import {
  richTableReference,
  tableDocumentKey,
  type TableDocumentReference,
} from '../shared/table-document-reference';
import type { TableData } from '../shared/table-document-types';
import type { FileDocumentSnapshot } from '../shared/file-document';
import {
  TABLE_PACKAGE_MAX_BYTES,
  TABLE_PACKAGE_SCHEMA,
  TABLE_SNAPSHOT_SCHEMA,
  parseTablePackageHead,
  parseTableSnapshot,
  serializeTablePackageHead,
  serializeTableSnapshot,
  tableSnapshotSha256,
  verifyTablePackageRead,
  type TablePackageHead,
  type TableSnapshot,
} from '../shared/table-package';
import { detectDocumentPackage } from '../shared/document-package';
import type { NativeFileDocumentOwner } from './file-document-owner';
import {
  admitRegisteredProjectRootInMain,
  ensureProjectResourceIdentityInMain,
  readProjectResourceIdentityInMain,
} from './project-filesystem-authority';
import { writeWorkspaceTextFileAtomicInMain } from './primer-artifact-files';
import { syncDirectory } from './fs-durability';
import {
  publishTablePackageInMain,
  readTablePackageInMain,
  readTableSnapshotInMain,
  type ReadTablePackageResult,
} from './table-package';
import { createKeyedMutex } from './workspace-git/keyed-mutex';
import {
  executeTablePromotion,
  listTablePromotions,
  resolvePromotedTableAlias,
} from './table-document-promotion';

export interface NativeNotebookTableTransitionSource {
  reference: TableDocumentReference;
  workspaceRoot: string;
  sourcePath: string;
  notebookId: string;
  blockId: string;
  revision: string;
  sourceFingerprint: string;
  sourceFileHashes: Readonly<Record<string, string>>;
  originalBlock: JSONContent;
  tableData: TableData;
  assertCurrent(): void;
  publishReference(reference: TableDocumentReference): Promise<{
    sourceFingerprint: string;
    sourceFileHashes: Readonly<Record<string, string>>;
    revision: string;
  }>;
}

export interface NativeNotebookTableTransitions {
  withSource<T>(
    input: {
      reference: TableDocumentReference;
      expectedRevision: string;
      context?: NativeNotebookTableSourceContext;
    },
    transition: (source: NativeNotebookTableTransitionSource) => Promise<T>
  ): Promise<T>;
  inspectSource(
    reference: TableDocumentReference,
    context?: NativeNotebookTableSourceContext
  ): Promise<{
    workspaceRoot: string;
    sourcePath: string;
    revision: string;
    sourceFingerprint: string;
    sourceFileHashes: Readonly<Record<string, string>>;
    originalBlock: JSONContent | null;
    currentReference?: TableDocumentReference;
  }>;
}

export interface NativeNotebookTableSourceContext {
  workspaceRoot: string;
  sourcePath: string;
}

export interface NativeTableDocumentCommandsOptions {
  db(): Database.Database;
  workspaceRoots(): readonly string[];
  writableWorkspaceRoots(): readonly string[];
  managedRootDir(): string;
  captureWorkspace(root: string, mutating: boolean): () => void;
  files: NativeFileDocumentOwner;
  notebookTables: NativeNotebookTableTransitions;
  reconcileTablePackage(location: TablePackageDestination): Promise<{
    tableId: string;
    fileDocumentId: string;
    headPath: string;
    projectId: string;
  }>;
  io?: {
    writeAtomic?: typeof writeWorkspaceTextFileAtomicInMain;
    syncDirectory?: typeof syncDirectory;
    publishPackage?: typeof publishTablePackageInMain;
    readPackage?: typeof readTablePackageInMain;
    readSnapshot?: typeof readTableSnapshotInMain;
  };
}

interface WorkspaceAuthority {
  workspaceRoot: string;
  readOnly: boolean;
  assertCurrent(): void;
}

interface LocatedTable {
  authority: WorkspaceAuthority;
  projectId: string;
  actual: ReadTablePackageResult;
}

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const intentSchema = z
  .object({
    schema: z.literal('dnaforge.table-transition.v1'),
    kind: z.enum(['create', 'copy']),
    requestId: z.string().uuid(),
    projectId: z.string().uuid(),
    destinationPath: z.string().min(1).max(4096),
    requestFingerprint: digest,
    tableId: z.string().uuid(),
    headText: z.string(),
    headContentHash: digest,
    snapshotText: z.string(),
    snapshotSha256: digest,
  })
  .strict();
type CreationIntent = z.infer<typeof intentSchema>;
type CreationCommand = Extract<TableDocumentCommand, { kind: 'create' | 'copy' }>;
const withRequest = createKeyedMutex();
const protectedNames = new Set(['.git', '.forge', '.dnaforge', '.waypoint', 'node_modules']);

function refuse(message: string): never {
  throw new Error(`TABLE_DOCUMENT_UNAVAILABLE: ${message}`);
}

function contained(root: string, path: string): boolean {
  const member = relative(root, path);
  return !isAbsolute(member) && member !== '..' && !member.startsWith(`..${sep}`);
}

async function existing(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

function physicalDirectory(root: string, path: string, allowMissing: boolean): void {
  if (!contained(root, path)) refuse('The table location is outside its project.');
  let current = root;
  for (const member of ['', ...relative(root, path).split(sep).filter(Boolean)]) {
    if (member) current = join(current, member);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (!entry && allowMissing) continue;
    if (!entry?.isDirectory() || entry.isSymbolicLink())
      refuse('Table directories must be physical directories inside their project.');
  }
}

const packageIo = {
  exists: async (path: string) => (await existing(path)) !== null,
  readDir: async (path: string) =>
    (await readdir(path, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
    })),
};

async function readIntent(path: string): Promise<CreationIntent | null> {
  const initial = await existing(path);
  if (!initial) return null;
  if (
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.size > TABLE_PACKAGE_MAX_BYTES * 5 + 65536
  )
    refuse('The table transition intent is not a bounded physical file.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(TABLE_PACKAGE_MAX_BYTES * 5 + 65536))
      refuse('The table transition intent is not a bounded physical file.');
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    const leaf = await lstat(path, { bigint: true });
    if (
      !before.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      leaf.isSymbolicLink() ||
      leaf.dev !== before.dev ||
      leaf.ino !== before.ino ||
      leaf.size !== before.size ||
      leaf.mtimeNs !== before.mtimeNs ||
      leaf.ctimeNs !== before.ctimeNs ||
      bytes.byteLength !== Number(before.size)
    )
      refuse('The table transition intent changed while it was read.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const intent = intentSchema.parse(JSON.parse(text));
    if (`${canonicalJson(intent)}\n` !== text)
      refuse('The table transition intent is not canonical.');
    const verified = await verifyTablePackageRead({
      headText: intent.headText,
      snapshotText: intent.snapshotText,
      expectedDocumentId: intent.tableId,
      expectedSnapshotSha256: intent.snapshotSha256,
    });
    if (
      hash(intent.headText) !== intent.headContentHash ||
      verified.head.status !== 'active' ||
      verified.head.aliases.length
    )
      refuse('The table creation intent contains inconsistent package bytes.');
    return intent;
  } finally {
    await file.close();
  }
}

export class NativeTableDocumentCommands {
  constructor(private readonly options: NativeTableDocumentCommandsOptions) {}

  async execute(input: TableDocumentCommand): Promise<TableDocumentCommandResult> {
    const command = tableDocumentCommandSchema.parse(input);
    switch (command.kind) {
      case 'create':
      case 'copy':
        return this.create(command);
      case 'open': {
        const authority = await this.workspace(command.location.workspaceRoot, false);
        const location = await this.destination(authority, command.location.packageRoot);
        const identity = await readProjectResourceIdentityInMain(
          authority,
          this.identityDependencies()
        );
        if (!identity)
          refuse('Explicit adoption is required before opening a table in an unmarked project.');
        const actual = await this.readPackage(location);
        authority.assertCurrent();
        return {
          kind: 'resolved',
          table: await this.resolve(
            richTableReference(identity.projectId, actual.head.id),
            authority.workspaceRoot
          ),
        };
      }
      case 'resolve':
        return {
          kind: 'resolved',
          table: await this.resolve(command.reference, command.context?.workspaceRoot),
        };
      case 'pin': {
        if (command.reference.binding.kind !== 'current')
          refuse('Pinning requires a current native table reference.');
        const saved = await this.savedSource(command.reference, command.expectedRevision);
        return {
          kind: 'pinned',
          reference: richTableReference(saved.location.projectId, saved.snapshot.documentId, {
            kind: 'saved-version',
            savedVersionId: saved.sha256,
            sha256: `sha256:${saved.sha256}`,
          }),
        };
      }
      case 'list-promotions':
        return listTablePromotions(command.workspaceRoot, this.options, this.promotionOwners());
      case 'promote':
      case 'recover-promotion':
        return executeTablePromotion(command, this.options, this.promotionOwners());
    }
  }

  private promotionOwners() {
    return {
      workspace: (path: string, mutating: boolean) => this.workspace(path, mutating),
      destination: (authority: WorkspaceAuthority, path: string) =>
        this.destination(authority, path),
      resolve: (reference: TableDocumentReference, context?: string) =>
        this.resolve(reference, context),
    };
  }

  private identityDependencies() {
    return { db: this.options.db(), managedRootDir: this.options.managedRootDir() };
  }

  private async workspace(path: string, mutating: boolean): Promise<WorkspaceAuthority> {
    if (!isAbsolute(path) || path.includes('\0'))
      refuse('A registered absolute project root is required.');
    const root = await realpath(path);
    physicalDirectory(root, path, false);
    const dependencies = this.identityDependencies();
    const initial = admitRegisteredProjectRootInMain(root, dependencies);
    const available = () =>
      this.options.workspaceRoots().filter((candidate) => realpathSync(candidate) === root);
    const writable = () =>
      this.options.writableWorkspaceRoots().some((candidate) => realpathSync(candidate) === root);
    const captured = this.options.captureWorkspace(root, mutating);
    const assertCurrent = () => {
      captured();
      if (available().length !== 1) refuse('The project has no unique authorized owner.');
      const current = admitRegisteredProjectRootInMain(root, this.identityDependencies());
      if (
        current.row.id !== initial.row.id ||
        current.row.repo_uuid !== initial.row.repo_uuid ||
        (mutating && (current.row.access_mode !== 'writable' || !writable()))
      )
        refuse('The registered project authority changed or is not writable.');
      physicalDirectory(root, root, false);
    };
    assertCurrent();
    return {
      workspaceRoot: root,
      readOnly: initial.row.access_mode !== 'writable' || !writable(),
      assertCurrent,
    };
  }

  private async destination(
    authority: WorkspaceAuthority,
    path: string
  ): Promise<TablePackageDestination> {
    const root = authority.workspaceRoot;
    if (!isAbsolute(path) || path.includes('\0'))
      refuse('The table location must be an absolute package directory.');
    const packageRoot = resolve(path);
    if (packageRoot === root || !contained(root, packageRoot))
      refuse('A table package must have its own directory inside its project.');
    if (
      relative(root, packageRoot)
        .split(sep)
        .some((part) => protectedNames.has(part.toLowerCase()))
    )
      refuse('A table package cannot be placed in protected project metadata.');
    physicalDirectory(root, packageRoot, true);
    let ancestor = dirname(packageRoot);
    while (contained(root, ancestor)) {
      if (await existing(ancestor)) {
        physicalDirectory(root, join(ancestor, '.forge'), true);
        if (await detectDocumentPackage(ancestor, packageIo))
          refuse('A table package cannot be nested inside another document package.');
      }
      if (ancestor === root) break;
      ancestor = dirname(ancestor);
    }
    const markerDirectory = join(packageRoot, '.forge');
    physicalDirectory(root, markerDirectory, true);
    if (await existing(markerDirectory)) {
      const entries = await readdir(markerDirectory);
      if (entries.some((name) => !['table.json', 'table-revisions'].includes(name)))
        refuse('The destination contains another package or unrecognized package metadata.');
    }
    authority.assertCurrent();
    return { workspaceRoot: root, packageRoot };
  }

  private readPackage(location: TablePackageDestination) {
    return (this.options.io?.readPackage ?? readTablePackageInMain)(location);
  }

  private async locate(reference: TableDocumentReference, context?: string): Promise<LocatedTable> {
    tableDocumentKey(reference);
    if (reference.backing.kind === 'notebook-inline')
      return this.locate(
        await resolvePromotedTableAlias(reference, context, this.options, this.promotionOwners()),
        context
      );
    if (reference.backing.kind !== 'rich-file')
      refuse('This command requires a portable rich-table reference.');
    const projectId = reference.backing.projectId;
    const tableId = reference.backing.tableId;
    const projects: WorkspaceAuthority[] = [];
    for (const root of this.options.workspaceRoots()) {
      const authority = await this.workspace(root, false);
      const identity = await readProjectResourceIdentityInMain(
        authority,
        this.identityDependencies()
      );
      authority.assertCurrent();
      if (identity?.projectId === projectId) projects.push(authority);
    }
    if (projects.length !== 1)
      refuse('The portable project identity has no unique authorized owner.');
    const authority = projects[0];
    if (context && (await this.workspace(context, false)).workspaceRoot !== authority.workspaceRoot)
      refuse('The table reference belongs to a different project.');
    const matches: ReadTablePackageResult[] = [];
    const pending = [authority.workspaceRoot];
    let visited = 0;
    while (pending.length) {
      if (++visited > 20000)
        refuse('The project is too large for a safe unindexed table identity scan.');
      const directory = pending.pop()!;
      authority.assertCurrent();
      physicalDirectory(authority.workspaceRoot, directory, false);
      const markerDirectory = join(directory, '.forge');
      const marker = await existing(markerDirectory);
      if (marker) {
        physicalDirectory(authority.workspaceRoot, markerDirectory, false);
        if (await existing(join(markerDirectory, 'table.json'))) {
          const location = await this.destination(authority, directory);
          const actual = await this.readPackage(location);
          if (actual.head.id === tableId) matches.push(actual);
          continue;
        }
        if (await detectDocumentPackage(directory, packageIo)) continue;
      }
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          !entry.name.startsWith('.') &&
          !protectedNames.has(entry.name.toLowerCase())
        )
          pending.push(join(directory, entry.name));
      }
    }
    authority.assertCurrent();
    if (matches.length !== 1)
      refuse('The table UUID has no unique verified package in its project.');
    if (matches[0].head.status !== 'active')
      refuse('The table is awaiting a recoverable ownership transition.');
    return { authority, projectId, actual: matches[0] };
  }

  private async inspect(location: LocatedTable): Promise<FileDocumentSnapshot> {
    const copy = await this.options.files.execute({
      target: { path: location.actual.headPath, workspaceRoot: location.authority.workspaceRoot },
      operation: {
        kind: 'inspect',
        offset: 0,
        limit: 2000,
        rowOffset: 0,
        rowLimit: 20,
        columnOffset: 0,
        columnLimit: 20,
      },
      projection: 'document',
    });
    location.authority.assertCurrent();
    if (
      !copy.ready ||
      copy.type !== 'table' ||
      copy.tableDocument?.id !== location.actual.head.id ||
      copy.tableDocument.status !== 'active'
    )
      refuse(copy.reason ?? 'The native file owner could not verify the requested table.');
    return copy;
  }

  private async resolve(
    reference: TableDocumentReference,
    context?: string
  ): Promise<ResolvedTableDocument> {
    const location = await this.locate(reference, context);
    const binding = reference.binding;
    if (binding.kind === 'saved-version') {
      const saved = await (this.options.io?.readSnapshot ?? readTableSnapshotInMain)({
        workspaceRoot: location.authority.workspaceRoot,
        packageRoot: location.actual.packageRoot,
        documentId: location.actual.head.id,
        snapshotSha256: binding.savedVersionId,
      });
      location.authority.assertCurrent();
      return {
        reference: richTableReference(location.projectId, location.actual.head.id, binding),
        tableId: location.actual.head.id,
        projectId: location.projectId,
        readOnly: true,
        owner: {
          kind: 'saved-version',
          snapshotSha256: saved.snapshotSha256,
          snapshot: saved.snapshot,
        },
      };
    }
    const copy = await this.inspect(location);
    return {
      reference: richTableReference(location.projectId, location.actual.head.id),
      tableId: location.actual.head.id,
      projectId: location.projectId,
      readOnly: location.authority.readOnly || copy.readOnly,
      owner: {
        kind: 'file',
        documentId: copy.documentId,
        path: location.actual.headPath,
        workspaceRoot: location.authority.workspaceRoot,
      },
    };
  }

  private async savedSource(
    reference: TableDocumentReference,
    expectedRevision?: string
  ): Promise<{
    location: LocatedTable;
    snapshot: TableSnapshot;
    sha256: string;
  }> {
    const location = await this.locate(reference);
    if (reference.binding.kind === 'saved-version') {
      const saved = await (this.options.io?.readSnapshot ?? readTableSnapshotInMain)({
        workspaceRoot: location.authority.workspaceRoot,
        packageRoot: location.actual.packageRoot,
        documentId: location.actual.head.id,
        snapshotSha256: reference.binding.savedVersionId,
      });
      location.authority.assertCurrent();
      return { location, snapshot: saved.snapshot, sha256: saved.snapshotSha256 };
    }
    if (!expectedRevision) refuse('A current table requires its exact expected native revision.');
    const assertSaved = (copy: FileDocumentSnapshot) => {
      if (
        copy.revision !== expectedRevision ||
        copy.dirty ||
        copy.saving ||
        copy.recoveryId ||
        copy.tableDocument?.snapshotSha256 !== copy.tableDocument?.persistedSnapshotSha256 ||
        copy.tableDocument?.persistedSnapshotSha256 !== location.actual.head.snapshotSha256
      )
        refuse(
          'Pinning or copying requires a clean, saved table at the exact expected native revision.'
        );
    };
    assertSaved(await this.inspect(location));
    const saved = await (this.options.io?.readSnapshot ?? readTableSnapshotInMain)({
      workspaceRoot: location.authority.workspaceRoot,
      packageRoot: location.actual.packageRoot,
      documentId: location.actual.head.id,
      snapshotSha256: location.actual.head.snapshotSha256,
    });
    assertSaved(await this.inspect(location));
    return { location, snapshot: saved.snapshot, sha256: saved.snapshotSha256 };
  }

  private async create(command: CreationCommand): Promise<TableDocumentCommandResult> {
    const authority = await this.workspace(command.destination.workspaceRoot, true);
    return withRequest(`${authority.workspaceRoot}:${command.requestId}`, async () => {
      authority.assertCurrent();
      const destination = await this.destination(authority, command.destination.packageRoot);
      const destinationPath = relative(authority.workspaceRoot, destination.packageRoot)
        .split(sep)
        .join('/');
      const intentDirectory = join(authority.workspaceRoot, '.forge', 'table-transitions');
      physicalDirectory(authority.workspaceRoot, intentDirectory, true);
      const intentPath = join(intentDirectory, `${command.requestId}.json`);
      let intent = await readIntent(intentPath);
      if (
        !intent &&
        (await existing(destination.packageRoot)) &&
        (await readdir(destination.packageRoot)).length
      )
        refuse('A new table requires an empty destination directory.');
      const identity = await ensureProjectResourceIdentityInMain(authority, {
        ...this.identityDependencies(),
        writeAtomic: this.options.io?.writeAtomic,
        syncDirectory: this.options.io?.syncDirectory,
      });
      authority.assertCurrent();
      const requestFingerprint = hash(
        canonicalJson(
          command.kind === 'create'
            ? {
                kind: command.kind,
                projectId: identity.projectId,
                destinationPath,
                title: command.title,
                rows: command.rows,
                columns: command.columns,
              }
            : {
                kind: command.kind,
                projectId: identity.projectId,
                destinationPath,
                source: tableDocumentKey(command.source),
                expectedRevision: command.expectedRevision,
                title: command.title,
              }
        )
      );
      const assertIntent = (value: CreationIntent) => {
        if (
          value.requestId !== command.requestId ||
          value.kind !== command.kind ||
          value.projectId !== identity.projectId ||
          value.destinationPath !== destinationPath ||
          value.requestFingerprint !== requestFingerprint
        )
          refuse('This mutation request ID already belongs to different table arguments.');
      };
      if (intent) assertIntent(intent);
      else {
        const id = randomUUID();
        const source =
          command.kind === 'copy'
            ? await this.savedSource(command.source, command.expectedRevision)
            : null;
        const snapshot = parseTableSnapshot(
          canonicalJson(
            source
              ? {
                  ...source.snapshot,
                  documentId: id,
                  title:
                    command.kind === 'copy'
                      ? (command.title ?? source.snapshot.title)
                      : source.snapshot.title,
                }
              : {
                  schema: TABLE_SNAPSHOT_SCHEMA,
                  documentId: id,
                  title: command.kind === 'create' ? command.title : '',
                  data: {
                    rows: command.kind === 'create' ? command.rows : 1,
                    cols: command.kind === 'create' ? command.columns : 1,
                    cells: [],
                  },
                }
          )
        );
        const inherited: Record<string, unknown> = source ? { ...source.location.actual.head } : {};
        delete inherited.promotionId;
        const head: TablePackageHead = {
          ...inherited,
          schema: TABLE_PACKAGE_SCHEMA,
          id,
          snapshot,
          snapshotSha256: await tableSnapshotSha256(snapshot),
          aliases: [],
          status: 'active',
          ...(source
            ? {
                origin: {
                  projectId: source.location.projectId,
                  tableId: source.snapshot.documentId,
                  snapshotSha256: source.sha256,
                },
              }
            : {}),
        };
        const headText = serializeTablePackageHead(head);
        const candidate: CreationIntent = {
          schema: 'dnaforge.table-transition.v1',
          kind: command.kind,
          requestId: command.requestId,
          projectId: identity.projectId,
          destinationPath,
          requestFingerprint,
          tableId: id,
          headText,
          headContentHash: hash(headText),
          snapshotText: serializeTableSnapshot(snapshot),
          snapshotSha256: head.snapshotSha256,
        };
        const write = this.options.io?.writeAtomic ?? writeWorkspaceTextFileAtomicInMain;
        try {
          await write(
            {
              workspaceRoot: authority.workspaceRoot,
              path: intentPath,
              content: `${canonicalJson(candidate)}\n`,
              mode: 'create',
              artifactNoun: 'table transition intent',
            },
            {
              durable: true,
              syncDirectory: this.options.io?.syncDirectory ?? syncDirectory,
              beforePublish: authority.assertCurrent,
            }
          );
        } catch (error) {
          const collision =
            (error as NodeJS.ErrnoException).code === 'EEXIST' ||
            (error instanceof Error &&
              error.message ===
                'A table transition intent artifact already exists at that location.');
          if (!collision) throw error;
          intent = await readIntent(intentPath);
          if (!intent) throw error;
          assertIntent(intent);
        }
        intent ??= await readIntent(intentPath);
        if (!intent) refuse('The durable table transition intent is missing.');
        assertIntent(intent);
      }
      authority.assertCurrent();
      const sync = this.options.io?.syncDirectory ?? syncDirectory;
      await sync(intentDirectory);
      await sync(dirname(intentDirectory));
      await sync(authority.workspaceRoot);
      authority.assertCurrent();
      const actual = await (this.options.io?.publishPackage ?? publishTablePackageInMain)(
        { ...destination, head: parseTablePackageHead(intent.headText), mode: 'create' },
        {
          assertCurrent: authority.assertCurrent,
          writeAtomic: this.options.io?.writeAtomic,
          syncDirectory: this.options.io?.syncDirectory,
        }
      );
      if (actual.head.id !== intent.tableId || actual.headText !== intent.headText)
        refuse('The published table does not match its durable intent.');
      authority.assertCurrent();
      const receipt = await this.options.reconcileTablePackage(destination);
      authority.assertCurrent();
      if (
        receipt.projectId !== identity.projectId ||
        receipt.tableId !== intent.tableId ||
        receipt.headPath !== actual.headPath ||
        !receipt.fileDocumentId
      )
        refuse('The table catalog receipt does not match the published resource.');
      const table = await this.resolve(
        richTableReference(identity.projectId, intent.tableId),
        authority.workspaceRoot
      );
      if (
        table.owner.kind !== 'file' ||
        table.owner.documentId !== receipt.fileDocumentId ||
        table.owner.path !== receipt.headPath
      )
        refuse('The native table owner does not match its catalog receipt.');
      return { kind: 'created', table };
    });
  }
}
