import { describe, expect, it } from 'vitest';

import {
  createUcscTrackFingerprint,
  createUcscTrackId,
  isCompleteUcscTile,
  type UcscCatalogLeaf,
  type UcscTrackSource,
  type UcscTrackTileResult,
} from './ucsc-track-source';

describe('UCSC track source contract', () => {
  const leaf: UcscCatalogLeaf = {
    sourceKind: 'ucsc-native',
    catalogId: 'ucsc:hg38:ncbiRefSeq',
    track: 'ncbiRefSeq',
    shortLabel: 'NCBI RefSeq',
    longLabel: 'NCBI RefSeq genes',
    scientificKind: 'transcript',
    formatId: 'ucsc-native',
    assembly: {
      ucscGenome: 'hg38',
      aliases: ['GRCh38', 'GCF_000001405.40'],
    },
  };

  it('uses one durable source shape for native, hub, and remote leaves', () => {
    const source: UcscTrackSource = {
      admissionVersion: 1,
      uri: 'ucsc://hg38/ncbiRefSeq',
      formatId: leaf.formatId,
      readerKind: 'ucsc-rest',
      scientificKind: leaf.scientificKind,
      assemblyId: 'GRCh38',
      referenceReceipt: {
        assemblyId: 'GRCh38',
        referenceSignature: 'grch38-reference',
        sourceSignature: 'hg38-catalog',
        contigMap: {},
        checkedContigs: 0,
        status: 'compatible',
        checkedAt: '2026-07-28T00:00:00.000Z',
      },
      provenance: {
        provider: 'ucsc',
        sourceKind: leaf.sourceKind,
        catalogId: leaf.catalogId,
        ucscGenome: leaf.assembly.ucscGenome,
        track: leaf.track,
        label: leaf.shortLabel,
      },
      fingerprint: createUcscTrackFingerprint({
        sourceKind: leaf.sourceKind,
        ucscGenome: leaf.assembly.ucscGenome,
        track: leaf.track,
      }),
    };

    expect(source.fingerprint).toBe('ucsc-native\u0000hg38\u0000ncbiRefSeq\u0000');
  });

  it('does not mistake a capped regional response for a complete tile', () => {
    const capped: UcscTrackTileResult = {
      state: 'ready',
      records: [],
      complete: false,
      itemsReturned: 100_000,
      maxItemsOutput: 100_000,
    };
    expect(isCompleteUcscTile(capped)).toBe(false);

    const ready: UcscTrackTileResult = {
      state: 'ready',
      records: [],
      complete: true,
      itemsReturned: 0,
      maxItemsOutput: 100_000,
    };
    expect(isCompleteUcscTile(ready)).toBe(true);
  });

  it('keeps native IDs readable and prevents same-name hub collisions', () => {
    expect(
      createUcscTrackId({
        sourceKind: 'ucsc-native',
        ucscGenome: 'hg38',
        track: 'knownGene',
      })
    ).toBe('ucsc:hg38-knownGene');
    const firstHub = createUcscTrackId({
      sourceKind: 'ucsc-hub',
      ucscGenome: 'hg38',
      track: 'genes',
      hubUrl: 'https://one.example/hub.txt',
    });
    const secondHub = createUcscTrackId({
      sourceKind: 'ucsc-hub',
      ucscGenome: 'hg38',
      track: 'genes',
      hubUrl: 'https://two.example/hub.txt',
    });
    expect(firstHub).toMatch(/^ucsc:hg38-genes-[a-z0-9]+$/);
    expect(secondHub).not.toBe(firstHub);
  });
});
