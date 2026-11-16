import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '../shared/canonical-json';
import { detectDocumentPackage } from '../shared/document-package';
import { stripWorkspaceScope } from '../shared/workspace-scoped-identity';
import {
  richTableReference,
  tableDocumentKey,
  tableDocumentReferenceSchema,
  type TableDocumentReference,
} from '../shared/table-document-reference';
import type {
  ResolvedTableDocument,
  TableDocumentCommand,
  TableDocumentCommandResult,
  TablePackageDestination,
} from '../shared/table-document-command';
import {
  TABLE_PACKAGE_SCHEMA,
  TABLE_SNAPSHOT_SCHEMA,
  parseTablePackageHead,
  serializeTablePackageHead,
  serializeTableSnapshot,
  tableSnapshotSha256,
  verifyTablePackageRead,
  type TableLegacyAlias,
  type TablePackageHead,
  type TableSnapshot,
} from '../shared/table-package';
import type {
  NativeNotebookTableTransitionSource,
  NativeTableDocumentCommandsOptions,
} from './table-document-commands';
import {
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
import { withWorkspaceMutation } from './workspace-sync-mutation-lease';

export interface TablePromotionAuthority {
  workspaceRoot: string;
  readOnly: boolean;
  assertCurrent(): void;
}

export interface TablePromotionOwners {
  workspace(path: string, mutating: boolean): Promise<TablePromotionAuthority>;
  destination(authority: TablePromotionAuthority, path: string): Promise<TablePackageDestination>;
  resolve(reference: TableDocumentReference, context?: string): Promise<ResolvedTableDocument>;
}

type PromotionCommand = Extract<TableDocumentCommand, { kind: 'promote' | 'recover-promotion' }>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const intentSchema = z
  .object({
    schema: z.literal('dnaforge.table-transition.v1'),
    kind: z.literal('promote'),
    requestId: uuid,
    promotionId: uuid,
    projectId: uuid,
    tableId: uuid,
    destinationPath: z.string().min(1).max(4096),
    requestFingerprint: digest,
    pendingHeadText: z.string(),
    pendingHeadContentHash: digest,
    snapshotText: z.string(),
    snapshotSha256: digest,
    source: z
      .object({
        notebookId: z.string().min(1).max(1000),
        packagePath: z.string().min(1).max(4096),
        blockId: z.string().min(1).max(1000),
        legacyReference: tableDocumentReferenceSchema,
        originalBlock: z.record(z.unknown()),
        originalBlockSha256: digest,
        sourceFingerprint: z.string().min(1),
        sourceFileHashes: z.record(digest),
        originalFiles: z.record(z.object({ sha256: digest, base64: z.string() }).strict()),
      })
      .strict(),
  })
  .strict();
type PromotionIntent = z.infer<typeof intentSchema>;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_INTENT_BYTES = 256 * 1024 * 1024;
const protectedNames = new Set(['.git', '.forge', '.dnaforge', '.waypoint', 'node_modules']);
const withTransition = createKeyedMutex();
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytesForBlock = (block: unknown) => `${canonicalJson(block)}\n`;

function refuse(message: string): never {
  throw new Error(`TABLE_PROMOTION_CONFLICT: ${message}`);
}

function memberPath(path: string): string {
  if (
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    isAbsolute(path) ||
    /^[a-z]:/i.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    refuse('The transition contains an invalid relative path.');
  return path;
}

function projectMember(root: string, path: string): string {
  const member = relative(root, resolve(path)).split(sep).join('/');
  return memberPath(member);
}

function physical(root: string, path: string, file: boolean, allowMissing = false): void {
  const member = relative(root, path);
  if (isAbsolute(member) || member === '..' || member.startsWith(`..${sep}`))
    refuse('The transition path is outside its project.');
  let current = root;
  const parts = member.split(sep).filter(Boolean);
  for (const [index, part] of ['', ...parts].entries()) {
    if (part) current = join(current, part);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (!entry && allowMissing) continue;
    if (
      !entry ||
      entry.isSymbolicLink() ||
      (file && index === parts.length ? !entry.isFile() : !entry.isDirectory())
    )
      refuse('Transition paths must be physical files and directories.');
  }
}

async function existing(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function readBytes(root: string, path: string, maximum: number): Promise<Buffer> {
  physical(root, path, true);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maximum))
      refuse('The source or transition archive exceeds its supported size.');
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    const leaf = await lstat(path, { bigint: true });
    if (
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
      refuse('The source or transition archive changed during reading.');
    physical(root, path, true);
    return bytes;
  } finally {
    await file.close();
  }
}

function aliasFor(intent: PromotionIntent): TableLegacyAlias {
  return {
    kind: 'notebook-inline',
    projectId: intent.projectId,
    notebookId: intent.source.notebookId,
    blockId: intent.source.blockId,
    legacyReference: intent.source.legacyReference,
    originalBlock: intent.source.originalBlock,
    originalBlockSha256: intent.source.originalBlockSha256,
  };
}

function hasAlias(head: TablePackageHead, intent: PromotionIntent): boolean {
  const matches = head.aliases.filter(
    (alias) =>
      alias.kind === 'notebook-inline' &&
      alias.projectId === intent.projectId &&
      alias.notebookId === intent.source.notebookId &&
      alias.blockId === intent.source.blockId
  );
  return matches.length === 1 && canonicalJson(matches[0]) === canonicalJson(aliasFor(intent));
}

async function readIntent(root: string, promotionId: string): Promise<PromotionIntent | null> {
  uuid.parse(promotionId);
  const directory = join(root, '.forge', 'table-transitions');
  physical(root, directory, false, true);
  const path = join(directory, `${promotionId}.json`);
  if (!(await existing(path))) return null;
  const text = new TextDecoder('utf-8', { fatal: true }).decode(
    await readBytes(root, path, MAX_INTENT_BYTES)
  );
  const intent = intentSchema.parse(JSON.parse(text));
  if (
    intent.requestId !== promotionId ||
    intent.promotionId !== promotionId ||
    `${canonicalJson(intent)}\n` !== text
  )
    refuse('The promotion intent identity or canonical bytes do not agree.');
  memberPath(intent.destinationPath);
  memberPath(intent.source.packagePath);
  const reference = intent.source.legacyReference;
  if (
    reference.backing.kind !== 'notebook-inline' ||
    reference.binding.kind !== 'current' ||
    reference.backing.blockId !== intent.source.blockId ||
    stripWorkspaceScope(reference.backing.notebookDocumentId) !== intent.source.notebookId ||
    intent.source.originalBlock.attrs === null ||
    typeof intent.source.originalBlock.attrs !== 'object'
  )
    refuse('The promotion source identity is inconsistent.');
  tableDocumentKey(reference);
  if (hash(bytesForBlock(intent.source.originalBlock)) !== intent.source.originalBlockSha256)
    refuse('The archived original table payload has changed.');
  const names = Object.keys(intent.source.sourceFileHashes).sort();
  if (
    !names.length ||
    !names.includes('.forge/notebook.json') ||
    canonicalJson(names) !== canonicalJson(Object.keys(intent.source.originalFiles).sort())
  )
    refuse('The original notebook byte archive is incomplete.');
  let total = 0;
  for (const name of names) {
    memberPath(name);
    const archive = intent.source.originalFiles[name];
    const bytes = Buffer.from(archive.base64, 'base64');
    total += bytes.length;
    if (
      total > MAX_SOURCE_BYTES ||
      bytes.toString('base64') !== archive.base64 ||
      archive.sha256 !== intent.source.sourceFileHashes[name] ||
      hash(bytes) !== archive.sha256
    )
      refuse('The original notebook byte archive does not match its saved hashes.');
  }
  const verified = await verifyTablePackageRead({
    headText: intent.pendingHeadText,
    snapshotText: intent.snapshotText,
    expectedDocumentId: intent.tableId,
    expectedSnapshotSha256: intent.snapshotSha256,
  });
  if (
    verified.head.status !== 'pending-promotion' ||
    verified.head.promotionId !== promotionId ||
    hash(intent.pendingHeadText) !== intent.pendingHeadContentHash ||
    !hasAlias(verified.head, intent)
  )
    refuse('The staged table does not agree with its promotion intent.');
  return intent;
}

async function projectId(
  options: NativeTableDocumentCommandsOptions,
  authority: TablePromotionAuthority,
  owners: TablePromotionOwners,
  create: boolean
) {
  const dependencies = { db: options.db(), managedRootDir: options.managedRootDir() };
  const identity = create
    ? await ensureProjectResourceIdentityInMain(authority, {
        ...dependencies,
        writeAtomic: options.io?.writeAtomic,
        syncDirectory: options.io?.syncDirectory,
      })
    : await readProjectResourceIdentityInMain(authority, dependencies);
  if (!identity) refuse('The project has no existing durable identity for promotion recovery.');
  let matches = 0;
  for (const root of options.workspaceRoots()) {
    const current = await owners.workspace(root, false);
    const candidate = await readProjectResourceIdentityInMain(current, dependencies);
    current.assertCurrent();
    if (candidate?.projectId === identity.projectId) matches++;
  }
  authority.assertCurrent();
  if (matches !== 1) refuse('The portable project identity has no unique authorized owner.');
  return identity.projectId;
}

export async function projectTablePackages(
  options: NativeTableDocumentCommandsOptions,
  authority: TablePromotionAuthority,
  owners: TablePromotionOwners
): Promise<ReadTablePackageResult[]> {
  const result: ReadTablePackageResult[] = [];
  const pending = [authority.workspaceRoot];
  let count = 0;
  const io = {
    exists: async (path: string) => (await existing(path)) !== null,
    readDir: async (path: string) =>
      (await readdir(path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory(),
      })),
  };
  while (pending.length) {
    if (++count > 20000) refuse('The project exceeds the supported safe table scan size.');
    const directory = pending.pop()!;
    physical(authority.workspaceRoot, directory, false);
    const marker = join(directory, '.forge');
    if (await existing(marker)) {
      physical(authority.workspaceRoot, marker, false);
      if (await existing(join(marker, 'table.json'))) {
        const location = await owners.destination(authority, directory);
        result.push(await (options.io?.readPackage ?? readTablePackageInMain)(location));
        continue;
      }
      if (await detectDocumentPackage(directory, io)) continue;
    }
    authority.assertCurrent();
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        !entry.name.startsWith('.') &&
        !protectedNames.has(entry.name.toLowerCase())
      )
        pending.push(join(directory, entry.name));
  }
  authority.assertCurrent();
  return result;
}

