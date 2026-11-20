import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import type { TextFileAtomicWriteInput } from '../shared/text-file-atomic';
import { createKeyedMutex } from './workspace-git/keyed-mutex';

const withFilePublication = createKeyedMutex();

type AtomicTextFileHandle = Pick<FileHandle, 'writeFile' | 'sync' | 'close'> &
  Partial<Pick<FileHandle, 'chmod'>>;

interface AtomicTextFileOperations {
  readonly temporaryId: () => string;
  readonly beforePublish: (path: string) => void;
  readonly openFile: (path: string, flags: 'wx', mode: number) => Promise<AtomicTextFileHandle>;
  readonly renameFile: (temporaryPath: string, destinationPath: string) => Promise<void>;
  readonly removeFile: (path: string) => Promise<void>;
}

const DEFAULT_ATOMIC_TEXT_FILE_OPERATIONS: AtomicTextFileOperations = {
  temporaryId: randomUUID,
  beforePublish: () => {},
  openFile: (path, flags, mode) => open(path, flags, mode),
  renameFile: rename,
  removeFile: (path) => rm(path, { force: true }),
};

export async function writeTextFileAtomicInMain(
  input: TextFileAtomicWriteInput,
  overrides: Partial<AtomicTextFileOperations> = {}
): Promise<void> {
  return withFilePublication(resolve(input.path), () => publishTextFile(input, overrides));
}

async function publishTextFile(
  input: TextFileAtomicWriteInput,
  overrides: Partial<AtomicTextFileOperations>
): Promise<void> {
  const operations = { ...DEFAULT_ATOMIC_TEXT_FILE_OPERATIONS, ...overrides };
  const temporaryPath = join(
    dirname(input.path),
    `.${basename(input.path)}.dnaforge-tmp-${operations.temporaryId()}`
  );
  let temporaryHandle: AtomicTextFileHandle | null = null;
  let temporaryCreated = false;

  try {
    const leaf = await lstat(input.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (leaf && (!leaf.isFile() || leaf.isSymbolicLink()))
      throw new Error('Refusing to replace a non-regular text file.');
    if (leaf && (leaf.mode & 0o222) === 0) throw new Error('The text file is read-only.');
    temporaryHandle = await operations.openFile(
      temporaryPath,
      'wx',
      leaf ? leaf.mode & 0o777 : 0o600
    );
    temporaryCreated = true;
    await temporaryHandle.writeFile(input.content, 'utf8');
    if (leaf && temporaryHandle.chmod) await temporaryHandle.chmod(leaf.mode & 0o777);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = null;
    if (input.expectedContentHash !== undefined) {
      const current = await lstat(input.path).catch(() => null);
      if (
        !current?.isFile() ||
        current.isSymbolicLink() ||
        !leaf ||
        current.dev !== leaf.dev ||
        current.ino !== leaf.ino ||
        current.mode !== leaf.mode ||
        `sha256:${createHash('sha256')
          .update(await readFile(input.path))
          .digest('hex')}` !== input.expectedContentHash
      )
        throw new Error('FILE_CHANGED: The file changed on disk. Reopen it before saving.');
    }
    operations.beforePublish(temporaryPath);
    await operations.renameFile(temporaryPath, input.path);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (temporaryHandle) {
      try {
        await temporaryHandle.close();
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
    }
    if (temporaryCreated) {
      try {
        await operations.removeFile(temporaryPath);
      } catch (removeError) {
        cleanupErrors.push(removeError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Atomic text-file write failed and temporary-file cleanup did not complete.'
      );
    }
    throw error;
  }
}
