import { defineScientificDocument, type ScientificSnapshot } from '@waypoint/scientific-objects';
import type { ScientificArtifactPort } from './scientific-artifact-port';
import type { ArtifactFiles } from './artifact-io';
import type { DesktopScientificObjectReadRequest } from './scientific-objects-ipc';
export function createScientificRelationshipGitReader(dependencies: {
  namespace: ScientificArtifactPort['namespace'];
  files: Pick<ArtifactFiles, 'exists' | 'readTextFile'>;
  read(input: DesktopScientificObjectReadRequest): Promise<ScientificSnapshot | null>;
}) {
  const generated = (path: string) => path.startsWith('.dnaforge/relationships/');

  async function scientificRelationshipGitPaths(
    workspaceRoot: string,
    dirty: ReadonlyMap<string, unknown>
  ): Promise<string[]> {
    if (![...dirty.keys()].some(generated)) return [];
    const namespace = await dependencies.namespace(workspaceRoot);
    if (!namespace) return [];
    const paths: string[] = [];
    for (const entry of namespace.entries) {
      const path = entry.path ?? entry.lastPath;
      if (!path || !generated(path) || !dirty.has(path)) continue;
      const absolutePath = `${workspaceRoot.replace(/[\\/]+$/, '')}/${path}`;
      if (entry.tombstone) {
        if (await dependencies.files.exists(absolutePath))
          throw new Error(
            `Generated relationship deletion has a conflicting working file: ${path}`
          );
      } else {
        const snapshot = await dependencies.read({
          workspaceRoot,
          request: {
            workspace: namespace.workspace,
            resourceId: entry.resourceId,
            revisionId: entry.revisionId,
          },
        });
        if (
          !snapshot ||
          snapshot.resourceId !== entry.resourceId ||
          snapshot.revisionId !== entry.revisionId
        )
          throw new Error(`Accepted relationship is unavailable: ${path}`);
        const expected =
          snapshot.representation?.text ?? defineScientificDocument(snapshot.document).text;
        if ((await dependencies.files.readTextFile(absolutePath)) !== expected)
          throw new Error(`Generated relationship has a conflicting working edit: ${path}`);
      }
      paths.push(path);
    }
    return paths;
  }

  return scientificRelationshipGitPaths;
}
