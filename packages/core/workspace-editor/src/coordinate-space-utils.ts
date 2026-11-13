import type { CoordinateSpace } from './types';

export function isInAlignmentMode(coordinateSpace?: CoordinateSpace | null): boolean {
  if (!coordinateSpace) return false;
  return coordinateSpace.mode === 'gapped' || !!coordinateSpace.alignedQuery;
}
