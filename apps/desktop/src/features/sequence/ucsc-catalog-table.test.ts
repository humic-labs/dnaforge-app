// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { UcscCatalogLeaf } from '@waypoint/genome-data';
import { collapseVersionFamilies } from './ucsc-catalog-versions';
import {
  collectCatalogTableColumns,
  filterCatalogTableTracks,
  sortCatalogTableRows,
} from './ucsc-catalog-table';

function leaf(track: string, extra: Partial<UcscCatalogLeaf> = {}): UcscCatalogLeaf {
  return {
    sourceKind: 'ucsc-native',
    catalogId: `hg38:${track}`,
    track,
    shortLabel: track,
    longLabel: `${track} description`,
    scientificKind: 'interval',
    formatId: 'bigbed',
    assembly: { ucscGenome: 'hg38', aliases: ['GRCh38'] },
    ...extra,
  };
}

describe('public catalog table', () => {
  it('offers all published metadata, including facts too specific for sidebar facets', () => {
    const track = leaf('sample', {
      attributes: [
        { key: 'donorId', value: 'donor-12', origin: 'metadata' },
        { key: 'cellType', value: 'brain', origin: 'subgroup' },
        { key: 'cellType', value: 'cortex', origin: 'metadata' },
        { key: 'view', value: 'signal', origin: 'subgroup' },
      ],
    });
    const columns = collectCatalogTableColumns([track]);
    const cell = columns.find((column) => column.id === 'attribute:cellType');
    expect(cell?.label).toBe('Cell type');
    expect(cell?.value(track)).toBe('brain · cortex');
    expect(columns.find((column) => column.id === 'attribute:donorId')?.value(track)).toBe(
      'donor-12'
    );
    expect(columns.some((column) => column.id === 'attribute:view')).toBe(false);
  });

  it('combines column filters and checks every word regardless of case', () => {
    const tracks = [
      leaf('one', { longLabel: 'Adult human brain H3K27ac', scientificKind: 'quantitative' }),
      leaf('two', { longLabel: 'Human heart H3K27ac', scientificKind: 'quantitative' }),
      leaf('three', { longLabel: 'Adult human brain H3K27ac' }),
    ];
    expect(
      filterCatalogTableTracks(tracks, collectCatalogTableColumns(tracks), {
        description: 'BRAIN human',
        scientificKind: 'Signal',
      }).map((track) => track.track)
    ).toEqual(['one']);
  });

  it('keeps differently spelled metadata keys distinguishable and strand optional', () => {
    const columns = collectCatalogTableColumns([
      leaf('sample', {
        attributes: [
          { key: 'cellType', value: 'brain', origin: 'subgroup' },
          { key: 'cell_type', value: 'cortex', origin: 'metadata' },
          { key: 'strand', value: 'forward', origin: 'subgroup' },
        ],
      }),
    ]);
    expect(columns.find((column) => column.id === 'attribute:cellType')?.label).toBe(
      'Cell type (cellType)'
    );
    expect(columns.find((column) => column.id === 'attribute:cell_type')?.label).toBe(
      'Cell type (cell_type)'
    );
    expect(columns.find((column) => column.id === 'attribute:strand')?.defaultVisible).toBe(false);
  });

  it('distinguishes a provider column from a metadata attribute with the same name', () => {
    const track = leaf('sgdGene', {
      attributes: [{ key: 'source', value: 'SGD', origin: 'subgroup' }],
    });
    const columns = collectCatalogTableColumns([track]);
    expect(columns.find((column) => column.id === 'source')?.label).toBe('Source (provider)');
    expect(columns.find((column) => column.id === 'attribute:source')?.label).toBe(
      'Source (metadata)'
    );
    expect(columns.find((column) => column.id === 'attribute:source')?.value(track)).toBe('SGD');
  });

  it('filters editions before folding so an older matching release stays selectable', () => {
    const tracks = [
      leaf('genesV49', { shortLabel: 'Genes V49' }),
      leaf('genesV48', { shortLabel: 'Genes V48' }),
    ];
    const filtered = filterCatalogTableTracks(tracks, collectCatalogTableColumns(tracks), {
      release: 'V48',
    });
    const rows = collapseVersionFamilies(filtered);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.track.track).toBe('genesV48');
  });

  it('sorts the whole result numerically and keeps missing metadata last in either direction', () => {
    const tracks = [
      leaf('Sample 10', { group: 'group10' }),
      leaf('Sample 2', { group: 'group2' }),
      leaf('Sample 1'),
    ];
    const rows = collapseVersionFamilies(tracks);
    const columns = collectCatalogTableColumns(tracks);
    expect(
      sortCatalogTableRows(rows, columns, { columnId: 'track', direction: 'asc' }).map(
        (row) => row.track.track
      )
    ).toEqual(['Sample 1', 'Sample 2', 'Sample 10']);
    expect(
      sortCatalogTableRows(rows, columns, { columnId: 'group', direction: 'desc' }).map(
        (row) => row.track.track
      )
    ).toEqual(['Sample 10', 'Sample 2', 'Sample 1']);
    expect(sortCatalogTableRows(rows, columns, null)).toBe(rows);
    expect(tracks.map((track) => track.track)).toEqual(['Sample 10', 'Sample 2', 'Sample 1']);
  });
});
