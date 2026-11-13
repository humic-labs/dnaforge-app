import { isPathInsideBoundary } from './path-boundary';

export function parentDirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

export function baseNameOf(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

export function pathIsWithinDir(path: string, dir: string): boolean {
  return isPathInsideBoundary(path, dir);
}

export function isValidMoveTarget(sourcePath: string, destDir: string): boolean {
  if (!destDir) return false;
  if (destDir === sourcePath) return false;
  if (isPathInsideBoundary(destDir, sourcePath)) return false;
  if (destDir === parentDirOf(sourcePath)) return false;
  return true;
}
