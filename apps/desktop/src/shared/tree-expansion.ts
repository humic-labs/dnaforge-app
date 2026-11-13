import { isPathInsideBoundary } from './path-boundary';

export function retainExpandedBranch(paths: ReadonlySet<string>, targetPath: string): Set<string> {
  return new Set(
    [...paths].filter(
      (path) => isPathInsideBoundary(path, targetPath) || isPathInsideBoundary(targetPath, path)
    )
  );
}
