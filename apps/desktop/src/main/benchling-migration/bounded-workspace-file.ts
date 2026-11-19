import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isSafeWorkspaceRelativePath } from '../../shared/path-boundary';

async function checkedWorkspaceFilePath(workspacePath: string, relativePath: string) {
  if (!isSafeWorkspaceRelativePath(relativePath) || relativePath.includes('\\'))
    throw new Error('Workspace path is invalid.');
  const segments = relativePath.split('/');
  let current = resolve(workspacePath);
  for (const segment of ['', ...segments.slice(0, -1)]) {
    current = join(current, segment);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Workspace path has a non-directory ancestor.');
    } catch (error) {
      if (isMissing(error)) break;
      throw error;
    }
  }
  return join(workspacePath, relativePath);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function readBoundedWorkspaceFile(
  workspacePath: string,
  relativePath: string,
  limit = 64 * 1024 * 1024
): Promise<Buffer> {
  return inspectBoundedWorkspaceFile(workspacePath, relativePath, limit, (bytes) => bytes);
}

export async function inspectBoundedWorkspaceFile<T>(
  workspacePath: string,
  relativePath: string,
  limit: number,
  inspect: (bytes: Buffer) => T | Promise<T>
): Promise<T> {
  const path = await checkedWorkspaceFilePath(workspacePath, relativePath);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > limit)
      throw new Error('Workspace file is not a bounded regular file.');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error('Workspace file shortened during capture.');
      offset += bytesRead;
    }
    const result = await inspect(bytes);
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.mtimeNs !== current.mtimeNs ||
      after.ctimeNs !== current.ctimeNs ||
      current.isSymbolicLink()
    )
      throw new Error('Workspace file changed during capture.');
    await checkedWorkspaceFilePath(workspacePath, relativePath);
    return result;
  } finally {
    await handle.close();
  }
}
