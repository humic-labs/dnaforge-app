import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { constants, lstatSync } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  TABLE_PACKAGE_MAX_BYTES,
  TablePackageError,
  parseTablePackageHead,
  parseTableSnapshot,
  serializeTablePackageHead,
  serializeTableSnapshot,
  tablePackagePaths,
  tablePackageRevisionPath,
  verifyTablePackageRead,
  type TablePackageHead,
  type TableSnapshot,
} from '../shared/table-package';
import {
  WorkspaceFilePreconditionError,
  WorkspaceFilePublicationUncertainError,
  writeWorkspaceTextFileAtomicInMain,
} from './primer-artifact-files';
import { syncDirectory } from './fs-durability';
import { createKeyedMutex } from './workspace-git/keyed-mutex';
import type { WorkspaceTextFileAtomicWriteInput } from '../shared/workspace-file-atomic';

export interface TablePackageLocation {
  workspaceRoot: string;
  packageRoot: string;
}

export interface ReadTablePackageInput extends TablePackageLocation {
  expectedDocumentId?: string;
  expectedSnapshotSha256?: string;
}

export interface ReadTablePackageResult extends TablePackageLocation {
  headPath: string;
  head: TablePackageHead;
  snapshot: TableSnapshot;
  headText: string;
  snapshotText: string;
  headContentHash: string;
}

export interface ReadTableSnapshotInput extends TablePackageLocation {
  documentId: string;
  snapshotSha256: string;
}

export interface PublishTablePackageInput extends TablePackageLocation {
  head: TablePackageHead;
  mode: 'create' | 'replace';
  expectedContentHash?: string;
}

export interface TablePackagePublicationOptions {
  assertCurrent(): void;
  writeAtomic?: typeof writeWorkspaceTextFileAtomicInMain;
  syncDirectory?: typeof syncDirectory;
}

export interface PublishTablePackageResult extends ReadTablePackageResult {
  publication: 'committed' | 'already-committed';
  warnings?: string[];
}

const withPublication = createKeyedMutex();
const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const validDigest = /^[a-f0-9]{64}$/;

function invalid(message: string): never {
  throw new TablePackageError('TABLE_PACKAGE_INVALID', message);
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

function current(options: TablePackagePublicationOptions): void {
  const result: unknown = options.assertCurrent();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    throw new WorkspaceFilePreconditionError('Table publication authority must be synchronous.');
  }
}

async function directoryPath(root: string, path: string, allowMissing = false): Promise<void> {
  if (!contained(root, path)) invalid('The table package is outside its owning project.');
  const parts = relative(root, path).split(sep).filter(Boolean);
  let candidate = root;
  for (const part of ['', ...parts]) {
    if (part) candidate = join(candidate, part);
    const entry = await existing(candidate);
    if (!entry && allowMissing) return;
    if (!entry?.isDirectory() || entry.isSymbolicLink())
      invalid('Table package directories must be physical directories without symbolic links.');
  }
}

function physicalPath(root: string, path: string, allowMissingLeaf = false): void {
  if (!contained(root, path)) invalid('The table package is outside its owning project.');
  const parts = relative(root, path).split(sep).filter(Boolean);
  let candidate = root;
  const owner = lstatSync(root);
  if (!owner.isDirectory() || owner.isSymbolicLink())
    invalid('The table project directory changed before publication.');
  for (const [index, part] of parts.entries()) {
    candidate = join(candidate, part);
    const entry = lstatSync(candidate, { throwIfNoEntry: false });
    const leaf = index === parts.length - 1;
    if (!entry && leaf && allowMissingLeaf) return;
    if (!entry || entry.isSymbolicLink() || (leaf ? !entry.isFile() : !entry.isDirectory()))
      invalid('The table package path changed before publication.');
  }
}

async function location(input: TablePackageLocation): Promise<TablePackageLocation> {
  tablePackagePaths(input.packageRoot);
  if (typeof input.workspaceRoot !== 'string' || !isAbsolute(input.workspaceRoot))
    invalid('The table requires an absolute owning project directory.');
  const lexicalRoot = resolve(input.workspaceRoot);
  const lexicalPackage = resolve(input.packageRoot);
  if (!contained(lexicalRoot, lexicalPackage))
    invalid('The table package is outside its owning project.');
  const owner = await lstat(lexicalRoot);
  if (!owner.isDirectory() || owner.isSymbolicLink())
    invalid('The owning project must be a physical directory.');
  const workspaceRoot = await realpath(lexicalRoot);
  const packageRoot = join(workspaceRoot, relative(lexicalRoot, lexicalPackage));
  await directoryPath(workspaceRoot, packageRoot, true);
  const paths = tablePackagePaths(packageRoot);
  await directoryPath(workspaceRoot, dirname(paths.headPath), true);
  await directoryPath(workspaceRoot, paths.revisionsDirectory, true);
  return { workspaceRoot, packageRoot };
}

