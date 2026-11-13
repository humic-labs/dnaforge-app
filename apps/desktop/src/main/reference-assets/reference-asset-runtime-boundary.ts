import { isPathInsideBoundary } from '../../shared/path-boundary';

export class ReferenceAssetRuntimeMutationError extends Error {
  constructor(candidatePath: string) {
    super(`Viewer runtime cannot mutate prepared reference assets: ${candidatePath}`);
    this.name = 'ReferenceAssetRuntimeMutationError';
  }
}

export function assertReferenceAssetRuntimeWriteAllowed(input: {
  readonly referenceAssetCacheRoot: string;
  readonly candidatePath: string;
}): void {
  if (isPathInsideBoundary(input.candidatePath, input.referenceAssetCacheRoot)) {
    throw new ReferenceAssetRuntimeMutationError(input.candidatePath);
  }
}

export function isPreparedReferenceAssetPath(input: {
  readonly referenceAssetCacheRoot: string;
  readonly candidatePath: string;
}): boolean {
  return isPathInsideBoundary(input.candidatePath, input.referenceAssetCacheRoot);
}
