import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  migrateNotebookPackageAtPath,
  prepareNotebookPackageRename,
  publishNotebookPackageV2,
  recoverNotebookPackageRenameIfNeeded,
  type MigrateNotebookPackageAtPathInput,
  type NotebookPackageFileOps,
  type PrepareNotebookPackageRenameInput,
  type PublishNotebookPackageResult,
  type RecoverNotebookPackageRenameInput,
  type SerializablePublishNotebookPackageInput,
} from '../db/notebook-package-migration';
import {
  canonicalWorkspacePath,
  writeWorkspaceTextFileAtomicInMain,
} from './primer-artifact-files';
import { notebookPackagePaths } from '../db/notebook-package';

interface NotebookPublicationAuthority {
  assertCurrent(): void;
  published(path: string): void;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function createPackageFileOps(
  input: {
    workspaceRoot: string;
    packageRoot: string;
  },
  authority?: NotebookPublicationAuthority
): Promise<NotebookPackageFileOps> {
  const lexicalPackageRoot = resolve(input.packageRoot);

  async function canonicalMember(path: string, allowMissing: boolean): Promise<string> {
    const lexicalMember = resolve(path);
    if (!isContained(lexicalPackageRoot, lexicalMember)) {
      throw new Error(`Notebook managed path escaped its package: ${path}`);
    }
    const packagePath = await canonicalWorkspacePath({
      workspaceRoot: input.workspaceRoot,
      path: input.packageRoot,
      allowMissing: true,
      artifactNoun: 'notebook package',
    });
    const memberPath = await canonicalWorkspacePath({
      workspaceRoot: input.workspaceRoot,
      path,
      allowMissing,
      artifactNoun: 'notebook package',
    });
    if (!isContained(packagePath.candidate, memberPath.candidate)) {
      throw new Error(`Notebook managed path escaped its package: ${path}`);
    }
    return memberPath.candidate;
  }

  return {
    async exists(path) {
      const safePath = await canonicalMember(path, true);
      try {
        await access(safePath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
    async mkdir(path, options) {
      const safePath = await canonicalMember(path, true);
      authority?.assertCurrent();
      await mkdir(safePath, options);
      await canonicalMember(path, false);
    },
    async readTextFile(path) {
      return readFile(await canonicalMember(path, false), 'utf8');
    },
    async writeTextFile(path, content) {
      const safePath = await canonicalMember(path, true);
      authority?.assertCurrent();
      await writeFile(safePath, content, 'utf8');
    },
    async rename(oldPath, newPath) {
      const safeOldPath = await canonicalMember(oldPath, false);
      const safeNewPath = await canonicalMember(newPath, true);
      authority?.assertCurrent();
      await rename(safeOldPath, safeNewPath);
      authority?.published(newPath);
    },
    async readDir(path) {
      const entries = await readdir(await canonicalMember(path, false), { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory(),
        isSymbolicLink: entry.isSymbolicLink(),
      }));
    },
    async removeFile(path) {
      await unlink(await canonicalMember(path, false));
    },
    async writeWorkspaceTextFileAtomic(request) {
      authority?.assertCurrent();
      const result = await writeWorkspaceTextFileAtomicInMain(request, {
        beforePublish: () => authority?.assertCurrent(),
      });
      authority?.published(request.path);
      return result;
    },
  };
}

async function withNotebookPublication<T>(
  input: { workspaceRoot: string; packageRoot: string },
  publicationPath: string,
  assertCurrent: (() => void) | undefined,
  operation: (ops: NotebookPackageFileOps) => Promise<T>
): Promise<T> {
  let state: { kind: 'pending' } | { kind: 'refused'; error: unknown } | { kind: 'published' } = {
    kind: 'pending',
  };
  const authority: NotebookPublicationAuthority = {
    assertCurrent() {
      if (state.kind === 'published') return;
      if (state.kind === 'refused') throw state.error;
      try {
        assertCurrent?.();
      } catch (error) {
        state = { kind: 'refused', error };
        throw error;
      }
    },
    published(path) {
      if (resolve(path) === resolve(publicationPath)) state = { kind: 'published' };
    },
  };
  const rethrow = (error: unknown): never => {
    if (state.kind === 'refused') throw state.error;
    throw error;
  };
  try {
    return await operation(await createPackageFileOps(input, authority));
  } catch (error) {
    return rethrow(error);
  }
}

export async function publishNotebookPackageV2InMain(
  input: SerializablePublishNotebookPackageInput,
  assertCurrent?: () => void
): Promise<PublishNotebookPackageResult> {
  return withNotebookPublication(
    input,
    notebookPackagePaths(input.packageRoot).markdownPath,
    assertCurrent,
    (ops) => publishNotebookPackageV2(ops, input)
  );
}

export async function migrateNotebookPackageAtPathInMain(
  input: MigrateNotebookPackageAtPathInput
): Promise<PublishNotebookPackageResult | null> {
  const ops = await createPackageFileOps(input);
  return migrateNotebookPackageAtPath(ops, input);
}

export async function prepareNotebookPackageRenameInMain(
  input: Omit<PrepareNotebookPackageRenameInput, 'now'>,
  assertCurrent?: () => void
): Promise<void> {
  return withNotebookPublication(
    input,
    notebookPackagePaths(input.packageRoot).renameJournalPath,
    assertCurrent,
    (ops) => prepareNotebookPackageRename(ops, input)
  );
}

export async function recoverNotebookPackageRenameIfNeededInMain(
  input: RecoverNotebookPackageRenameInput
): Promise<PublishNotebookPackageResult | null> {
  const ops = await createPackageFileOps(input);
  return recoverNotebookPackageRenameIfNeeded(ops, input.packageRoot);
}