async function readText(root: string, path: string): Promise<string> {
  await directoryPath(root, dirname(path));
  const leaf = await lstat(path);
  if (!leaf.isFile() || leaf.isSymbolicLink())
    invalid('The table package member must be a physical regular file.');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) invalid('The table package member is not a regular file.');
    if (before.size > BigInt(TABLE_PACKAGE_MAX_BYTES))
      throw new TablePackageError('TABLE_PACKAGE_TOO_LARGE', 'The saved table exceeds 20 MiB.');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    const published = await lstat(path, { bigint: true });
    if (
      offset !== bytes.length ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      published.isSymbolicLink() ||
      published.dev !== before.dev ||
      published.ino !== before.ino ||
      published.size !== before.size ||
      published.mtimeNs !== before.mtimeNs ||
      published.ctimeNs !== before.ctimeNs
    )
      throw new WorkspaceFilePreconditionError('The table package changed while it was read.');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } finally {
    await file.close();
  }
}

async function readTableHead(input: TablePackageLocation) {
  const owner = await location(input);
  const { headPath } = tablePackagePaths(owner.packageRoot);
  const headText = await readText(owner.workspaceRoot, headPath);
  return { ...owner, headPath, headText };
}

async function readTablePackageFromHead(
  captured: Awaited<ReturnType<typeof readTableHead>>,
  input: ReadTablePackageInput
): Promise<ReadTablePackageResult> {
  const { workspaceRoot, packageRoot, headText } = captured;
  const head = parseTablePackageHead(headText);
  const snapshotText = await readText(
    workspaceRoot,
    tablePackageRevisionPath(packageRoot, head.snapshotSha256)
  );
  const verified = await verifyTablePackageRead({
    headText,
    snapshotText,
    expectedDocumentId: input.expectedDocumentId,
    expectedSnapshotSha256: input.expectedSnapshotSha256,
  });
  return {
    ...captured,
    ...verified,
    snapshotText,
    headContentHash: hash(headText),
  };
}

export async function readTablePackageInMain(
  input: ReadTablePackageInput
): Promise<ReadTablePackageResult> {
  return readTablePackageFromHead(await readTableHead(input), input);
}

