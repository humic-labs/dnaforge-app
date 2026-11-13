import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockBuildGenomeAssembly, mockReadTextFile, mockReferenceAssetCacheRoot } = vi.hoisted(
  () => ({
    mockBuildGenomeAssembly: vi.fn(),
    mockReadTextFile: vi.fn(),
    mockReferenceAssetCacheRoot: vi.fn(),
  })
);

vi.mock('../../../platform', () => ({
  platform: () => ({
    path: { referenceAssetCacheRoot: mockReferenceAssetCacheRoot },
    fs: { readTextFile: mockReadTextFile },
  }),
}));

vi.mock('../reference-catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../reference-catalog')>();
  return {
    ...actual,
    buildGenomeAssembly: mockBuildGenomeAssembly,
  };
});

import { buildAssemblyOverviewTexturePrecomputeGenome } from './assembly-overview-texture-precompute';

describe('assembly overview texture precompute source generation', () => {
  beforeEach(() => {
    mockBuildGenomeAssembly.mockReset();
    mockReadTextFile.mockReset();
    mockReferenceAssetCacheRoot.mockReset();
    mockReferenceAssetCacheRoot.mockResolvedValue('/cache');
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        contract: 'reference-asset-publication.v1',
        assetCacheKey: 'grch38',
        publicationId: 'committed-generation',
        sourceMaterializationFingerprint: 'a'.repeat(64),
        publishedAtMs: 1,
      })
    );
    mockBuildGenomeAssembly.mockImplementation(
      (_entry: unknown, resolvePath: (relativePath: string) => string) => ({
        assemblyId: 'grch38',
        displayName: 'GRCh38',
        chromosomes: [],
        resolvedProbePath: resolvePath('prepared/chr1/chr1.gff3.gz'),
      })
    );
  });

  it('resolves prepared chromosomes below the committed immutable generation', async () => {
    await expect(
      buildAssemblyOverviewTexturePrecomputeGenome({
        assemblyId: 'grch38',
        workspaceRoot: '/workspace',
      })
    ).resolves.toBeNull();

    expect(mockReadTextFile).toHaveBeenCalledWith('/cache/grch38/current-reference-assets.v1.json');
    const assembly = mockBuildGenomeAssembly.mock.results[0]?.value as {
      resolvedProbePath: string;
    };
    expect(assembly.resolvedProbePath).toBe(
      '/cache/grch38/generations/committed-generation/prepared/chr1/chr1.gff3.gz'
    );
  });

  it('does not touch mutable prepared paths when no valid publication is committed', async () => {
    mockReadTextFile.mockResolvedValue('{}');

    await expect(
      buildAssemblyOverviewTexturePrecomputeGenome({
        assemblyId: 'grch38',
        workspaceRoot: '/workspace',
      })
    ).resolves.toBeNull();

    expect(mockBuildGenomeAssembly).not.toHaveBeenCalled();
  });
});
