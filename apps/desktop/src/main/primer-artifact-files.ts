import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  WorkspacePathValidationInput,
  WorkspaceBinaryFileAtomicWriteInput,
  WorkspaceTextFileAtomicPartialEffect,
  WorkspaceTextFileAtomicWriteInput,
  WorkspaceTextFileAtomicWriteResult,
} from '../shared/workspace-file-atomic';
import { syncDirectory } from './fs-durability';

export class WorkspaceFilePreconditionError extends Error {
  override name = 'WorkspaceFilePreconditionError';
}
export class WorkspaceFilePublicationUncertainError extends Error {}

function checkPublication(fsOps: { beforePublish?: (path: string) => void }, path: string): void {
  try {
    const result: unknown = fsOps.beforePublish?.(path);
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => undefined);
      throw new Error('Publication authority must be a synchronous check.');
    }
  } catch (error) {
    throw new WorkspaceFilePreconditionError(
      error instanceof Error ? error.message : String(error)
    );
  }
}

const pathQueues = new Map<string, Promise<void>>();

export async function sha256Text(content: string): Promise<string> {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export async function sha256Bytes(content: Uint8Array): Promise<string> {
  return createHash('sha256').update(content).digest('hex');
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export async function canonicalWorkspacePath(
  input: WorkspacePathValidationInput
): Promise<{ root: string; candidate: string; parent: string }> {
  const noun = input.artifactNoun ?? 'primer';
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  if (!isAbsolute(input.workspaceRoot) || !isAbsolute(input.path)) {
    throw new Error(`${Noun} artifact paths and workspace roots must be absolute.`);
  }
  const root = await realpath(input.workspaceRoot);
  const lexicalRoot = resolve(input.workspaceRoot);
  const lexicalCandidate = resolve(input.path);
  if (!isContained(lexicalRoot, lexicalCandidate)) {
    throw new Error(`${Noun} files must be saved inside the owning workspace.`);
  }
  const lexicalRelativePath = relative(lexicalRoot, lexicalCandidate);

  const lexicalParent = dirname(lexicalCandidate);
  let parent = '';
  let candidate = '';
  try {
    candidate = await realpath(lexicalCandidate);
    parent = await realpath(lexicalParent);
  } catch (error) {
    if (!input.allowMissing) throw error;
    let existingAncestor = lexicalParent;
    for (;;) {
      try {
        const canonicalAncestor = await realpath(existingAncestor);
        if (!isContained(root, canonicalAncestor)) {
          throw new Error(`${Noun} files must be saved inside the owning workspace.`);
        }
        candidate = resolve(canonicalAncestor, relative(existingAncestor, lexicalCandidate));
        parent = dirname(candidate);
        break;
      } catch (ancestorError) {
        if ((ancestorError as NodeJS.ErrnoException).code !== 'ENOENT') throw ancestorError;
        const next = dirname(existingAncestor);
        if (next === existingAncestor) throw ancestorError;
        existingAncestor = next;
      }
    }
  }
  if (!isContained(root, parent) || !isContained(root, candidate)) {
    throw new Error(`${Noun} files must be saved inside the owning workspace.`);
  }
  if (relative(root, candidate) !== lexicalRelativePath) {
    let entryPath = root;
    for (const component of lexicalRelativePath.split(sep)) {
      entryPath = resolve(entryPath, component);
      try {
        if ((await lstat(entryPath)).isSymbolicLink())
          throw new Error(`${Noun} artifact paths cannot traverse symbolic links.`);
      } catch (error) {
        if (input.allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
  }
  return { root, candidate, parent };
}

export async function validateWorkspacePathInMain(
  input: WorkspacePathValidationInput
): Promise<boolean> {
  try {
    await canonicalWorkspacePath(input);
    return true;
  } catch {
    return false;
  }
}

async function withPathQueue<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = pathQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveQueue) => {
    release = resolveQueue;
  });
  const queued = previous.then(() => current);
  pathQueues.set(path, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (pathQueues.get(path) === queued) pathQueues.delete(path);
  }
}

async function writeCompleteTemporaryFile(
  path: string,
  content: string | Uint8Array,
  durable = false,
  unlinkFile: typeof unlink = unlink
): Promise<string> {
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporaryPath, 'wx');
  try {
    try {
      if (typeof content === 'string') await handle.writeFile(content, 'utf8');
      else await handle.writeFile(content);
      if (durable) await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await rethrowAfterTemporaryCleanup(temporaryPath, error, unlinkFile);
  }
  return temporaryPath;
}

function commitErrorWithTemporaryPartialEffect(
  temporaryPath: string,
  commitError: unknown,
  cleanupError: unknown
): Error & { partialEffects: unknown[] } {
  const base = commitError instanceof Error ? commitError : new Error(String(commitError));
  const baseWithEffects = base as Error & { partialEffects?: unknown };
  const existing = Array.isArray(baseWithEffects.partialEffects)
    ? baseWithEffects.partialEffects
    : [];
  const temporaryEffect: WorkspaceTextFileAtomicPartialEffect = {
    kind: 'temporary-workspace-file',
    path: temporaryPath,
    cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
  };
  return Object.assign(base, {
    partialEffects: [...existing, temporaryEffect],
  });
}

async function rethrowAfterTemporaryCleanup(
  temporaryPath: string,
  commitError: unknown,
  unlinkFile: typeof unlink
): Promise<never> {
  try {
    await unlinkFile(temporaryPath);
  } catch (cleanupError) {
    throw commitErrorWithTemporaryPartialEffect(temporaryPath, commitError, cleanupError);
  }
  throw commitError;
}

type AtomicFileFsOps = {
  link?: typeof link;
  unlink?: typeof unlink;
  durable?: boolean;
  syncDirectory?: typeof syncDirectory;
  beforePublish?: (path: string) => void;
};

export async function writeWorkspaceTextFileAtomicInMain(
  input: WorkspaceTextFileAtomicWriteInput,
  fsOps: AtomicFileFsOps = {}
): Promise<WorkspaceTextFileAtomicWriteResult> {
  return writeWorkspaceFileAtomicInMain(input, fsOps);
}

async function writeWorkspaceFileAtomicInMain(
  input: Omit<WorkspaceTextFileAtomicWriteInput, 'content'> & { content: string | Uint8Array },
  fsOps: AtomicFileFsOps
): Promise<WorkspaceTextFileAtomicWriteResult> {
  const linkFile = fsOps.link ?? link;
  const unlinkFile = fsOps.unlink ?? unlink;
  const noun = input.artifactNoun ?? 'primer';
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  const canonical = await canonicalWorkspacePath({
    workspaceRoot: input.workspaceRoot,
    path: input.path,
    allowMissing: input.mode === 'create',
    artifactNoun: noun,
  });
  if (input.mode === 'create') {
    await mkdir(canonical.parent, { recursive: true });
    const actualParent = await realpath(canonical.parent);
    if (!isContained(canonical.root, actualParent)) {
      throw new Error(`${Noun} files must be saved inside the owning workspace.`);
    }
    canonical.candidate = resolve(actualParent, basename(canonical.candidate));
  }
  const { candidate } = canonical;
  const contentHash =
    typeof input.content === 'string'
      ? await sha256Text(input.content)
      : await sha256Bytes(input.content);
  const confirmPublication = async (): Promise<void> => {
    if (!fsOps.durable) return;
    try {
      await (fsOps.syncDirectory ?? syncDirectory)(canonical.parent);
    } catch (error) {
      throw new WorkspaceFilePublicationUncertainError(
        `The file was published, but its directory flush failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  return withPathQueue(candidate, async () => {
    if (input.mode === 'replace') {
      if (!input.expectedContentHash) {
        throw new Error(`Replacing a ${noun} artifact requires its expected content hash.`);
      }
      const current = await readFile(candidate);
      if ((await sha256Bytes(current)) !== input.expectedContentHash) {
        throw new WorkspaceFilePreconditionError(
          `${Noun} artifact changed since it was opened; reload it before saving.`
        );
      }
      const temporaryPath = await writeCompleteTemporaryFile(
        candidate,
        input.content,
        fsOps.durable,
        unlinkFile
      );
      try {
        if (fsOps.durable) {
          await canonicalWorkspacePath(input);
          if ((await sha256Bytes(await readFile(candidate))) !== input.expectedContentHash) {
            throw new WorkspaceFilePreconditionError(
              `${Noun} artifact changed since it was opened; reload it before saving.`
            );
          }
        }
        checkPublication(fsOps, temporaryPath);
        await rename(temporaryPath, candidate);
      } catch (error) {
        await rethrowAfterTemporaryCleanup(temporaryPath, error, unlinkFile);
      }
      await confirmPublication();
      return { path: candidate, contentHash };
    }

    const temporaryPath = await writeCompleteTemporaryFile(
      candidate,
      input.content,
      fsOps.durable,
      unlinkFile
    );
    try {
      checkPublication(fsOps, temporaryPath);
      await linkFile(temporaryPath, candidate);
    } catch (error) {
      try {
        await unlinkFile(temporaryPath);
      } catch (cleanupError) {
        throw commitErrorWithTemporaryPartialEffect(temporaryPath, error, cleanupError);
      }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`A ${noun} artifact already exists at that location.`);
      }
      throw error;
    }
    let cleanupWarning: string | undefined;
    try {
      await unlinkFile(temporaryPath);
    } catch (error) {
      cleanupWarning = `Canonical artifact committed, but temporary-file cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    await confirmPublication();
    return { path: candidate, contentHash, ...(cleanupWarning ? { cleanupWarning } : {}) };
  });
}

export async function writeWorkspaceBinaryFileAtomicInMain(
  input: WorkspaceBinaryFileAtomicWriteInput,
  fsOps: AtomicFileFsOps & { mode?: 'create' | 'replace'; expectedContentHash?: string } = {}
): Promise<WorkspaceTextFileAtomicWriteResult> {
  const { mode = 'create', expectedContentHash, ...operations } = fsOps;
  return writeWorkspaceFileAtomicInMain(
    { ...input, artifactNoun: input.artifactNoun ?? 'binary', mode, expectedContentHash },
    operations
  );
}
