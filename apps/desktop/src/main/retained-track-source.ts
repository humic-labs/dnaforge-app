import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { flushFile, syncDirectory } from './fs-durability';
import { claimRegularFileNoClobber } from './workspace-git/exclusive-file-claim';

export async function retainTrackSource(
  root: string,
  input: { path: string; sha256: string; sizeBytes: number }
): Promise<string> {
  if (
    !/^[a-f0-9]{64}$/.test(input.sha256) ||
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1
  )
    throw new Error('A retained track needs its complete content identity.');
  const directory = join(root, input.sha256);
  await mkdir(directory, { recursive: true });
  await syncDirectory(dirname(root));
  await syncDirectory(root);
  const destination = join(directory, basename(input.path));
  const verify = async (path: string) => {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size !== input.sizeBytes)
      throw new Error('The retained track does not match its expected complete file.');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest('hex') !== input.sha256)
      throw new Error('The retained track content does not match its expected SHA-256.');
  };
  try {
    await verify(destination);
    return destination;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(directory, `.${randomUUID()}.partial`);
  try {
    await copyFile(input.path, temporary, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await verify(temporary);
    await flushFile(temporary);
    try {
      await claimRegularFileNoClobber(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await verify(destination);
    await flushFile(destination);
    await syncDirectory(directory);
    return destination;
  } finally {
    await rm(temporary, { force: true });
  }
}
