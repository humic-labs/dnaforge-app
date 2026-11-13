import type { GenomeSessionShell } from './indexed-genome';

export function withoutSessionReadinessDemotion(
  current: GenomeSessionShell | null | undefined,
  next: GenomeSessionShell
): GenomeSessionShell {
  if (!current || current.sessionId !== next.sessionId) return next;
  const currentGeneration = current.assemblyAssetGeneration?.inventoryFingerprint;
  const nextGeneration = next.assemblyAssetGeneration?.inventoryFingerprint;
  if (currentGeneration && nextGeneration && currentGeneration !== nextGeneration) return next;
  let merged = next;
  if (
    current.assemblyAnnotationProductsReadiness === 'ready' &&
    next.assemblyAnnotationProductsReadiness === 'pending'
  ) {
    merged = {
      ...merged,
      assemblyAnnotationProductsReadiness: 'ready',
      assemblyAssetGeneration: merged.assemblyAssetGeneration ?? current.assemblyAssetGeneration,
    };
  }
  if (current.assemblySearchReadiness === 'ready' && next.assemblySearchReadiness === 'pending') {
    merged = {
      ...merged,
      assemblySearchReadiness: 'ready',
      assemblySearchSource: merged.assemblySearchSource ?? current.assemblySearchSource,
      assemblyAnnotationFeatureCount:
        merged.assemblyAnnotationFeatureCount ?? current.assemblyAnnotationFeatureCount,
    };
  }
  return merged;
}