export async function resolvePromotedTableAlias(
  reference: TableDocumentReference,
  context: string | undefined,
  options: NativeTableDocumentCommandsOptions,
  owners: TablePromotionOwners
): Promise<TableDocumentReference> {
  if (reference.backing.kind !== 'notebook-inline' || reference.binding.kind !== 'current')
    refuse('Choose a supported current inline table reference.');
  const backing = reference.backing;
  const sourceKey = tableDocumentKey(reference);
  const matches: TableDocumentReference[] = [];
  const projectOwners = new Map<string, string>();
  const selected = context ? (await owners.workspace(context, false)).workspaceRoot : undefined;
  for (const root of options.workspaceRoots()) {
    const authority = await owners.workspace(root, false);
    const identity = await readProjectResourceIdentityInMain(authority, {
      db: options.db(),
      managedRootDir: options.managedRootDir(),
    });
    if (!identity) continue;
    const prior = projectOwners.get(identity.projectId);
    if (prior && prior !== authority.workspaceRoot)
      refuse('The portable project identity has duplicate owners.');
    projectOwners.set(identity.projectId, authority.workspaceRoot);
    if (selected && selected !== authority.workspaceRoot) continue;
    for (const table of await projectTablePackages(options, authority, owners)) {
      if (table.head.status !== 'active') continue;
      for (const alias of table.head.aliases) {
        if (
          alias.kind !== 'notebook-inline' ||
          alias.projectId !== identity.projectId ||
          alias.notebookId !== stripWorkspaceScope(backing.notebookDocumentId) ||
          alias.blockId !== backing.blockId
        )
          continue;
        if (!selected && tableDocumentKey(alias.legacyReference) !== sourceKey) continue;
        matches.push(richTableReference(identity.projectId, table.head.id));
      }
    }
  }
  if (matches.length !== 1) refuse('The retired inline table has no unique verified alias owner.');
  return matches[0];
}

