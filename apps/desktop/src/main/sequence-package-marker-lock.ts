import { isAbsolute, relative, resolve, sep } from 'node:path';
import { sequencePackageMetaPaths, sequencePackageRootForMetaPath } from '../db/sequence-package';

export function packageRootForLockedSequenceMarkerReplace(
  workspaceRoot: string,
  markerPath: string,
  mode: 'create' | 'replace'
): string | null {
  if (mode !== 'replace' || !isAbsolute(workspaceRoot) || !isAbsolute(markerPath)) return null;
  const packageRoot = sequencePackageRootForMetaPath(markerPath);
  if (!packageRoot) return null;
  const canonicalRoot = resolve(packageRoot);
  const relativeRoot = relative(resolve(workspaceRoot), canonicalRoot);
  if (
    relativeRoot === '..' ||
    relativeRoot.startsWith(`..${sep}`) ||
    isAbsolute(relativeRoot) ||
    !sequencePackageMetaPaths(canonicalRoot).some((path) => resolve(path) === resolve(markerPath))
  ) {
    return null;
  }
  return canonicalRoot;
}
