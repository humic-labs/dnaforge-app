import {
  loadSequencePackageDocument,
  resolveAlignmentHistoryPaths,
  writeAlignmentHistoryMember,
} from '../../../db/sequence-package-io';
import { platform } from '../../../platform';
import { managedOperations } from '../../../services/managed-operations';
import { withRendererWorkspaceMutation } from '../../../services/workspace-mutation-transaction';
import { getAlignmentSidecarPath } from '../store/sidecar';
import {
  findAlignmentWorkspaceRoot,
  findSequencePackageRootForReference,
} from './stage-alignment-query';

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function withoutSavedAt(content: string): string {
  return JSON.stringify({ ...JSON.parse(content), savedAt: null });
}

function sameAlignmentHistory(stored: string, content: string): boolean {
  try {
    return withoutSavedAt(stored) === withoutSavedAt(content);
  } catch {
    return false;
  }
}

function packageFs() {
  const fs = platform().fs;
  if (!fs.move || !fs.writeTextFile || !fs.mkdir || !fs.readTextFile) return null;
  return fs;
}

export async function publishManagedAlignmentHistory(
  referencePath: string,
  content: string,
  operation: { id: string; inputRevision: string }
): Promise<boolean> {
  if (!referencePath.startsWith('/hosted/')) return false;
  const fs = packageFs();
  if (!fs) throw new Error('The project filesystem is unavailable. The job result is retained.');
  const root = await findSequencePackageRootForReference(referencePath);
  const paths = await resolveAlignmentHistoryPaths(referencePath, root, fs);
  for (const path of paths) {
    if (!(await fs.exists(path))) continue;
    if (withoutSavedAt(await fs.readTextFile(path)) === withoutSavedAt(content)) return true;
    await managedOperations.publishWorkspaceResult({
      operationId: operation.id,
      inputRevision: operation.inputRevision,
      path,
      content,
    });
    return true;
  }
  throw new Error('The saved alignment session is missing. Its result is retained in Jobs.');
}

export async function writeAlignmentHistory(
  referencePath: string,
  content: string
): Promise<string> {
  const stored = await storedAlignmentHistory(referencePath).catch(() => null);
  if (stored && sameAlignmentHistory(stored.content, content)) return stored.path;
  const fs = packageFs();
  const packageRoot = await findSequencePackageRootForReference(referencePath);
  if (fs && packageRoot) {
    const workspaceRoot = await findAlignmentWorkspaceRoot(referencePath);
    if (!workspaceRoot) {
      throw new Error('Saving alignment history requires a writable owning project.');
    }
    if (!packageRoot.startsWith('/hosted/')) {
      const document = await loadSequencePackageDocument(packageRoot, fs);
      return fs.publishSequenceAlignmentHistory({
        workspaceRoot,
        packageRoot,
        packageId: document.id,
        content,
      });
    }

    return withRendererWorkspaceMutation(
      packageRoot.startsWith('/hosted/') ? packageRoot : null,
      () =>
        writeAlignmentHistoryMember({
          packageRoot,
          workspaceRoot,
          productFile: fileNameOf(referencePath),
          content,
          fs,
        })
    );
  }
  const sidecarPath = getAlignmentSidecarPath(referencePath);
  if (!platform().fs.writeTextFile) {
    throw new Error('Cannot write alignment history: filesystem write is unavailable.');
  }
  await platform().fs.writeTextFile(sidecarPath, content);
  return sidecarPath;
}

async function storedAlignmentHistory(
  referencePath: string
): Promise<{ path: string; content: string } | null> {
  const fs = packageFs();
  const exists = platform().fs.exists;
  const readTextFile = platform().fs.readTextFile;
  if (!exists || !readTextFile) return null;
  const candidates = fs
    ? await resolveAlignmentHistoryPaths(
        referencePath,
        await findSequencePackageRootForReference(referencePath),
        fs
      )
    : [getAlignmentSidecarPath(referencePath)];
  for (const path of candidates) {
    if (await exists(path)) return { path, content: await readTextFile(path) };
  }
  return null;
}

export async function readAlignmentHistory(referencePath: string): Promise<string | null> {
  return (await storedAlignmentHistory(referencePath))?.content ?? null;
}