function fingerprint(
  command: Extract<TableDocumentCommand, { kind: 'promote' }>,
  id: string,
  destinationPath: string
) {
  return hash(
    canonicalJson({
      kind: 'promote',
      projectId: id,
      destinationPath,
      source: tableDocumentKey(command.source),
      expectedRevision: command.expectedRevision,
    })
  );
}

async function archiveSource(root: string, source: NativeNotebookTableTransitionSource) {
  physical(root, source.sourcePath, false);
  const names = Object.keys(source.sourceFileHashes).sort();
  if (!names.length || !names.includes('.forge/notebook.json'))
    refuse('Save the notebook as a canonical package before extracting its table.');
  const originalFiles: PromotionIntent['source']['originalFiles'] = {};
  let total = 0;
  for (const name of names) {
    memberPath(name);
    const bytes = await readBytes(root, join(source.sourcePath, name), MAX_SOURCE_BYTES - total);
    total += bytes.length;
    const sha256 = hash(bytes);
    if (sha256 !== source.sourceFileHashes[name])
      refuse('The original notebook bytes changed before they could be archived.');
    originalFiles[name] = { sha256, base64: bytes.toString('base64') };
    source.assertCurrent();
  }
  return originalFiles;
}

async function writeIntent(
  options: NativeTableDocumentCommandsOptions,
  authority: TablePromotionAuthority,
  intent: PromotionIntent
) {
  const directory = join(authority.workspaceRoot, '.forge', 'table-transitions');
  physical(authority.workspaceRoot, directory, false, true);
  const content = `${canonicalJson(intent)}\n`;
  if (Buffer.byteLength(content) > MAX_INTENT_BYTES)
    refuse('The original notebook archive exceeds the supported promotion size.');
  const write = options.io?.writeAtomic ?? writeWorkspaceTextFileAtomicInMain;
  try {
    await write(
      {
        workspaceRoot: authority.workspaceRoot,
        path: join(directory, `${intent.promotionId}.json`),
        content,
        mode: 'create',
        artifactNoun: 'table transition intent',
      },
      {
        durable: true,
        syncDirectory: options.io?.syncDirectory ?? syncDirectory,
        beforePublish: authority.assertCurrent,
      }
    );
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' &&
      !(error instanceof Error && /already exists at that location\.$/.test(error.message))
    )
      throw error;
  }
  const saved = await readIntent(authority.workspaceRoot, intent.promotionId);
  if (!saved || saved.requestFingerprint !== intent.requestFingerprint)
    refuse('This promotion request ID belongs to different arguments.');
  const sync = options.io?.syncDirectory ?? syncDirectory;
  for (const path of [directory, dirname(directory), authority.workspaceRoot]) {
    authority.assertCurrent();
    physical(authority.workspaceRoot, path, false);
    await sync(path);
  }
  return saved;
}

