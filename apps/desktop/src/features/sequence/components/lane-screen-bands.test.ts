// @vitest-environment node

import { describe, it, expect } from 'vitest';

import { normalizeLaneScreenBands } from './lane-screen-bands';
import { buildLaneGutterRows } from './track-gutter-rows';

const REAL_SNAPSHOT = {
  trackScreenBounds: {
    'cytoband-chr1+chr2': { topPx: 0, heightPx: 14, bottomPx: 14 },
    'pileup-1': { topPx: 444.7, heightPx: 60, bottomPx: 504.7 },
  },
  laneContract: {
    overlayLayout: {
      totalHeight: 430.7,
      offset: 14,
      annotationHeight: 352,
      strandEnvelopeTop: 366,
      strandEnvelopeBottom: 414,
      fwdStrandTop: 378,
      revStrandBottom: 402,
      rulerY: 426.7,
    },
  },
};

describe('normalizeLaneScreenBands', () => {
  it('returns empty dataBounds for null / empty input', () => {
    expect(normalizeLaneScreenBands(null)).toEqual({ dataBounds: {} });
    expect(normalizeLaneScreenBands({})).toEqual({ dataBounds: {} });
  });

  it('derives the annotation band from overlayLayout offset + annotationHeight', () => {
    const bands = normalizeLaneScreenBands(REAL_SNAPSHOT);
    expect(bands.annotation).toEqual({ topPx: 14, heightPx: 352 });
  });

  it('derives the gutter sequence band from the stable outer strand envelope', () => {
    const bands = normalizeLaneScreenBands(REAL_SNAPSHOT);
    expect(bands.sequence).toEqual({ topPx: 366, heightPx: 48 });
  });

  it('falls back to visible strand bounds for older renderer snapshots', () => {
    const bands = normalizeLaneScreenBands({
      overlayLayout: { fwdStrandTop: 378, revStrandBottom: 402 },
    });
    expect(bands.sequence).toEqual({ topPx: 378, heightPx: 24 });
  });

  it('carries the complete Reference envelope through the ruler and bottom reserve', () => {
    const bands = normalizeLaneScreenBands(REAL_SNAPSHOT);
    expect(bands.reference).toEqual({ topPx: 14, heightPx: 430.7 });
  });

  it('carries per-track-instance data bounds (cytoband + data tracks)', () => {
    const bands = normalizeLaneScreenBands(REAL_SNAPSHOT);
    expect(bands.dataBounds['pileup-1']).toEqual({ topPx: 444.7, heightPx: 60 });
    expect(bands.dataBounds['cytoband-chr1+chr2']).toEqual({ topPx: 0, heightPx: 14 });
  });

  it('keeps the normalized Reference bottom continuous with the first renderer data row', () => {
    const bands = normalizeLaneScreenBands(REAL_SNAPSHOT);
    const rows = buildLaneGutterRows({
      bands,
      annotationVisibleCount: 2,
      dataLanes: [
        {
          dataset: { trackId: 'pileup-1', label: 'HG002' },
          visible: true,
          bucket: '__legacy__',
        },
      ],
    });

    expect(rows[0].band!.topPx + rows[0].band!.heightPx).toBe(rows[1].band!.topPx);
  });

  it('reads trackScreenBounds from the top level too (not only laneContract)', () => {
    const bands = normalizeLaneScreenBands({
      trackScreenBounds: { t: { topPx: 10, heightPx: 20 } },
    });
    expect(bands.dataBounds.t).toEqual({ topPx: 10, heightPx: 20 });
  });

  it('publishes a temporary search lane only from an exact renderer receipt', () => {
    const bands = normalizeLaneScreenBands({
      annotationOverlay: {
        annotationSearchFocusResolvedTrackId: 'mRNA',
        annotationSearchFocusResolvedCanonicalIdentity: 'canonical-HBB',
        annotationSearchFocusPresentationLane: 2,
      },
    });

    expect(bands.annotationSearchFocusPresentation).toEqual({
      trackId: 'mRNA',
      canonicalIdentity: 'canonical-HBB',
      lane: 2,
    });
    expect(
      normalizeLaneScreenBands({
        annotationOverlay: {
          annotationSearchFocusResolvedTrackId: 'mRNA',
          annotationSearchFocusResolvedCanonicalIdentity: 'canonical-HBB',
          annotationSearchFocusPresentationLane: null,
        },
      }).annotationSearchFocusPresentation
    ).toBeUndefined();
  });

  it('drops zero-height / non-finite bounds', () => {
    const bands = normalizeLaneScreenBands({
      trackScreenBounds: {
        zero: { topPx: 5, heightPx: 0 },
        nan: { topPx: Number.NaN, heightPx: 30 },
        ok: { topPx: 5, heightPx: 30 },
      },
    });
    expect(Object.keys(bands.dataBounds)).toEqual(['ok']);
  });

  it('normalizes scrolling rows into stable content coordinates and leaves pinned rows fixed', () => {
    const bands = normalizeLaneScreenBands({
      operationOracle: { completedFrameEpoch: 11 },
      laneContract: {
        overlayLayout: {
          offset: -26,
          totalHeight: 430.7,
          annotationHeight: 352,
          fwdStrandTop: 326,
          revStrandBottom: 374,
          trackScrollTop: 40,
        },
        trackScreenBounds: {
          cytoband: { topPx: 0, heightPx: 14, scrollsVertically: false },
          pileup: { topPx: 404.7, heightPx: 60, scrollsVertically: true },
        },
      },
    });

    expect(bands.annotation).toEqual({ topPx: 14, heightPx: 352 });
    expect(bands.sequence).toEqual({ topPx: 366, heightPx: 48 });
    expect(bands.reference).toEqual({ topPx: 14, heightPx: 430.7 });
    expect(bands.dataBounds.cytoband).toEqual({ topPx: 0, heightPx: 14 });
    expect(bands.dataBounds.pileup).toEqual({ topPx: 444.7, heightPx: 60 });
  });
});
