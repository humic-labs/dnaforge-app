// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { UcscCatalogLeaf } from '@waypoint/genome-data';

import { collapseVersionFamilies } from './ucsc-catalog-versions';

function leaf(
  shortLabel: string,
  containers: ReadonlyArray<string> = [],
  track?: string
): UcscCatalogLeaf {
  return {
    sourceKind: 'ucsc-native',
    catalogId: `hg38:${containers.join('/')}/${shortLabel}`,
    track: track ?? `${containers.join('_')}_${shortLabel}`.replace(/\s+/g, ''),
    shortLabel,
    longLabel: `${shortLabel} long`,
    scientificKind: 'transcript',
    formatId: 'bigbed',
    assembly: { ucscGenome: 'hg38', aliases: ['hg38'] },
    containerPath: containers.map((label) => ({
      track: label.replace(/\s+/g, ''),
      shortLabel: label,
      kind: 'composite' as const,
    })),
  } as UcscCatalogLeaf;
}

describe('folding the editions of one dataset into one row', () => {
  it('keeps the newest release and carries the rest', () => {
    const rows = collapseVersionFamilies([
      leaf('Basic', ['All GENCODE V36']),
      leaf('Basic', ['All GENCODE V44']),
      leaf('Basic', ['All GENCODE V40']),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.versions.map((entry) => entry.label)).toEqual(['V44', 'V40', 'V36']);
    expect(rows[0]?.track.catalogId).toContain('V44');
  });

  it('strips the release from the breadcrumb, since the row now names it', () => {
    const [row] = collapseVersionFamilies([leaf('Basic', ['All GENCODE V44'])]);
    expect(row?.context).toEqual(['All GENCODE']);
  });

  it('keeps different tracks apart even inside the same release folders', () => {
    const rows = collapseVersionFamilies([
      leaf('Basic', ['All GENCODE V36']),
      leaf('Pseudogenes', ['All GENCODE V36']),
      leaf('Basic', ['All GENCODE V44']),
      leaf('Pseudogenes', ['All GENCODE V44']),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.track.shortLabel)).toEqual(['Basic', 'Pseudogenes']);
    expect(rows.every((row) => row.versions.length === 2)).toBe(true);
  });

  it('reads a release off the track name too, not only off a folder', () => {
    const rows = collapseVersionFamilies([leaf('Transcript LoF v2'), leaf('Transcript LoF v4.1')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.track.shortLabel).toBe('Transcript LoF v4.1');
    expect(rows[0]?.versions.map((entry) => entry.label)).toEqual(['v4.1', 'v2']);
  });

  it('orders releases by number, so V9 does not beat V44', () => {
    const rows = collapseVersionFamilies([
      leaf('Basic', ['All GENCODE V9']),
      leaf('Basic', ['All GENCODE V44']),
    ]);
    expect(rows[0]?.versions.map((entry) => entry.label)).toEqual(['V44', 'V9']);
  });

  it('understands the Ensembl form UCSC uses on its oldest release', () => {
    const rows = collapseVersionFamilies([
      leaf('Basic', ['GENCODE V20 (Ensembl 76)']),
      leaf('Basic', ['GENCODE V24 (Ensembl 83)']),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.versions).toHaveLength(2);
  });

  it('leaves a track with no release exactly where it was', () => {
    const rows = collapseVersionFamilies([
      leaf('Genscan Genes'),
      leaf('Basic', ['All GENCODE V44']),
      leaf('AUGUSTUS'),
    ]);
    expect(rows.map((row) => row.track.shortLabel)).toEqual(['Genscan Genes', 'Basic', 'AUGUSTUS']);
    expect(rows[0]?.versions).toHaveLength(1);
  });

  it('puts a family where its first member was, so ranking still decides', () => {
    const rows = collapseVersionFamilies([
      leaf('AUGUSTUS'),
      leaf('Basic', ['All GENCODE V36']),
      leaf('Genscan Genes'),
      leaf('Basic', ['All GENCODE V44']),
    ]);
    expect(rows.map((row) => row.track.shortLabel)).toEqual(['AUGUSTUS', 'Basic', 'Genscan Genes']);
  });

  it('does not fold two different kinds of data that share a name', () => {
    const signal = { ...leaf('Basic', ['All GENCODE V36']), scientificKind: 'quantitative' };
    const rows = collapseVersionFamilies([
      signal as UcscCatalogLeaf,
      leaf('Basic', ['All GENCODE V44']),
    ]);
    expect(rows).toHaveLength(2);
  });
  it('folds a release UCSC records only in the table name', () => {
    const rows = collapseVersionFamilies([
      leaf('Basic', ['GENCODE'], 'wgEncodeGencodeBasicV20'),
      leaf('Basic', ['All GENCODE V50'], 'wgEncodeGencodeBasicV50'),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.track.track).toBe('wgEncodeGencodeBasicV50');
    expect(rows[0]?.versions.map((entry) => entry.label)).toEqual(['V50', 'V20']);
  });

  it('folds across folders, because UCSC moved the old releases into another', () => {
    const rows = collapseVersionFamilies([
      leaf('Comprehensive', ['GENCODE', 'Genes'], 'wgEncodeGencodeCompV20'),
      leaf('Comprehensive', ['All GENCODE V50', 'Genes'], 'wgEncodeGencodeCompV50'),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.context).toEqual(['All GENCODE', 'Genes']);
  });

  it('will not strip a release off a name too short to survive it', () => {
    const rows = collapseVersionFamilies([
      leaf('HIV pol', [], 'hiv1'),
      leaf('HIV env', [], 'hiv2'),
    ]);
    expect(rows).toHaveLength(2);
  });

  it('keeps two hubs apart when they publish the same table name', () => {
    const a = { ...leaf('Basic', [], 'gencodeV40'), hubUrl: 'https://a.example/hub.txt' };
    const b = { ...leaf('Basic', [], 'gencodeV41'), hubUrl: 'https://b.example/hub.txt' };
    expect(collapseVersionFamilies([a as UcscCatalogLeaf, b as UcscCatalogLeaf])).toHaveLength(2);
  });
});
