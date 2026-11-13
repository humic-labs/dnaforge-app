import type { BuildDistribution } from '../shared/build-distribution';

export function buildDistribution(): BuildDistribution {
  return typeof __DNAFORGE_DISTRIBUTION__ === 'string' && __DNAFORGE_DISTRIBUTION__ === 'community'
    ? 'community'
    : 'official';
}

export function isCommunityBuild(): boolean {
  return buildDistribution() === 'community';
}

export function distributionSidecarEnv(): Record<string, string> {
  return isCommunityBuild() ? { DNAFORGE_OFFLINE_ANNOTATION: '1' } : {};
}

export function hostedReferenceCatalogForDistribution<T>(
  catalog: ReadonlyArray<T>,
  explicitBaseUrl: string | undefined
): ReadonlyArray<T> {
  return isCommunityBuild() && !explicitBaseUrl?.trim() ? [] : catalog;
}