async function stage(
  options: NativeTableDocumentCommandsOptions,
  authority: TablePromotionAuthority,
  owners: TablePromotionOwners,
  intent: PromotionIntent
): Promise<ReadTablePackageResult> {
  const candidates = (await projectTablePackages(options, authority, owners)).filter(
    (table) => table.head.id === intent.tableId
  );
  if (candidates.length > 1) refuse('The promoted table identity has duplicate packages.');
  const location =
    candidates[0] ??
    (await owners.destination(
      authority,
      join(authority.workspaceRoot, memberPath(intent.destinationPath))
    ));
  if (candidates[0]) {
    const actual = candidates[0];
    if (actual.head.promotionId !== intent.promotionId || !hasAlias(actual.head, intent))
      refuse('The destination no longer belongs to this source transition.');
    if (actual.head.status === 'pending-promotion' && actual.headText !== intent.pendingHeadText)
      refuse('The pending destination changed after it was staged.');
    return actual;
  }
  const actual = await (options.io?.publishPackage ?? publishTablePackageInMain)(
    { ...location, head: parseTablePackageHead(intent.pendingHeadText), mode: 'create' },
    {
      assertCurrent: authority.assertCurrent,
      writeAtomic: options.io?.writeAtomic,
      syncDirectory: options.io?.syncDirectory,
    }
  );
  if (actual.headText !== intent.pendingHeadText)
    refuse('The staged package differs from its durable intent.');
  return actual;
}

