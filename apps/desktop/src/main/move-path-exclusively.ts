import { lstatSync } from 'node:fs';
import { cp, lstat, mkdtemp, readdir, readlink, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promotePathExclusively } from './exclusive-path-promotion';
import { flushFile, syncDirectory } from './fs-durability';
import { hashWorkspaceSyncFileOnDisk } from './workspace-sync-blob-cache';

export class PublishedMoveIncompleteError extends Error {}

export function renamePathWithoutReplacement(source: string, destination: string): void {
  if (source === destination) {
    lstatSync(source);
    return;
  }
  try {
    promotePathExclusively(source, destination);
  } catch (error) {
    if (
      ['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '') ||
      (process.platform === 'win32' && lstatSync(destination, { throwIfNoEntry: false }))
    )
      throw new Error(
        `MOVE_EXISTS: an item named "${basename(destination)}" already exists in that folder`
      );
    throw error;
  }
}

async function verifyCopy(source: string, destination: string, flush: boolean): Promise<void> {
  const [a, b] = await Promise.all([lstat(source), lstat(destination)]);
  const mismatch = () => new Error(`The copied item differs from its source: ${destination}`);
  if (a.isDirectory() && b.isDirectory()) {
    const [left, right] = await Promise.all([readdir(source), readdir(destination)]);
    left.sort();
    right.sort();
    if (left.length !== right.length || left.some((name, i) => name !== right[i])) throw mismatch();
    for (const name of left) await verifyCopy(join(source, name), join(destination, name), flush);
    if (flush) await syncDirectory(destination);
  } else if (a.isFile() && b.isFile()) {
    const [left, right] = await Promise.all([
      hashWorkspaceSyncFileOnDisk(source),
      hashWorkspaceSyncFileOnDisk(destination),
    ]);
    if (left.sha256 !== right.sha256 || left.sizeBytes !== right.sizeBytes) throw mismatch();
    if (flush) await flushFile(destination);
  } else if (a.isSymbolicLink() && b.isSymbolicLink()) {
    if ((await readlink(source)) !== (await readlink(destination))) throw mismatch();
  } else throw mismatch();
}

export async function movePathWithoutReplacement(
  source: string,
  destination: string,
  assertCurrent: () => void,
  recheckFileAuthority: () => void | Promise<void>
): Promise<void> {
  const sourceIdentity = await lstat(source, { bigint: true });
  const destinationParent = dirname(destination);
  const parentIdentity = await lstat(destinationParent, { bigint: true });
  if (sourceIdentity.dev === parentIdentity.dev) {
    try {
      await recheckFileAuthority();
      assertCurrent();
      renamePathWithoutReplacement(source, destination);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    }
  }

  assertCurrent();
  const stage = await mkdtemp(join(destinationParent, '.dnaforge-move-'));
  const copied = join(stage, 'copy');
  let published = false;
  try {
    await cp(source, copied, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
    await verifyCopy(source, copied, true);
    const copyIdentity = await lstat(copied, { bigint: true });
    await recheckFileAuthority();
    assertCurrent();
    renamePathWithoutReplacement(copied, destination);
    published = true;
    await syncDirectory(destinationParent);

    assertCurrent();
    const retirement = await mkdtemp(join(dirname(source), '.dnaforge-move-'));
    const original = join(retirement, 'original');
    let claimed = false;
    try {
      await recheckFileAuthority();
      assertCurrent();
      promotePathExclusively(source, original);
      claimed = true;
      const [held, visible] = await Promise.all([
        lstat(original, { bigint: true }),
        lstat(destination, { bigint: true }),
      ]);
      if (
        held.dev !== sourceIdentity.dev ||
        held.ino !== sourceIdentity.ino ||
        visible.dev !== copyIdentity.dev ||
        visible.ino !== copyIdentity.ino
      )
        throw new Error('The source or destination was replaced while moving.');
      await verifyCopy(original, destination, false);
      await recheckFileAuthority();
      assertCurrent();
      await rm(original, { recursive: true });
      claimed = false;
    } catch (error) {
      let retained = source;
      if (claimed) {
        try {
          promotePathExclusively(original, source);
        } catch {
          retained = original;
        }
      }
      throw new Error(
        `Check the remaining original at ${retained}. ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      await rmdir(retirement).catch(() => {});
    }
  } catch (error) {
    if (published)
      throw new PublishedMoveIncompleteError(
        `MOVE_FAILED: The verified copy was published at ${destination}. ${error instanceof Error ? error.message : String(error)}`
      );
    throw error;
  } finally {
    if (!published) await rm(copied, { recursive: true, force: true });
    await rmdir(stage).catch(() => {});
  }
}
