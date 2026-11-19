import { platform } from '../platform';
import { readScientificNamespace } from './read-scientific-namespace';

export async function readAcceptedScientificFile(
  workspaceRoot: string,
  relativePath: string,
  maxBytes: number
): Promise<{ bytes: Uint8Array; resourceId: string; workspaceScope: string } | null> {
  const namespace = await readScientificNamespace(workspaceRoot);
  if (!namespace) return null;
  const entry = namespace.entries.find(
    (candidate) =>
      candidate.path === relativePath ||
      (candidate.tombstone && candidate.lastPath === relativePath)
  );
  if (!entry) return null;
  if (entry.tombstone)
    throw new Error('The accepted project file was deleted. Restore it explicitly before opening.');
  const snapshot = await platform().scientificObjects.read({
    workspaceRoot,
    request: {
      workspace: namespace.workspace,
      resourceId: entry.resourceId,
      revisionId: entry.revisionId,
    },
  });
  if (!snapshot?.representation || snapshot.revisionId !== entry.revisionId)
    throw new Error('The accepted native project file is unavailable.');
  const bytes = new TextEncoder().encode(snapshot.representation.text);
  if (bytes.byteLength > maxBytes)
    throw new Error(
      'The accepted file changed size after this project snapshot. Refresh before opening.'
    );
  return { bytes, resourceId: entry.resourceId, workspaceScope: namespace.workspace };
}