/** Discovery may skip a marker without the requested identity. A match still needs full verification. */
export async function readMatchingTablePackageInMain(
  input: ReadTablePackageInput,
  matches: (head: Record<string, unknown>) => boolean
): Promise<ReadTablePackageResult | null> {
  const captured = await readTableHead(input);
  let head: unknown;
  try {
    head = JSON.parse(captured.headText);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
  if (
    !head ||
    typeof head !== 'object' ||
    Array.isArray(head) ||
    !matches(head as Record<string, unknown>)
  )
    return null;
  return readTablePackageFromHead(captured, input);
}

export async function readTableSnapshotInMain(input: ReadTableSnapshotInput): Promise<{
  snapshot: TableSnapshot;
  snapshotText: string;
  snapshotSha256: string;
}> {
  const owner = await location(input);
  const { headPath } = tablePackagePaths(owner.packageRoot);
  const head = parseTablePackageHead(await readText(owner.workspaceRoot, headPath));
  if (head.id !== input.documentId)
    throw new TablePackageError(
      'TABLE_PACKAGE_IDENTITY_MISMATCH',
      'The table package has a different owner.'
    );
  if (head.status !== 'active')
    invalid('A pending table promotion cannot provide a saved version.');
  return readVerifiedTableRevision(owner, input.documentId, input.snapshotSha256);
}

export async function readVerifiedTableRevision(
  owner: TablePackageLocation,
  documentId: string,
  snapshotSha256: string
) {
  const path = tablePackageRevisionPath(owner.packageRoot, snapshotSha256);
  const snapshotText = await readText(owner.workspaceRoot, path);
  const snapshot = parseTableSnapshot(snapshotText);
  if (snapshot.documentId !== documentId)
    throw new TablePackageError(
      'TABLE_PACKAGE_IDENTITY_MISMATCH',
      'The saved snapshot has a different owner.'
    );
  if (serializeTableSnapshot(snapshot) !== snapshotText || hash(snapshotText) !== snapshotSha256)
    throw new TablePackageError(
      'TABLE_PACKAGE_SNAPSHOT_MISMATCH',
      'The saved snapshot bytes do not match the requested version.'
    );
  return { snapshot, snapshotText, snapshotSha256 };
}

async function createDirectories(
  owner: TablePackageLocation,
  path: string,
  options: TablePackagePublicationOptions
): Promise<void> {
  if (!contained(owner.workspaceRoot, path)) invalid('The table directory is outside its project.');
  let candidate = owner.workspaceRoot;
  for (const part of relative(owner.workspaceRoot, path).split(sep).filter(Boolean)) {
    candidate = join(candidate, part);
    let entry = await existing(candidate);
    if (!entry) {
      current(options);
      try {
        await mkdir(candidate, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      entry = await lstat(candidate);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink())
      invalid('The table package directory is not a physical directory.');
  }
}

async function requireWritableHead(path: string): Promise<void> {
  const entry = await existing(path);
  if (!entry) return;
  if (!entry.isFile() || entry.isSymbolicLink()) invalid('The table head is not a regular file.');
  if ((entry.mode & 0o222) === 0)
    throw Object.assign(new Error('The table head is read-only.'), { code: 'EACCES', path });
}

function uncertain(error: unknown): WorkspaceFilePublicationUncertainError {
  const result = new WorkspaceFilePublicationUncertainError(
    `The table was published, but its directory flush failed: ${error instanceof Error ? error.message : String(error)}`
  );
  Object.defineProperty(result, 'cause', { value: error, configurable: true });
  return result;
}

async function settleDirectories(
  owner: TablePackageLocation,
  options: TablePackagePublicationOptions
): Promise<void> {
  const paths = tablePackagePaths(owner.packageRoot);
  const directories = new Set([paths.revisionsDirectory, dirname(paths.headPath)]);
  let ancestor = owner.packageRoot;
  for (;;) {
    directories.add(ancestor);
    if (ancestor === owner.workspaceRoot) break;
    const parent = dirname(ancestor);
    if (parent === ancestor || !contained(owner.workspaceRoot, parent))
      invalid('The table package directory no longer belongs to its project.');
    ancestor = parent;
  }
  for (const path of directories) {
    current(options);
    await directoryPath(owner.workspaceRoot, path);
    try {
      await (options.syncDirectory ?? syncDirectory)(path);
    } catch (error) {
      throw uncertain(error);
    }
  }
}

export async function publishTablePackageInMain(
  input: PublishTablePackageInput,
  options: TablePackagePublicationOptions & { db: Database.Database }
): Promise<PublishTablePackageResult> {
  if (!options.db) throw new Error('Publishing a saved table requires its library database.');
  const { retainTablePublication } = await import('./retain-table-package');
  return writeTablePackageFiles(input, {
    ...options,
    retain: retainTablePublication(options.db, options.assertCurrent),
  });
}

export async function writeTablePackageFiles(
  input: PublishTablePackageInput,
  options: TablePackagePublicationOptions & {
    retain?(result: ReadTablePackageResult): Promise<void>;
  }
): Promise<PublishTablePackageResult> {
  const headText = serializeTablePackageHead(input.head);
  const snapshotText = serializeTableSnapshot(input.head.snapshot);
  if (input.mode !== 'create' && input.mode !== 'replace')
    invalid('The table publication mode is invalid.');
  if (
    input.mode === 'replace' &&
    (typeof input.expectedContentHash !== 'string' || !validDigest.test(input.expectedContentHash))
  )
    invalid('Replacing a table requires its expected head SHA256.');
  const owner = await location(input);
  return withPublication(owner.packageRoot, async () => {
    current(options);
    const paths = tablePackagePaths(owner.packageRoot);
    await requireWritableHead(paths.headPath);
    const leaf = await existing(paths.headPath);
    const previous = leaf ? await readTablePackageInMain(owner) : null;
    if (previous && previous.head.id !== input.head.id)
      throw new TablePackageError(
        'TABLE_PACKAGE_IDENTITY_MISMATCH',
        'The destination belongs to another table.'
      );
    if (previous?.headText === headText) {
      await settleDirectories(owner, options);
      const result = await readTablePackageInMain({
        ...owner,
        expectedDocumentId: input.head.id,
        expectedSnapshotSha256: input.head.snapshotSha256,
      });
      if (result.headText !== headText)
        throw new WorkspaceFilePreconditionError(
          'The table changed during publication acknowledgement.'
        );
      await options.retain?.(result);
      current(options);
      return { ...result, publication: 'already-committed' };
    }
    if (input.mode === 'create' && previous)
      throw new WorkspaceFilePreconditionError('A table package already exists at that location.');
    if (
      input.mode === 'replace' &&
      (!previous || previous.headContentHash !== input.expectedContentHash)
    )
      throw new WorkspaceFilePreconditionError('The table changed since this save was captured.');
    if (previous) await options.retain?.(previous);
    await createDirectories(owner, paths.revisionsDirectory, options);
    const writeAtomic = options.writeAtomic ?? writeWorkspaceTextFileAtomicInMain;
    const warnings: string[] = [];
    const write = async (request: WorkspaceTextFileAtomicWriteInput) => {
      let authorityFailure: unknown;
      let authorityFailed = false;
      let syncFailure: unknown;
      try {
        const result = await writeAtomic(request, {
          durable: true,
          beforePublish: () => {
            try {
              current(options);
              physicalPath(owner.workspaceRoot, request.path, request.mode === 'create');
              if (request.path === paths.headPath) {
                const head = lstatSync(request.path, { throwIfNoEntry: false });
                if (head && (head.mode & 0o222) === 0)
                  throw Object.assign(new Error('The table head is read-only.'), {
                    code: 'EACCES',
                    path: request.path,
                  });
              }
            } catch (error) {
              authorityFailed = true;
              authorityFailure = error;
              throw error;
            }
          },
          syncDirectory: async (path) => {
            try {
              await (options.syncDirectory ?? syncDirectory)(path);
            } catch (error) {
              syncFailure = error;
              throw error;
            }
          },
        });
        if (result.cleanupWarning) warnings.push(result.cleanupWarning);
        return result;
      } catch (error) {
        if (authorityFailed) throw authorityFailure;
        if (error instanceof WorkspaceFilePublicationUncertainError && syncFailure !== undefined)
          Object.defineProperty(error, 'cause', { value: syncFailure, configurable: true });
        throw error;
      }
    };
    const revisionPath = tablePackageRevisionPath(owner.packageRoot, input.head.snapshotSha256);
    const verifySnapshot = async () => {
      const actual = await readText(owner.workspaceRoot, revisionPath);
      const snapshot = parseTableSnapshot(actual);
      if (
        actual !== snapshotText ||
        snapshot.documentId !== input.head.id ||
        hash(actual) !== input.head.snapshotSha256
      )
        throw new TablePackageError(
          'TABLE_PACKAGE_SNAPSHOT_MISMATCH',
          'An existing immutable snapshot has different bytes or ownership.'
        );
    };
    if (await existing(revisionPath)) {
      await verifySnapshot();
      await (options.syncDirectory ?? syncDirectory)(paths.revisionsDirectory);
    } else {
      try {
        await write({
          workspaceRoot: owner.workspaceRoot,
          path: revisionPath,
          mode: 'create',
          content: snapshotText,
          artifactNoun: 'table snapshot',
        });
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'EEXIST' &&
          !(error instanceof Error && /already exists at that location/u.test(error.message))
        )
          throw error;
        await verifySnapshot();
      }
      await verifySnapshot();
    }
    current(options);
    await write({
      workspaceRoot: owner.workspaceRoot,
      path: paths.headPath,
      content: headText,
      mode: input.mode,
      expectedContentHash: input.expectedContentHash,
      artifactNoun: 'table head',
    });
    await settleDirectories(owner, options);
    const result = await readTablePackageInMain({
      ...owner,
      expectedDocumentId: input.head.id,
      expectedSnapshotSha256: input.head.snapshotSha256,
    });
    if (result.headText !== headText)
      throw new WorkspaceFilePreconditionError(
        'The table changed before publication was acknowledged.'
      );
    await options.retain?.(result);
    current(options);
    return { ...result, publication: 'committed', ...(warnings.length ? { warnings } : {}) };
  });
}
