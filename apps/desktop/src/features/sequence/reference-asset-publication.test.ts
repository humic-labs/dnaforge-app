import { describe, expect, it } from 'vitest';

import {
  createReferenceAssetProductLayoutV1,
  parseReferenceAssetPublicationV1,
  REFERENCE_ASSET_PRODUCT_STORAGE_GENERATION_V1,
  referenceAssetPublicationPath,
  referenceAssetPublicationProductRoot,
  referenceAssetPublicationSourceRoot,
  requiredReferenceAssetAnnotationProductV1,
  resolveCurrentReferenceAssetPublicationV1,
} from './reference-asset-publication';

const PUBLICATION = {
  contract: 'reference-asset-publication.v1',
  assetCacheKey: 'grch38',
  publicationId: '7eb6d830-113c-4e9a-b150-891254721e49',
  sourceMaterializationFingerprint: 'a'.repeat(64),
  publishedAtMs: 1_753_490_000_000,
} as const;
const REQUIRED_PRODUCTS = [
  {
    assemblyId: 'grch38',
    themeMode: 'light',
    sourceFingerprint: 'b'.repeat(24),
    inventoryFingerprint: 'c'.repeat(64),
  },
  {
    assemblyId: 'grch38',
    themeMode: 'dark',
    sourceFingerprint: 'b'.repeat(24),
    inventoryFingerprint: 'e'.repeat(64),
  },
] as const;

describe('reference asset publication', () => {
  it('derives the pointer and immutable source root below one assembly cache', () => {
    expect(referenceAssetPublicationPath('/cache/grch38')).toBe(
      '/cache/grch38/current-reference-assets.v1.json'
    );
    expect(referenceAssetPublicationSourceRoot('/cache/grch38', PUBLICATION)).toBe(
      '/cache/grch38/generations/7eb6d830-113c-4e9a-b150-891254721e49'
    );
  });

  it('rejects path traversal, the wrong assembly, or a malformed fingerprint', () => {
    expect(parseReferenceAssetPublicationV1(PUBLICATION, 'grch38')).toEqual(PUBLICATION);
    expect(
      parseReferenceAssetPublicationV1({ ...PUBLICATION, publicationId: '../current' }, 'grch38')
    ).toBeNull();
    expect(parseReferenceAssetPublicationV1(PUBLICATION, 'grch37')).toBeNull();
    expect(
      parseReferenceAssetPublicationV1(
        { ...PUBLICATION, sourceMaterializationFingerprint: 'stale' },
        'grch38'
      )
    ).toBeNull();
  });

  it('reads the commit pointer and resolves only its immutable source generation', async () => {
    const readPaths: string[] = [];
    const resolved = await resolveCurrentReferenceAssetPublicationV1({
      assemblyCacheRoot: '/cache/grch38',
      assetCacheKey: 'grch38',
      readTextFile: async (path) => {
        readPaths.push(path);
        return JSON.stringify(PUBLICATION);
      },
    });

    expect(readPaths).toEqual(['/cache/grch38/current-reference-assets.v1.json']);
    expect(resolved).toEqual({
      publication: PUBLICATION,
      sourceGenerationRoot: '/cache/grch38/generations/7eb6d830-113c-4e9a-b150-891254721e49',
      productWorkspaceRoot: '/cache/grch38',
    });
  });

  it('reads a shared immutable generation through a profile pointer without copying payload bytes', async () => {
    const readPaths: string[] = [];
    const resolved = await resolveCurrentReferenceAssetPublicationV1({
      assemblyCacheRoot: '/shared/grch38',
      publicationAssemblyRoot: '/profiles/dev/grch38',
      fallbackPublicationAssemblyRoot: '/shared/grch38',
      assetCacheKey: 'grch38',
      readTextFile: async (path) => {
        readPaths.push(path);
        if (path.startsWith('/profiles/')) throw new Error('profile has not selected yet');
        return JSON.stringify(PUBLICATION);
      },
    });

    expect(readPaths).toEqual([
      '/profiles/dev/grch38/current-reference-assets.v1.json',
      '/shared/grch38/current-reference-assets.v1.json',
    ]);
    expect(resolved?.sourceGenerationRoot).toBe(
      `/shared/grch38/generations/${PUBLICATION.publicationId}`
    );
    expect(resolved?.productWorkspaceRoot).toBe('/shared/grch38');
  });

  it('binds a complete light/dark product family to one explicit storage layout', () => {
    const publication = {
      ...PUBLICATION,
      productLayout: createReferenceAssetProductLayoutV1(REQUIRED_PRODUCTS),
    };
    expect(parseReferenceAssetPublicationV1(publication, 'grch38')).toEqual(publication);
    expect(referenceAssetPublicationProductRoot('/cache/grch38', publication)).toBe(
      '/cache/grch38'
    );
    expect(requiredReferenceAssetAnnotationProductV1(publication, 'grch38', 'dark')).toEqual(
      REQUIRED_PRODUCTS[1]
    );

    const generationLocal = {
      ...PUBLICATION,
      productLayout: createReferenceAssetProductLayoutV1(
        REQUIRED_PRODUCTS,
        REFERENCE_ASSET_PRODUCT_STORAGE_GENERATION_V1
      ),
    };
    expect(referenceAssetPublicationProductRoot('/cache/grch38', generationLocal)).toBe(
      `/cache/grch38/generations/${PUBLICATION.publicationId}`
    );
  });

  it('accepts a light colour-basis family without dark products', () => {
    const lightOnly = createReferenceAssetProductLayoutV1([REQUIRED_PRODUCTS[0]]);
    expect(
      parseReferenceAssetPublicationV1({ ...PUBLICATION, productLayout: lightOnly }, 'grch38')
        ?.productLayout?.requiredAnnotationProducts
    ).toEqual([REQUIRED_PRODUCTS[0]]);
  });

  it('rejects incomplete, duplicate, cross-source, or unknown product layouts', () => {
    const complete = createReferenceAssetProductLayoutV1(REQUIRED_PRODUCTS);
    for (const requiredAnnotationProducts of [
      [REQUIRED_PRODUCTS[1]],
      [REQUIRED_PRODUCTS[0], REQUIRED_PRODUCTS[0]],
      [REQUIRED_PRODUCTS[0], { ...REQUIRED_PRODUCTS[1], sourceFingerprint: 'd'.repeat(24) }],
    ]) {
      expect(
        parseReferenceAssetPublicationV1(
          { ...PUBLICATION, productLayout: { ...complete, requiredAnnotationProducts } },
          'grch38'
        )
      ).toBeNull();
    }
    expect(
      parseReferenceAssetPublicationV1(
        {
          ...PUBLICATION,
          productLayout: { ...complete, storage: 'probe-whichever-root-exists' },
        },
        'grch38'
      )
    ).toBeNull();
  });

  it('fails closed when the commit pointer is missing or invalid', async () => {
    await expect(
      resolveCurrentReferenceAssetPublicationV1({
        assemblyCacheRoot: '/cache/grch38',
        assetCacheKey: 'grch38',
        readTextFile: async () => {
          throw new Error('ENOENT');
        },
      })
    ).resolves.toBeNull();
    await expect(
      resolveCurrentReferenceAssetPublicationV1({
        assemblyCacheRoot: '/cache/grch38',
        assetCacheKey: 'grch38',
        readTextFile: async () => JSON.stringify({ ...PUBLICATION, publicationId: '../mutable' }),
      })
    ).resolves.toBeNull();
  });
});
