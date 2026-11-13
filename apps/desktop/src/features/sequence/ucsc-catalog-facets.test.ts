// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { UcscCatalogLeaf } from '@waypoint/genome-data';

import {
  applyUcscCatalogFacets,
  computeUcscCatalogFacets,
  countSelectedFacets,
  toggleCatalogFacet,
  TRACK_KIND_FACET_KEY,
} from './ucsc-catalog-facets';

function leaf(
  track: string,
  scientificKind: UcscCatalogLeaf['scientificKind'],
  facts: Readonly<Record<string, string>> = {}
): UcscCatalogLeaf {
  return {
    sourceKind: 'ucsc-native',
    catalogId: `hg38:${track}`,
    track,
    shortLabel: track,
    longLabel: `${track} long`,
    scientificKind,
    formatId: 'bigwig',
    assembly: { ucscGenome: 'hg38', aliases: ['hg38'] },
    attributes: Object.entries(facts).map(([key, value]) => ({
      key,
      value,
      origin: 'subGroups' as const,
    })),
  } as UcscCatalogLeaf;
}

const CATALOG = [
  leaf('a', 'quantitative', { organ: 'brain', dataType: 'typeH3k27ac' }),
  leaf('b', 'quantitative', { organ: 'brain', dataType: 'typeCTCF' }),
  leaf('c', 'quantitative', { organ: 'liver', dataType: 'typeH3k27ac' }),
  leaf('d', 'peak', { organ: 'liver', dataType: 'typeCTCF' }),
  leaf('e', 'transcript'),
];

describe('offering the questions worth asking about a catalog', () => {
  it('always offers the kind of data, and names it in words', () => {
    const [first] = computeUcscCatalogFacets(CATALOG);
    expect(first?.key).toBe(TRACK_KIND_FACET_KEY);
    expect(first?.label).toBe('Track type');
    expect(first?.values.map((entry) => `${entry.label}:${entry.count}`)).toEqual([
      'Signal:3',
      'Gene models:1',
      'Peaks:1',
    ]);
  });

  it('reads a declared fact as a question, in plain words', () => {
    const groups = computeUcscCatalogFacets(CATALOG);
    const organ = groups.find((group) => group.key === 'organ');
    expect(organ?.label).toBe('Organ');
    expect(organ?.values.map((entry) => entry.value)).toEqual(['brain', 'liver']);
  });

  it("strips the catalog's own prefix off a value, so typeH3k27ac reads as H3k27ac", () => {
    const groups = computeUcscCatalogFacets(CATALOG);
    const assay = groups.find((group) => group.key === 'dataType');
    expect(assay?.values.map((entry) => entry.label).sort()).toEqual(['CTCF', 'H3k27ac']);
  });

  it('drops a question with only one answer, because choosing it narrows nothing', () => {
    const catalog = [
      leaf('a', 'quantitative', { assembly: 'hg38', organ: 'brain' }),
      leaf('b', 'quantitative', { assembly: 'hg38', organ: 'liver' }),
    ];
    const keys = computeUcscCatalogFacets(catalog).map((group) => group.key);
    expect(keys).toContain('organ');
    expect(keys).not.toContain('assembly');
  });

  it('drops a fact that is nearly one value per track, which cannot narrow', () => {
    const catalog = Array.from({ length: 10 }, (_, index) =>
      leaf(`t${index}`, 'quantitative', { donor: `ENCDO${index}`, organ: 'brain' })
    );
    expect(computeUcscCatalogFacets(catalog).map((group) => group.key)).not.toContain('donor');
  });

  it('never offers strand, which divides evenly and answers nothing', () => {
    const catalog = Array.from({ length: 12 }, (_, index) =>
      leaf(`t${index}`, 'quantitative', {
        strand: index % 2 === 0 ? 'forward' : 'reverse',
        organ: index < 6 ? 'brain' : 'liver',
      })
    );
    const keys = computeUcscCatalogFacets(catalog).map((group) => group.key);
    expect(keys).toContain('organ');
    expect(keys).not.toContain('strand');
  });

  it('offers high-cardinality cell types and measured factors without mistaking donor IDs for browse choices', () => {
    const catalog = Array.from({ length: 800 }, (_, index) =>
      leaf(`t${index}`, index % 2 ? 'peak' : 'quantitative', {
        cellType: `cell${index % 200}`,
        factor: `factor${index % 320}`,
        donor: `donor${index % 80}`,
      })
    );
    const groups = computeUcscCatalogFacets(catalog);
    expect(groups.find((group) => group.key === 'cellType')?.values).toHaveLength(200);
    expect(groups.find((group) => group.key === 'factor')?.values).toHaveLength(320);
    expect(groups.map((group) => group.key)).not.toContain('donor');
  });

  it('exposes more than eight useful questions when the catalog supplies them', () => {
    const keys = [
      'organ',
      'tissue',
      'cellType',
      'factor',
      'dataType',
      'biosampleType',
      'category',
      'sequenceTech',
      'treatment',
      'assay',
    ];
    const catalog = Array.from({ length: 80 }, (_, index) =>
      leaf(
        `t${index}`,
        index % 2 ? 'peak' : 'quantitative',
        Object.fromEntries(keys.map((key) => [key, `${key}${index % 2}`]))
      )
    );
    const groups = computeUcscCatalogFacets(catalog);
    expect(groups.map((group) => group.key)).toEqual(expect.arrayContaining(keys));
  });

  it('narrows to the chosen value, and to all of them across questions', () => {
    const byOrgan = applyUcscCatalogFacets(CATALOG, { organ: ['brain'] });
    expect(byOrgan.map((entry) => entry.track)).toEqual(['a', 'b']);

    const both = applyUcscCatalogFacets(CATALOG, { organ: ['brain'], dataType: ['typeCTCF'] });
    expect(both.map((entry) => entry.track)).toEqual(['b']);
  });

  it('treats two values in one question as either, not both', () => {
    const either = applyUcscCatalogFacets(CATALOG, { organ: ['brain', 'liver'] });
    expect(either).toHaveLength(4);
  });

  it('keeps showing what the unpicked answers would give', () => {
    const groups = computeUcscCatalogFacets(CATALOG, { organ: ['brain'] });
    const organ = groups.find((group) => group.key === 'organ');
    expect(organ?.values.map((entry) => `${entry.value}:${entry.count}`)).toEqual([
      'brain:2',
      'liver:2',
    ]);

    const assay = groups.find((group) => group.key === 'dataType');
    expect(assay?.values.every((entry) => entry.count === 1)).toBe(true);
  });

  it('keeps a chosen question visible even once it has one answer left', () => {
    const groups = computeUcscCatalogFacets(CATALOG, { dataType: ['typeH3k27ac'] });
    expect(groups.map((group) => group.key)).toContain('dataType');
  });

  it('adds and removes one answer without disturbing the others', () => {
    let selection = toggleCatalogFacet({}, 'organ', 'brain');
    selection = toggleCatalogFacet(selection, 'dataType', 'typeCTCF');
    expect(countSelectedFacets(selection)).toBe(2);

    selection = toggleCatalogFacet(selection, 'organ', 'brain');
    expect(selection.organ).toBeUndefined();
    expect(selection.dataType).toEqual(['typeCTCF']);
    expect(countSelectedFacets(selection)).toBe(1);
  });

  it('leaves the list alone when nothing is chosen', () => {
    expect(applyUcscCatalogFacets(CATALOG, {})).toBe(CATALOG);
    expect(applyUcscCatalogFacets(CATALOG, { organ: [] })).toBe(CATALOG);
  });
});
