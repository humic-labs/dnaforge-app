import { resolve, join, basename } from 'path';

import { isPathInsideBoundary } from '../shared/path-boundary';

export type MovePlan = { ok: true; destPath: string } | { ok: false; reason: 'noop' | 'into-self' };

export function planMoveIntoDirectory(sourcePath: string, destinationDir: string): MovePlan {
  const src = resolve(sourcePath);
  const destDir = resolve(destinationDir);
  const destPath = join(destDir, basename(src));
  if (destPath === src) return { ok: false, reason: 'noop' };
  if (isPathInsideBoundary(destDir, src)) return { ok: false, reason: 'into-self' };
  return { ok: true, destPath };
}
