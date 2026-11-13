// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { UcscCatalogLeaf } from '@waypoint/genome-data';

import { searchUcscCatalogLocally, ucscCatalogSearchTerms } from './ucsc-catalog-search';

function leaf(
  track: string,
  overrides: Partial<UcscCatalogLeaf> & { shortLabel?: string } = {}
): UcscCatalogLeaf {
  return {
    sourceKind: 'ucsc-hub',
    catalogId: `ucsc-hub\u0000hg38\u0000${track}`,
    track,
    shortLabel: overrides.shortLabel ?? track,
    longLabel: `${track} long label`,
    scientificKind: 'quantitative',
    formatId: 'bigwig',
    assembly: { ucscGenome: 'hg38', aliases: ['hg38'] },
    ...overrides,
  } as UcscCatalogLeaf;
}

describe('splitting a typed query into words', () => {
  it('drops the whitespace a person actually types', () => {
    expect(ucscCatalogSearchTerms('  brain   H3K27ac ')).toEqual(['brain', 'h3k27ac']);
  });

  it('treats an empty query as no terms at all', () => {
    expect(ucscCatalogSearchTerms('   ')).toEqual([]);
  });
});

describe('matching a query against a catalog held in full', () => {
  it('returns the whole catalog when nothing is typed', () => {
    const catalog = [leaf('a'), leaf('b')];
    const result = searchUcscCatalogLocally(catalog, '');
    expect(result.tracks).toEqual(catalog);
    expect(result.total).toBe(2);
    expect(result.catalogSize).toBe(2);
  });

  it('finds a track from two words in either order, which the old search could not', () => {
    const brainH3k27ac = leaf('ENCFF014NIB', {
      shortLabel: 'ENCFF014NIB',
      longLabel: 'Middle frontal area 46, female adult (78 years): (4) H3K27ac',
      attributes: [
        { key: 'organ', value: 'brain', origin: 'subGroups' },
        { key: 'dataType', value: 'typeH3k27ac', origin: 'subGroups' },
      ],
    });
    const catalog = [brainH3k27ac, leaf('other')];

    for (const query of ['brain H3K27ac', 'H3K27ac brain', 'brain  H3K27ac']) {
      const result = searchUcscCatalogLocally(catalog, query);
      expect(result.tracks.map((track) => track.track)).toEqual(['ENCFF014NIB']);
      expect(result.total).toBe(1);
    }
  });

  it('requires every word, so an extra word narrows instead of widening', () => {
    const catalog = [
      leaf('a', { shortLabel: 'vagina CTCF 1' }),
      leaf('b', { shortLabel: 'vagina POLR2A 1' }),
    ];
    expect(searchUcscCatalogLocally(catalog, 'vagina').total).toBe(2);
    expect(
      searchUcscCatalogLocally(catalog, 'vagina CTCF').tracks.map((track) => track.shortLabel)
    ).toEqual(['vagina CTCF 1']);
  });

  it('matches a fact the catalog declared even when no label mentions it', () => {
    const catalog = [
      leaf('tss1', {
        shortLabel: 'AchillesTendonD2+',
        attributes: [{ key: 'sequenceTech', value: 'hCAGE', origin: 'subGroups' }],
      }),
      leaf('tss2', { shortLabel: 'Something else' }),
    ];
    expect(searchUcscCatalogLocally(catalog, 'hCAGE').tracks.map((t) => t.track)).toEqual(['tss1']);
  });

  it('matches the name of a folder the hub declared', () => {
    const catalog = [
      leaf('inner', {
        containerPath: [{ track: 'cons26way', shortLabel: 'Conservation', kind: 'composite' }],
      }),
      leaf('outer'),
    ];
    expect(searchUcscCatalogLocally(catalog, 'conservation').tracks.map((t) => t.track)).toEqual([
      'inner',
    ]);
  });

  it('returns every match rather than a capped page, so a total is a total', () => {
    const catalog = Array.from({ length: 1_200 }, (_, index) =>
      leaf(`brainTrack${index}`, { shortLabel: `brain sample ${index}` })
    );
    const result = searchUcscCatalogLocally(catalog, 'brain');
    expect(result.total).toBe(1_200);
    expect(result.tracks).toHaveLength(1_200);
    expect(result.catalogSize).toBe(1_200);
  });

  it('puts an exact track identifier first however it would otherwise rank', () => {
    const catalog = [
      leaf('genscanExtra', { shortLabel: 'genscan companion' }),
      leaf('genscan', { shortLabel: 'Genscan Genes' }),
    ];
    expect(searchUcscCatalogLocally(catalog, 'genscan').tracks[0]?.track).toBe('genscan');
  });

  it('ranks a hit in the name above one that only appears in a declared fact', () => {
    const byFact = leaf('a', {
      shortLabel: 'ENCFF999XYZ',
      longLabel: 'an opaque accession',
      attributes: [{ key: 'organ', value: 'brain', origin: 'subGroups' }],
    });
    const byName = leaf('b', { shortLabel: 'Brain signal', longLabel: 'also opaque' });
    const byDescription = leaf('c', {
      shortLabel: 'ENCFF111ABC',
      longLabel: 'measured in brain tissue',
    });
    const ordered = searchUcscCatalogLocally([byFact, byDescription, byName], 'brain');
    expect(ordered.tracks.map((track) => track.track)).toEqual(['b', 'c', 'a']);
  });

  it('keeps the catalog order inside one rank, so kinds and names stay sorted', () => {
    const catalog = [
      leaf('gene1', { shortLabel: 'brain genes A', scientificKind: 'transcript' }),
      leaf('gene2', { shortLabel: 'brain genes B', scientificKind: 'transcript' }),
      leaf('sig1', { shortLabel: 'brain signal A' }),
    ];
    expect(searchUcscCatalogLocally(catalog, 'brain').tracks.map((t) => t.track)).toEqual([
      'gene1',
      'gene2',
      'sig1',
    ]);
  });
});
