import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { NATIVE_WORKSPACE_MANIFEST_PATH } from '../shared/native-workspace-manifest';
import { assertWorkspaceProjectionPathSafe } from './workspace-projection-boundary';
import { syncDirectory } from './fs-durability';
import { isSafeWorkspaceRelativePath } from '../shared/path-boundary';

type CatalogPublication = Readonly<{
  schema: 'dnaforge.native-catalog-publication.v1';
  operationId: string;
  beforeSha256: string | null;
  afterSha256: string;
  destinationRelativePath?: string;
}>;

export async function readNativeCatalogPublicationBase(input: {
  workspacePath: string;
  operationId: string;
  relativePath?: string;
}): Promise<Buffer | null> {
  const paths = publicationPaths(input);
  const current = await readRegularFile(input.workspacePath, paths.destination);
  if (current !== null) return current;
  const receipt = await readPublication(
    input.workspacePath,
    paths.receipt,
    input.operationId,
    input.relativePath
  );
  if (!receipt) return null;
  if (await readRegularFile(input.workspacePath, paths.complete))
    throw new Error('Native catalog changed after completed publication.');
  const displaced = await readRegularFile(input.workspacePath, paths.displaced);
  if (receipt.beforeSha256 === null && displaced === null) return null;
  if (displaced === null || digest(displaced) !== receipt.beforeSha256)
    throw new Error('Native catalog publication preimage is unavailable or changed.');
  return displaced;
}

export async function publishNativeCatalogBytes(input: {
  workspacePath: string;
  operationId: string;
  beforeBytes: Buffer | null;
  afterBytes: Buffer;
  relativePath?: string;
}): Promise<string> {
  const paths = publicationPaths(input);
  for (const path of Object.values(paths))
    assertWorkspaceProjectionPathSafe(input.workspacePath, path);
  await mkdir(dirname(paths.receipt), { recursive: true });
  await mkdir(dirname(paths.destination), { recursive: true });
  for (const directory of [
    input.workspacePath,
    join(input.workspacePath, '.dnaforge'),
    join(input.workspacePath, '.dnaforge', 'migration'),
    join(input.workspacePath, '.dnaforge', 'migration', 'catalog-publications'),
    dirname(paths.receipt),
    dirname(paths.destination),
  ]) {
    await syncDirectory(directory);
  }
  let receipt = await readPublication(
    input.workspacePath,
    paths.receipt,
    input.operationId,
    input.relativePath
  );
  if (!receipt) {
    receipt = {
      schema: 'dnaforge.native-catalog-publication.v1',
      operationId: input.operationId,
      beforeSha256: input.beforeBytes === null ? null : digest(input.beforeBytes),
      afterSha256: digest(input.afterBytes),
      destinationRelativePath: input.relativePath ?? NATIVE_WORKSPACE_MANIFEST_PATH,
    };
    await writeExclusiveDurable(input.workspacePath, paths.staged, input.afterBytes);
    await writeExclusiveDurable(
      input.workspacePath,
      paths.receipt,
      Buffer.from(JSON.stringify(receipt))
    );
  }
  if (receipt.afterSha256 !== digest(input.afterBytes))
    throw new Error('Native catalog publication operation was reused with different content.');
  const completed = await readRegularFile(input.workspacePath, paths.complete);
  if (completed && completed.toString('utf8') !== receipt.afterSha256)
    throw new Error('Native catalog publication completion record changed.');
  const staged = await readRegularFile(input.workspacePath, paths.staged);
  if ((staged && digest(staged) !== receipt.afterSha256) || (!staged && !completed))
    throw new Error('Native catalog staged bytes changed.');
  let current = await readRegularFile(input.workspacePath, paths.destination);
  if (current && digest(current) === receipt.afterSha256) {
    const installedByThisOperation = await sameFile(paths.destination, paths.install);
    if (!completed && !installedByThisOperation && receipt.beforeSha256 !== receipt.afterSha256)
      throw new Error('Native catalog matching content has no publication ownership evidence.');
    await writeExclusiveDurable(
      input.workspacePath,
      paths.complete,
      Buffer.from(receipt.afterSha256)
    );
    return paths.destination;
  }
  if (completed) throw new Error('Native catalog changed after completed publication.');
  if (!staged) throw new Error('Native catalog staged bytes changed.');
  let displaced = await readRegularFile(input.workspacePath, paths.displaced);
  if (receipt.beforeSha256 !== null && displaced === null) {
    if (current === null || digest(current) !== receipt.beforeSha256)
      throw new Error('Native catalog changed after publication was prepared.');
    assertWorkspaceProjectionPathSafe(input.workspacePath, paths.destination);
    assertWorkspaceProjectionPathSafe(input.workspacePath, paths.displaced);
    await rename(paths.destination, paths.displaced);
    await syncDirectory(dirname(paths.destination));
    await syncDirectory(dirname(paths.displaced));
    displaced = await readRegularFile(input.workspacePath, paths.displaced);
    current = await readRegularFile(input.workspacePath, paths.destination);
  }
  if (receipt.beforeSha256 !== null && (!displaced || digest(displaced) !== receipt.beforeSha256)) {
    if (displaced && current === null) await restoreDisplacedIfVacant(input.workspacePath, paths);
    throw new Error(
      'Native catalog changed during displacement; the displaced file was preserved.'
    );
  }
  if (current !== null)
    throw new Error(
      'Native catalog destination was created by another writer; both files were preserved.'
    );
  await writeExclusiveDurable(input.workspacePath, paths.install, staged);
  assertWorkspaceProjectionPathSafe(input.workspacePath, paths.destination);
  assertWorkspaceProjectionPathSafe(input.workspacePath, paths.install);
  await link(paths.install, paths.destination);
  await syncDirectory(dirname(paths.destination));
  const installed = await readRegularFile(input.workspacePath, paths.destination);
  if (!installed || digest(installed) !== receipt.afterSha256)
    throw new Error(
      'Native catalog changed during publication; its recovery files were preserved.'
    );
  await writeExclusiveDurable(
    input.workspacePath,
    paths.complete,
    Buffer.from(receipt.afterSha256)
  );
  return paths.destination;
}