async function resume(
  options: NativeTableDocumentCommandsOptions,
  authority: TablePromotionAuthority,
  owners: TablePromotionOwners,
  intent: PromotionIntent
): Promise<TableDocumentCommandResult> {
  if ((await projectId(options, authority, owners, false)) !== intent.projectId)
    refuse('The recovery project does not own this transition.');
  const context = {
    workspaceRoot: authority.workspaceRoot,
    sourcePath: join(authority.workspaceRoot, memberPath(intent.source.packagePath)),
  };
  const reference = richTableReference(intent.projectId, intent.tableId);
  let source = await options.notebookTables.inspectSource(intent.source.legacyReference, context);
  authority.assertCurrent();
  if (source.workspaceRoot !== context.workspaceRoot || source.sourcePath !== context.sourcePath)
    refuse('The source owner does not match the portable journal location.');
  if (source.currentReference) {
    if (tableDocumentKey(source.currentReference) !== tableDocumentKey(reference))
      refuse('The source placement now points to another table.');
  } else {
    if (
      !source.originalBlock ||
      canonicalJson(source.originalBlock) !== canonicalJson(intent.source.originalBlock) ||
      source.sourceFingerprint !== intent.source.sourceFingerprint ||
      canonicalJson(source.sourceFileHashes) !== canonicalJson(intent.source.sourceFileHashes)
    )
      refuse('The source changed after extraction was prepared. Both versions remain preserved.');
    await options.notebookTables.withSource(
      { reference: intent.source.legacyReference, expectedRevision: source.revision, context },
      async (captured) => {
        if (
          canonicalJson(captured.originalBlock) !== canonicalJson(intent.source.originalBlock) ||
          captured.sourceFingerprint !== intent.source.sourceFingerprint ||
          canonicalJson(captured.sourceFileHashes) !== canonicalJson(intent.source.sourceFileHashes)
        )
          refuse('The source changed before recovery could publish its selected placement.');
        const actual = await withWorkspaceMutation(authority.workspaceRoot, () =>
          stage(options, authority, owners, intent)
        );
        if (actual.head.status !== 'pending-promotion')
          refuse('An active destination cannot reacquire a writable inline source.');
        captured.assertCurrent();
        authority.assertCurrent();
        await captured.publishReference(reference);
      }
    );
    source = await options.notebookTables.inspectSource(intent.source.legacyReference, context);
    if (
      !source.currentReference ||
      tableDocumentKey(source.currentReference) !== tableDocumentKey(reference)
    )
      refuse('The native source did not acknowledge its durable reference.');
  }
  let actual = await withWorkspaceMutation(authority.workspaceRoot, async () => {
    const current = await stage(options, authority, owners, intent);
    if (current.head.status === 'active') return current;
    return (options.io?.publishPackage ?? publishTablePackageInMain)(
      {
        workspaceRoot: authority.workspaceRoot,
        packageRoot: current.packageRoot,
        head: { ...current.head, status: 'active' },
        mode: 'replace',
        expectedContentHash: current.headContentHash,
      },
      {
        assertCurrent: authority.assertCurrent,
        writeAtomic: options.io?.writeAtomic,
        syncDirectory: options.io?.syncDirectory,
      }
    );
  });
  const archived = await (options.io?.readSnapshot ?? readTableSnapshotInMain)({
    workspaceRoot: authority.workspaceRoot,
    packageRoot: actual.packageRoot,
    documentId: intent.tableId,
    snapshotSha256: intent.snapshotSha256,
  });
  if (archived.snapshotText !== intent.snapshotText)
    refuse('The original immutable table snapshot was not retained.');
  const location = { workspaceRoot: authority.workspaceRoot, packageRoot: actual.packageRoot };
  authority.assertCurrent();
  const receipt = await options.reconcileTablePackage(location);
  authority.assertCurrent();
  actual = await (options.io?.readPackage ?? readTablePackageInMain)(location);
  if (
    receipt.projectId !== intent.projectId ||
    receipt.tableId !== intent.tableId ||
    receipt.headPath !== actual.headPath ||
    actual.head.status !== 'active' ||
    actual.head.promotionId !== intent.promotionId ||
    !hasAlias(actual.head, intent)
  )
    refuse('The active table and native catalog completion do not agree.');
  const table = await owners.resolve(reference, authority.workspaceRoot);
  if (
    table.owner.kind !== 'file' ||
    table.owner.documentId !== receipt.fileDocumentId ||
    table.owner.path !== actual.headPath
  )
    refuse('The active table has no matching native file owner.');
  return { kind: 'promoted', promotionId: intent.promotionId, table };
}

