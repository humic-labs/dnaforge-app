// @vitest-environment node

import { describe, it, expect } from 'vitest';

import type { LaneScreenBands } from './lane-screen-bands';
import { buildLaneGutterRows, unionReferenceBand } from './track-gutter-rows';

const NO_BANDS: LaneScreenBands = { dataBounds: {} };

describe('unionReferenceBand', () => {
  it('falls back when neither band is present', () => {
    expect(unionReferenceBand(NO_BANDS)).toEqual({ topPx: 0, heightPx: 28 });
  });

  it('unions annotation + sequence into one span', () => {
    expect(
      unionReferenceBand({
        annotation: { topPx: 14, heightPx: 352 },
        sequence: { topPx: 366, heightPx: 48 },
        dataBounds: {},
      })
    ).toEqual({ topPx: 14, heightPx: 400 });
  });

  it('prefers the renderer-owned full Reference envelope over a truncated visual union', () => {
    expect(
      unionReferenceBand({
        reference: { topPx: 32, heightPx: 271.6 },
        annotation: { topPx: 32, heightPx: 192 },
        sequence: { topPx: 224, heightPx: 48 },
        dataBounds: {},
      })
    ).toEqual({ topPx: 32, heightPx: 271.6 });
  });
});

describe('buildLaneGutterRows', () => {
  it('always emits the built-in Reference row (even with no bands / no data)', () => {
    const rows = buildLaneGutterRows({
      bands: NO_BANDS,
      annotationVisibleCount: 0,
      dataLanes: [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'lane:reference',
      kind: 'reference',
      label: 'Reference',
      visible: false,
      removable: false,
      togglable: true,
    });
    expect(rows[0].band).toBeUndefined();
  });

  it('adds the chromosome strip as a pinned row aligned to its renderer band', () => {
    const rows = buildLaneGutterRows({
      bands: { dataBounds: { 'cytoband-grch38': { topPx: 0, heightPx: 32 } } },
      cytobandVisible: true,
      annotationVisibleCount: 0,
      dataLanes: [],
    });
    expect(rows[0]).toMatchObject({
      id: 'lane:cytoband',
      kind: 'cytoband',
      label: 'Chromosomes',
      visible: true,
      removable: false,
      band: { topPx: 0, heightPx: 32 },
    });
  });

  it("carries a data track's color for its hover bar", () => {
    const rows = buildLaneGutterRows({
      bands: NO_BANDS,
      annotationVisibleCount: 0,
      dataLanes: [
        {
          dataset: { trackId: 't1', label: 'Signal', color: 0x16a34a },
          visible: true,
          bucket: 'owner',
        },
      ],
    });
    expect(rows.find((row) => row.trackId === 't1')?.color).toBe('#16a34a');
  });

  it('keeps a hidden chromosome strip as an unchecked, unbanded row', () => {
    const rows = buildLaneGutterRows({
      bands: NO_BANDS,
      cytobandVisible: false,
      annotationVisibleCount: 0,
      dataLanes: [],
    });
    expect(rows.find((row) => row.id === 'lane:cytoband')).toMatchObject({
      visible: false,
      band: undefined,
    });
  });

  it('labels the Reference row with the reference name when one is given', () => {
    const rows = buildLaneGutterRows({
      bands: NO_BANDS,
      referenceLabel: 'GRCh38 (human)',
      annotationVisibleCount: 0,
      dataLanes: [],
    });
    expect(rows[0]).toMatchObject({ id: 'lane:reference', label: 'GRCh38 (human)' });
  });

  it('emits one Reference row spanning annotation + sequence (no separate Sequence row)', () => {
    const rows = buildLaneGutterRows({
      bands: {
        annotation: { topPx: 14, heightPx: 352 },
        sequence: { topPx: 366, heightPx: 48 },
        dataBounds: {},
      },
      annotationVisibleCount: 2,
      dataLanes: [],
    });
    expect(rows.map((r) => r.id)).toEqual(['lane:reference']);
    expect(rows[0]).toMatchObject({
      label: 'Reference',
      visible: true,
      band: { topPx: 14, heightPx: 400 },
    });
  });

  it('ends the Reference gutter row exactly where the next renderer track begins', () => {
    const rows = buildLaneGutterRows({
      bands: {
        reference: { topPx: 32, heightPx: 271.6 },
        annotation: { topPx: 32, heightPx: 192 },
        sequence: { topPx: 224, heightPx: 48 },
        dataBounds: { pileup: { topPx: 303.6, heightPx: 276 } },
      },
      annotationVisibleCount: 2,
      dataLanes: [
        { dataset: { trackId: 'pileup', label: 'Reads' }, visible: true, bucket: 'assembly' },
      ],
    });

    expect(rows[0].band).toEqual({ topPx: 32, heightPx: 271.6 });
    expect(rows[0].band!.topPx + rows[0].band!.heightPx).toBe(rows[1].band!.topPx);
  });

  it('dims Reference when no annotation types are visible', () => {
    const rows = buildLaneGutterRows({
      bands: { annotation: { topPx: 14, heightPx: 352 }, dataBounds: {} },
      annotationVisibleCount: 0,
      dataLanes: [],
    });
    expect(rows[0].visible).toBe(false);
  });

  it('emits data rows keyed by bucket:trackId after Reference', () => {
    const rows = buildLaneGutterRows({
      bands: {
        annotation: { topPx: 14, heightPx: 352 },
        sequence: { topPx: 366, heightPx: 48 },
        dataBounds: { 'pileup-1': { topPx: 440, heightPx: 60 } },
      },
      annotationVisibleCount: 1,
      dataLanes: [
        {
          dataset: { trackId: 'pileup-1', label: 'HG002', trackPx: 96 },
          visible: true,
          bucket: '__legacy__',
        },
      ],
    });
    expect(rows.map((r) => r.id)).toEqual(['lane:reference', '__legacy__:pileup-1']);
    expect(rows[1]).toMatchObject({
      kind: 'data',
      label: 'HG002',
      bucket: '__legacy__',
      trackId: 'pileup-1',
      requestedHeightPx: 96,
      band: { topPx: 440, heightPx: 60 },
    });
  });

  it('sorts a not-yet-painted data track (no band) last', () => {
    const rows = buildLaneGutterRows({
      bands: { annotation: { topPx: 14, heightPx: 352 }, dataBounds: {} },
      annotationVisibleCount: 1,
      dataLanes: [{ dataset: { trackId: 'new', label: 'New' }, visible: true, bucket: 'a' }],
    });
    expect(rows.map((r) => r.id)).toEqual(['lane:reference', 'a:new']);
    expect(rows[1].band).toBeUndefined();
  });
});