export async function pruneCompletedNativeCatalogPublication(input: {
  workspacePath: string;
  operationId: string;
  relativePath?: string;
}): Promise<void> {
  const paths = publicationPaths(input);
  const receipt = await readPublication(
    input.workspacePath,
    paths.receipt,
    input.operationId,
    input.relativePath
  );
  const complete = await readRegularFile(input.workspacePath, paths.complete);
  if (!receipt || complete?.toString('utf8') !== receipt.afterSha256)
    throw new Error('Cannot prune an incomplete native catalog publication.');
  for (const path of [paths.displaced, paths.staged, paths.install]) {
    assertWorkspaceProjectionPathSafe(input.workspacePath, path);
    await rm(path, { force: true });
  }
  await syncDirectory(dirname(paths.receipt));
}

function publicationPaths(input: {
  workspacePath: string;
  operationId: string;
  relativePath?: string;
}) {
  if (input.relativePath !== undefined && !isSafeWorkspaceRelativePath(input.relativePath)) {
    throw new Error('Publication destination must be a safe workspace-relative path.');
  }
  const id = digest(Buffer.from(input.operationId));
  const root = join(input.workspacePath, '.dnaforge', 'migration', 'catalog-publications', id);
  return {
    destination: join(input.workspacePath, input.relativePath ?? NATIVE_WORKSPACE_MANIFEST_PATH),
    receipt: join(root, 'publication.json'),
    staged: join(root, 'after.json'),
    install: join(root, 'install.json'),
    displaced: join(root, 'before.json'),
    complete: join(root, 'complete'),
  };
}

async function readPublication(
  root: string,
  path: string,
  operationId: string,
  relativePath?: string
): Promise<CatalogPublication | null> {
  const bytes = await readRegularFile(root, path);
  if (bytes === null) return null;
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  const expectedPath = relativePath ?? NATIVE_WORKSPACE_MANIFEST_PATH;
  if (
    value &&
    typeof value === 'object' &&
    ('destinationRelativePath' in value
      ? value.destinationRelativePath !== expectedPath
      : relativePath !== undefined)
  ) {
    throw new Error('Publication operation was reused for a different destination.');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('schema' in value) ||
    value.schema !== 'dnaforge.native-catalog-publication.v1' ||
    !('operationId' in value) ||
    value.operationId !== operationId ||
    !('beforeSha256' in value) ||
    !(value.beforeSha256 === null || isDigest(value.beforeSha256)) ||
    !('afterSha256' in value) ||
    !isDigest(value.afterSha256)
  )
    throw new Error('Native catalog publication receipt is invalid.');
  return {
    schema: value.schema,
    operationId,
    beforeSha256: value.beforeSha256,
    afterSha256: value.afterSha256,
  };
}

async function readRegularFile(root: string, path: string): Promise<Buffer | null> {
  assertWorkspaceProjectionPathSafe(root, path);
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) throw new Error('Native catalog publication requires a regular file.');
    return await readFile(path);
  } catch (error) {
    if (isCode(error, 'ENOENT')) return null;
    throw error;
  }
}

async function writeExclusiveDurable(root: string, path: string, bytes: Buffer): Promise<void> {
  assertWorkspaceProjectionPathSafe(root, path);
  const existing = await readRegularFile(root, path);
  if (existing !== null) {
    if (!existing.equals(bytes))
      throw new Error('Native catalog publication private file changed.');
    return;
  }
  const temporary = `${path}.${randomUUID()}.pending`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    assertWorkspaceProjectionPathSafe(root, path);
    await link(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function restoreDisplacedIfVacant(root: string, paths: ReturnType<typeof publicationPaths>) {
  assertWorkspaceProjectionPathSafe(root, paths.destination);
  assertWorkspaceProjectionPathSafe(root, paths.displaced);
  try {
    await link(paths.displaced, paths.destination);
    await syncDirectory(dirname(paths.destination));
  } catch (error) {
    if (!isCode(error, 'EEXIST')) throw error;
  }
}

async function sameFile(left: string, right: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([lstat(left), lstat(right)]);
    return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino;
  } catch (error) {
    if (isCode(error, 'ENOENT')) return false;
    throw error;
  }
}
function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
