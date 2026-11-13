import { normalizePathForBoundary } from './path-boundary';

export interface ProjectRootRef {
  path: string;
  pinned?: boolean;
}

export interface NamedProjectRootRef extends ProjectRootRef {
  name: string;
}

export function writableProjectRoots<T extends ProjectRootRef>(roots: readonly T[]): T[] {
  return roots.filter((root) => !root.pinned);
}

export function soleWritableProjectRoot<T extends ProjectRootRef>(roots: readonly T[]): T | null {
  const writable = writableProjectRoots(roots);
  return writable.length === 1 ? writable[0] : null;
}

export function resolveMountedProjectRoot<T extends ProjectRootRef>(
  roots: readonly T[],
  selectedPath?: string | null
): T | null {
  const writable = writableProjectRoots(roots);
  const selectedMatches = selectedPath
    ? writable.filter(
        (root) => normalizePathForBoundary(root.path) === normalizePathForBoundary(selectedPath)
      )
    : [];
  const selected = selectedMatches.length === 1 ? selectedMatches[0] : null;
  if (selectedMatches.length > 1) return null;
  if (selected) return selected;
  return writable.length === 1 ? writable[0] : null;
}

export function soleReadableProjectRoot<T extends ProjectRootRef>(roots: readonly T[]): T | null {
  const writable = writableProjectRoots(roots);
  const eligible = writable.length > 0 ? writable : [...roots];
  return eligible.length === 1 ? eligible[0] : null;
}

export function uniquelyNamedProjectRoot<T extends NamedProjectRootRef>(
  roots: readonly T[],
  name: string
): T | null {
  const normalizedName = name.toLocaleLowerCase();
  const matches = roots.filter((root) => root.name.toLocaleLowerCase() === normalizedName);
  return matches.length === 1 ? matches[0] : null;
}

export function resolveExplicitProjectRoot<T extends NamedProjectRootRef>(
  roots: readonly T[],
  reference: string
): T | null {
  const normalizedReference = normalizePathForBoundary(reference);
  const pathMatches = roots.filter(
    (root) => normalizePathForBoundary(root.path) === normalizedReference
  );
  if (pathMatches.length === 1) return pathMatches[0];
  if (pathMatches.length > 1) return null;
  return uniquelyNamedProjectRoot(roots, reference);
}
