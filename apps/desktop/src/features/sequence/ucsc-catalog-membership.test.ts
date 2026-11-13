import { describe, expect, it } from 'vitest';

import { catalogIdFromAdmittedSource, catalogIdsInView } from './ucsc-catalog-membership';

const CANONICAL = 'ucsc-native\u0000hg38\u0000gc5BaseBw\u0000';

describe('catalog ids already in a genome view', () => {
  it('uses the catalog id stored when the track was admitted', () => {
    expect(
      catalogIdFromAdmittedSource({
        provenance: { catalogId: ' hg38:gc5BaseBw ' },
      })
    ).toBe('hg38:gc5BaseBw');
  });

  it('rebuilds the catalog id from a UCSC admission address', () => {
    expect(
      catalogIdFromAdmittedSource({
        request: {
          source: {
            kind: 'ucsc-track',
            sourceKind: 'ucsc-native',
            genome: 'hg38',
            track: 'gc5BaseBw',
          },
        },
      })
    ).toBe(CANONICAL);
  });

  it('ignores file, URL, and incomplete addresses', () => {
    expect(catalogIdFromAdmittedSource(undefined)).toBeNull();
    expect(
      catalogIdFromAdmittedSource({
        request: { source: { kind: 'http' } },
      })
    ).toBeNull();
    expect(
      catalogIdFromAdmittedSource({
        request: { source: { kind: 'ucsc-track', genome: 'hg38' } },
      })
    ).toBeNull();
  });

  it('collects ids from the lane source and a durable remote source', () => {
    const ids = catalogIdsInView([
      {
        source: { provenance: { catalogId: 'hg38:gc5BaseBw' } },
        dataset: { trackId: 'signal' },
      },
      {
        dataset: {
          trackId: 'remote',
          remoteSignal: {
            durableSource: { provenance: { catalogId: 'hg38:cpgIslandExt' } },
          },
        },
      },
      {
        source: { request: { source: { kind: 'http' } } },
        dataset: { trackId: 'local-bam' },
      },
    ]);

    expect([...ids]).toEqual(['hg38:gc5BaseBw', 'hg38:cpgIslandExt']);
  });
});
