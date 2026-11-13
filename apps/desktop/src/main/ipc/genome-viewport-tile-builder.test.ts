import { describe, expect, it } from 'vitest';

import type { GenomeFeature } from '@waypoint/genome-data';

import { buildAnnotationViewportTileFromRawFeatures } from './genome-viewport-tile-builder';

function feature(overrides: Partial<GenomeFeature>): GenomeFeature {
  return {
    chrom: 'chr11',
    source: 'test',
    type: 'exon',
    start: 0,
    end: 100,
    score: null,
    strand: '+',
    phase: null,
    attributes: {},
    raw: '',
    ...overrides,
  };
}

describe('buildAnnotationViewportTileFromRawFeatures (Phase 3 Slice 3b)', () => {
  it('returns featureModel=resolved-transcript-v2', () => {
    const payload = buildAnnotationViewportTileFromRawFeatures([]);
    expect(payload.featureModel).toBe('resolved-transcript-v2');
  });

  it('counts the raw input as sourceRecordCount', () => {
    const features = [
      feature({ type: 'mRNA', start: 100, end: 200, attributes: { ID: ['tx-1'] } }),
      feature({
        type: 'exon',
        start: 100,
        end: 150,
        attributes: { ID: ['ex-1'], Parent: ['tx-1'] },
      }),
    ];
    const payload = buildAnnotationViewportTileFromRawFeatures(features);
    expect(payload.sourceRecordCount).toBe(2);
  });

  it('surfaces unique annotation layer types from raw features', () => {
    const features = [
      feature({ type: 'mRNA', attributes: { ID: ['tx-1'] } }),
      feature({ type: 'mRNA', attributes: { ID: ['tx-2'] } }),
      feature({
        type: 'ncRNA',
        attributes: { ID: ['rna-1'], ncRNA_class: ['lncRNA'] },
      }),
    ];
    const payload = buildAnnotationViewportTileFromRawFeatures(features);
    expect(payload.layerTypes).toEqual(['lncRNA', 'mRNA']);
  });

  it('resolves transcripts: an mRNA with child exons emits as a single transcript-shaped row', () => {
    const features = [
      feature({
        type: 'mRNA',
        start: 1000,
        end: 2000,
        attributes: { ID: ['tx-1'], Name: ['GENE-A'] },
      }),
      feature({
        type: 'exon',
        start: 1000,
        end: 1300,
        attributes: { ID: ['ex-1'], Parent: ['tx-1'] },
      }),
      feature({
        type: 'exon',
        start: 1500,
        end: 1800,
        attributes: { ID: ['ex-2'], Parent: ['tx-1'] },
      }),
      feature({
        type: 'CDS',
        start: 1100,
        end: 1300,
        attributes: { ID: ['cds-1'], Parent: ['tx-1'] },
      }),
    ];
    const payload = buildAnnotationViewportTileFromRawFeatures(features);

    const mRnaRows = payload.features.filter((f) => f.type === 'mRNA') as Array<
      GenomeFeature & {
        exons?: Array<{ start: number; end: number }>;
        cds?: Array<{ start: number; end: number }>;
      }
    >;
    expect(mRnaRows.length).toBe(1);
    expect(mRnaRows[0].exons?.length).toBeGreaterThanOrEqual(2);
    expect(mRnaRows[0].cds?.length).toBeGreaterThanOrEqual(1);
  });

  it('marks orphan-parent children when the parent is missing from the window', () => {
    const features = [
      feature({
        type: 'exon',
        start: 100,
        end: 200,
        attributes: { ID: ['ex-1'], Parent: ['tx-far'] },
      }),
    ];
    const payload = buildAnnotationViewportTileFromRawFeatures(features);
    expect(payload.unresolvedParentCount).toBe(1);
    expect(features[0].attributes._unresolvedParentId).toEqual(['tx-far']);
  });

  it('honors rescuedParentIds: if the caller fetched a wider window, no marker', () => {
    const features = [
      feature({
        type: 'exon',
        start: 100,
        end: 200,
        attributes: { ID: ['ex-1'], Parent: ['tx-rescued'] },
      }),
    ];
    const payload = buildAnnotationViewportTileFromRawFeatures(features, {
      rescuedParentIds: new Set(['tx-rescued']),
    });
    expect(payload.unresolvedParentCount).toBe(0);
    expect(features[0].attributes._unresolvedParentId).toBeUndefined();
  });

  it('unresolvedParentCount is zero when every Parent= is in-window', () => {
    const features = [
      feature({
        type: 'mRNA',
        start: 100,
        end: 200,
        attributes: { ID: ['tx-1'] },
      }),
      feature({
        type: 'exon',
        start: 100,
        end: 150,
        attributes: { ID: ['ex-1'], Parent: ['tx-1'] },
      }),
    ];
    const payload = buildAnnotationViewportTileFromRawFeatures(features);
    expect(payload.unresolvedParentCount).toBe(0);
  });
});
