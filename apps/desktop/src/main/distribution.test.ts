import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDistribution,
  distributionSidecarEnv,
  hostedReferenceCatalogForDistribution,
  isCommunityBuild,
} from './distribution';

describe('runtime build distribution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is official when the build sets nothing or anything other than community', () => {
    expect(buildDistribution()).toBe('official');
    vi.stubGlobal('__DNAFORGE_DISTRIBUTION__', 'official');
    expect(isCommunityBuild()).toBe(false);
    vi.stubGlobal('__DNAFORGE_DISTRIBUTION__', 'Community');
    expect(isCommunityBuild()).toBe(false);
    expect(distributionSidecarEnv()).toEqual({});
  });

  it('is community only for the exact community stamp, which keeps the sidecar offline', () => {
    vi.stubGlobal('__DNAFORGE_DISTRIBUTION__', 'community');
    expect(buildDistribution()).toBe('community');
    expect(isCommunityBuild()).toBe(true);
    expect(distributionSidecarEnv()).toEqual({ DNAFORGE_OFFLINE_ANNOTATION: '1' });
  });

  it('offers hosted references in a community build only from an explicit base URL', () => {
    const catalog = [{ id: 'grch38' }, { id: 'mg1655' }];
    expect(hostedReferenceCatalogForDistribution(catalog, undefined)).toBe(catalog);
    vi.stubGlobal('__DNAFORGE_DISTRIBUTION__', 'community');
    expect(hostedReferenceCatalogForDistribution(catalog, undefined)).toEqual([]);
    expect(hostedReferenceCatalogForDistribution(catalog, '  ')).toEqual([]);
    expect(hostedReferenceCatalogForDistribution(catalog, 'https://mirror.example.org/v1/')).toBe(
      catalog
    );
  });
});
