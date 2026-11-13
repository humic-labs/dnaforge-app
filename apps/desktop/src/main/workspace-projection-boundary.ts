import { lstatSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { isPathInsideBoundary } from '../shared/path-boundary';

export function assertWorkspaceProjectionPathSafe(
  workspaceRoot: string,
  candidatePath: string
): void {
  const root = resolve(workspaceRoot);
  const candidate = resolve(candidatePath);
  if (!isPathInsideBoundary(candidate, root)) {
    throw new Error(`Workspace projection path is outside the workspace: ${candidate}`);
  }

  assertExistingSegmentIsSafe(root, true);
  const relativePath = relative(root, candidate);
  if (!relativePath) return;

  let current = root;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    if (!assertExistingSegmentIsSafe(current, false)) return;
  }
}

function assertExistingSegmentIsSafe(path: string, requireDirectory: boolean): boolean {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Workspace projection path contains a symbolic link: ${path}`);
  }
  if (requireDirectory && !stats.isDirectory()) {
    throw new Error(`Workspace projection root is not a directory: ${path}`);
  }
  return true;
}
