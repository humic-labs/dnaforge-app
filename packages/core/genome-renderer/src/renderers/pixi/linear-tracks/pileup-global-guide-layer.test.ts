// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import type { PileupAlternateColumn } from '@waypoint/genome-data';

import type { PathMapper } from '../shared/path-types';
import { PileupGlobalGuideLayer } from './pileup-global-guide-layer';

const COLUMNS: ReadonlyArray<PileupAlternateColumn> = [
  {
    pos: 1_000,
    kind: 'sub',
    length: 1,
    refBase: 'C',
    readBase: 'T',
    coveringReadCount: 40,
    supportingReadCount: 20,
    weightedDepth: 39.5,
    weightedSupport: 19.7,
    weightedFraction: 0.499,
  },
  {
    pos: 1_020,
    kind: 'del',
    length: 3,
    refBase: 'AAA',
    coveringReadCount: 35,
    supportingReadCount: 10,
    weightedDepth: 34.7,
    weightedSupport: 9.8,
    weightedFraction: 0.282,
  },
];

function pathMapper(
  viewStartBp: number,
  { pixelsPerBp = 8, sequenceOpacity = 0.75 } = {}
): PathMapper {
  return {
    pixelsPerBp,
    sequenceOpacity,
    bpLeftX: (bp: number) => (bp - viewStartBp) * pixelsPerBp,
  } as unknown as PathMapper;
}

describe('PileupGlobalGuideLayer', () => {
  it('spans the full viewer height and keeps camera-only frames allocation-free', () => {
    const layer = new PileupGlobalGuideLayer();

    layer.paint({
      columns: COLUMNS,
      pathMapper: pathMapper(990),
      viewportStartBp: 990,
      viewportWidthPx: 800,
      viewportHeightPx: 420,
    });
    expect(layer.diagnostics()).toMatchObject({
      columnCount: 2,
      instanceCount: 2,
      buildCount: 1,
      visible: true,
      topPx: 0,
      bottomPx: 420,
    });
    expect(layer.diagnostics().alpha).toBeCloseTo(0.1);

    layer.paint({
      columns: COLUMNS,
      pathMapper: pathMapper(995),
      viewportStartBp: 995,
      viewportWidthPx: 800,
      viewportHeightPx: 420,
    });
    expect(layer.diagnostics().buildCount).toBe(1);

    layer.destroy();
  });

  it('follows the existing exact-read reveal instead of waiting for reference letters', () => {
    const layer = new PileupGlobalGuideLayer();

    layer.paint({
      columns: COLUMNS,
      pathMapper: pathMapper(990, { pixelsPerBp: 8, sequenceOpacity: 0 }),
      viewportStartBp: 990,
      viewportWidthPx: 800,
      viewportHeightPx: 420,
    });

    expect(layer.diagnostics()).toMatchObject({
      columnCount: 2,
      instanceCount: 2,
      visible: true,
      topPx: 0,
      bottomPx: 420,
    });
    expect(layer.diagnostics().alpha).toBeCloseTo(0.1);
    layer.destroy();
  });
});
