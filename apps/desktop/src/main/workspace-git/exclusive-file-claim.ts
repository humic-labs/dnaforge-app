import { link, lstat, mkdtemp, open, rm, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type ClaimedFileIdentity = { dev: number; ino: number };

export interface ExclusiveFileClaimOps {
  link?: (existingPath: string, newPath: string) => Promise<void>;
  open?: (path: string, flags: 'r' | 'wx') => Promise<FileHandle>;
}

const HARD_LINK_UNAVAILABLE = new Set([
  'EMLINK',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
  'EXDEV',
]);

export async function claimRegularFileNoClobber(
  sourcePath: string,
  destinationPath: string,
  ops: ExclusiveFileClaimOps = {}
): Promise<{ identity: ClaimedFileIdentity; method: 'link' | 'copy' }> {
  const source = await lstat(sourcePath);
  if (!source.isFile()) {
    throw new Error(`EXCLUSIVE_FILE_SOURCE_NOT_REGULAR: "${sourcePath}" is not a regular file.`);
  }
  let useCopy = false;
  try {
    await (ops.link ?? link)(sourcePath, destinationPath);
  } catch (error) {
    if (!HARD_LINK_UNAVAILABLE.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    useCopy = true;
  }
  if (!useCopy) {
    const claimed = await lstat(destinationPath);
    if (claimed.dev !== source.dev || claimed.ino !== source.ino) {
      throw new Error(
        `EXCLUSIVE_FILE_CLAIM_CHANGED: "${destinationPath}" changed while it was being claimed.`
      );
    }
    return { identity: { dev: claimed.dev, ino: claimed.ino }, method: 'link' };
  }

  const openFile = ops.open ?? open;
  const sourceHandle = await openFile(sourcePath, 'r');
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  let destinationIdentity: ClaimedFileIdentity | undefined;
  try {
    const openedSource = await sourceHandle.stat();
    if (openedSource.dev !== source.dev || openedSource.ino !== source.ino) {
      throw new Error(
        `EXCLUSIVE_FILE_SOURCE_CHANGED: "${sourcePath}" changed before it could be copied.`
      );
    }
    destination = await openFile(destinationPath, 'wx');
    const created = await destination.stat();
    const identity = { dev: created.dev, ino: created.ino };
    destinationIdentity = identity;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, null);
        if (result.bytesWritten === 0) {
          throw new Error(`EXCLUSIVE_FILE_COPY_STALLED: "${destinationPath}" accepted no bytes.`);
        }
        written += result.bytesWritten;
      }
    }
    await destination.close();
    destination = undefined;
    const current = await lstat(destinationPath);
    if (current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error(
        `EXCLUSIVE_FILE_CLAIM_CHANGED: "${destinationPath}" changed while it was being copied.`
      );
    }
    return { identity, method: 'copy' };
  } catch (error) {
    if (destination) {
      await destination.close().catch(() => undefined);
      destination = undefined;
      try {
        const current = await lstat(destinationPath);
        if (
          destinationIdentity &&
          current.dev === destinationIdentity.dev &&
          current.ino === destinationIdentity.ino
        ) {
          await unlink(destinationPath);
        }
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new AggregateError(
            [error, cleanupError],
            `Exclusive file claim failed and "${destinationPath}" could not be cleaned safely.`
          );
        }
      }
    }
    throw error;
  } finally {
    await Promise.all([
      sourceHandle.close().catch(() => undefined),
      destination?.close().catch(() => undefined),
    ]);
  }
}

export async function publishFileContentNoClobber(
  destinationPath: string,
  content: string | Uint8Array,
  ops: ExclusiveFileClaimOps = {}
): Promise<ClaimedFileIdentity> {
  const stagingRoot = await mkdtemp(join(dirname(destinationPath), '.p-'));
  try {
    const stagedPath = join(stagingRoot, 'data');
    const handle = await open(stagedPath, 'wx');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return (await claimRegularFileNoClobber(stagedPath, destinationPath, ops)).identity;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