export async function executeTablePromotion(
  command: PromotionCommand,
  options: NativeTableDocumentCommandsOptions,
  owners: TablePromotionOwners
): Promise<TableDocumentCommandResult> {
  const root =
    command.kind === 'promote' ? command.destination.workspaceRoot : command.workspaceRoot;
  const authority = await owners.workspace(root, true);
  const promotionId = command.kind === 'promote' ? command.requestId : command.promotionId;
  return withTransition(`${authority.workspaceRoot}:${promotionId}`, async () => {
    let intent = await readIntent(authority.workspaceRoot, promotionId);
    if (command.kind === 'recover-promotion') {
      if (!intent) refuse('The requested durable promotion intent is missing.');
      return resume(options, authority, owners, intent);
    }
    if (
      command.source.backing.kind !== 'notebook-inline' ||
      command.source.binding.kind !== 'current'
    )
      refuse('Only a current inline notebook table can be extracted.');
    const destination = await owners.destination(authority, command.destination.packageRoot);
    const destinationPath = projectMember(authority.workspaceRoot, destination.packageRoot);
    if (intent) {
      if (intent.requestFingerprint !== fingerprint(command, intent.projectId, destinationPath))
        refuse('This promotion request ID belongs to different arguments.');
      return resume(options, authority, owners, intent);
    }
    if (
      (await existing(destination.packageRoot)) &&
      (await readdir(destination.packageRoot)).length
    )
      refuse('Table extraction requires a new empty destination.');
    await options.notebookTables.withSource(
      { reference: command.source, expectedRevision: command.expectedRevision },
      async (source) => {
        if (source.workspaceRoot !== authority.workspaceRoot)
          refuse('Table extraction currently requires the same owning project.');
        const sourcePath = projectMember(authority.workspaceRoot, source.sourcePath);
        if (
          sourcePath === destinationPath ||
          destinationPath.startsWith(`${sourcePath}/`) ||
          sourcePath.startsWith(`${destinationPath}/`)
        )
          refuse('The source and destination table packages overlap.');
        const originalFiles = await archiveSource(authority.workspaceRoot, source);
        const saved = await withWorkspaceMutation(authority.workspaceRoot, async () => {
          const id = await projectId(options, authority, owners, true);
          const tableId = randomUUID();
          const snapshot: TableSnapshot = {
            schema: TABLE_SNAPSHOT_SCHEMA,
            documentId: tableId,
            title: source.tableData.name ?? 'Table',
            data: source.tableData,
          };
          const originalBlockSha256 = hash(bytesForBlock(source.originalBlock));
          const snapshotSha256 = await tableSnapshotSha256(snapshot);
          const candidate: PromotionIntent = {
            schema: 'dnaforge.table-transition.v1',
            kind: 'promote',
            promotionId,
            requestId: command.requestId,
            projectId: id,
            tableId,
            destinationPath,
            requestFingerprint: fingerprint(command, id, destinationPath),
            pendingHeadText: '',
            pendingHeadContentHash: '',
            snapshotText: serializeTableSnapshot(snapshot),
            snapshotSha256,
            source: {
              notebookId: source.notebookId,
              packagePath: sourcePath,
              blockId: source.blockId,
              legacyReference: source.reference,
              originalBlock: structuredClone(source.originalBlock),
              originalBlockSha256,
              sourceFingerprint: source.sourceFingerprint,
              sourceFileHashes: structuredClone(source.sourceFileHashes),
              originalFiles,
            },
          };
          const head: TablePackageHead = {
            schema: TABLE_PACKAGE_SCHEMA,
            id: tableId,
            snapshotSha256,
            snapshot,
            aliases: [aliasFor(candidate)],
            status: 'pending-promotion',
            promotionId,
          };
          candidate.pendingHeadText = serializeTablePackageHead(head);
          candidate.pendingHeadContentHash = hash(candidate.pendingHeadText);
          source.assertCurrent();
          authority.assertCurrent();
          return writeIntent(options, authority, candidate);
        });
        intent = saved;
        await withWorkspaceMutation(authority.workspaceRoot, () =>
          stage(options, authority, owners, saved)
        );
        source.assertCurrent();
        authority.assertCurrent();
        await source.publishReference(richTableReference(saved.projectId, saved.tableId));
      }
    );
    if (!intent) refuse('The durable extraction intent was not acknowledged.');
    return resume(options, authority, owners, intent);
  });
}
