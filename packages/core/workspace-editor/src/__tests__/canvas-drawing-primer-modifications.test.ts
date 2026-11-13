// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render1DPrimers } from '../primer-1d-render';
import { drawPrimers } from '../canvas-drawing';
import { getCanvasTheme } from '../canvas-theme';
import { PRIMER_COLORS } from '../canvas-constants';
import { DEFAULT_EDITOR_CONFIG, type PrimerDisplay } from '../types';
import {
  getRecordingLog,
  installRecordingCanvas,
  uninstallRecordingCanvas,
  type CanvasOp,
} from '../testing/recording-canvas-context';

function renderModifiedPrimer(
  direction: 'forward' | 'reverse',
  markerIndices?: number[]
): CanvasOp[] {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const primer: PrimerDisplay = {
    id: `modified-${direction}`,
    name: 'Modified primer',
    start: 10,
    end: 14,
    direction,
    bases: 'ACGT',
    tm: 60,
    gc: 50,
    modificationMarkers: [
      {
        token: '/5Phos/',
        label: '5′ phosphorylation',
        placement: 'five-prime',
        behavior: 'terminal-attachment',
        anchor: { kind: 'terminus', end: 'five-prime' },
      },
      {
        token: '/iSp18/',
        label: 'Internal Spacer 18',
        placement: 'internal',
        behavior: 'between-bases',
        anchor: { kind: 'between-bases', offset: 2 },
      },
      {
        token: '/3InvdT/',
        label: '3′ Inverted dT',
        placement: 'three-prime',
        behavior: 'modified-base',
        anchor: { kind: 'base', index: 3 },
      },
    ],
  };
  if (markerIndices) {
    primer.modificationMarkers = primer.modificationMarkers?.filter((_, index) =>
      markerIndices.includes(index)
    );
  }

  render1DPrimers({
    ctx,
    primers: [primer],
    showPrimers: true,
    columnCount: 50,
    pxPerBase: 12,
    isCircular: false,
    sharedConfig: { ...DEFAULT_EDITOR_CONFIG, charWidth: 12, fontSize: 12 },
    forwardPrimerLaneCount: direction === 'forward' ? 1 : 0,
    forwardPrimerBandTop: 40,
    reversePrimerLaneCount: direction === 'reverse' ? 1 : 0,
    reversePrimerBandTop: 80,
    scrollLeft: 0,
    cssWidth: 1000,
  });
  return getRecordingLog(canvas);
}

const markerTextOps = (log: CanvasOp[]) =>
  log.filter(
    (operation): operation is Extract<CanvasOp, { op: 'fillText' }> =>
      operation.op === 'fillText' && operation.text.startsWith('/')
  );

function markerRects(log: CanvasOp[]) {
  let fillStyle: unknown;
  return log.filter((operation): operation is Extract<CanvasOp, { op: 'fillRect' }> => {
    if (operation.op === 'set' && operation.prop === 'fillStyle') fillStyle = operation.value;
    return operation.op === 'fillRect' && fillStyle === getCanvasTheme().accent;
  });
}

describe('attached primer modification markers', () => {
  beforeEach(() => installRecordingCanvas());
  afterEach(() => uninstallRecordingCanvas());

  it('marks modifications within one base column without shifting the canonical bases', () => {
    const log = renderModifiedPrimer('forward');
    const marks = markerRects(log);
    expect(marks).toHaveLength(3);
    for (const mark of marks) expect(mark.w).toBeLessThanOrEqual(12);
    expect(markerTextOps(log)).toEqual([]);
    const bases = log.filter(
      (op): op is Extract<CanvasOp, { op: 'fillText' }> =>
        op.op === 'fillText' && /^[ACGT]$/.test(op.text)
    );
    expect(bases.map((base) => base.text)).toEqual(['A', 'C', 'G', 'T']);
    expect(bases.map((base) => base.x - bases[0].x)).toEqual([0, 12, 24, 36]);
    expect(marks.map((mark) => mark.x + mark.w / 2 - (bases[0].x - 6))).toEqual([0, 24, 42]);
  });

  it('maps oligo 5′ and 3′ anchors in the opposite visual direction for reverse primers', () => {
    const forwardFive = markerRects(renderModifiedPrimer('forward', [0]))[0];
    const forwardThree = markerRects(renderModifiedPrimer('forward', [2]))[0];
    const reverseFive = markerRects(renderModifiedPrimer('reverse', [0]))[0];
    const reverseThree = markerRects(renderModifiedPrimer('reverse', [2]))[0];
    expect(forwardFive.x).toBeLessThan(forwardThree.x);
    expect(reverseFive.x).toBeGreaterThan(reverseThree.x);
    expect(reverseFive.w).toBeLessThanOrEqual(12);
    expect(reverseThree.w).toBeLessThanOrEqual(12);
  });

  it('draws a bond marker only once when its anchor falls on a wrapped-line boundary', () => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    const primer: PrimerDisplay = {
      id: 'wrapped-modified-primer',
      name: 'Wrapped modified primer',
      start: 10,
      end: 14,
      direction: 'forward',
      bases: 'ACGT',
      tm: 60,
      gc: 50,
      modificationMarkers: [
        {
          token: '/iSp18/',
          label: 'Internal Spacer 18',
          placement: 'internal',
          behavior: 'between-bases',
          anchor: { kind: 'between-bases', offset: 2 },
        },
      ],
    };
    const config = { ...DEFAULT_EDITOR_CONFIG, charWidth: 12, fontSize: 12 };

    drawPrimers(ctx, [primer], 10, 12, 0, 40, config, 'forward', 'above', 50);
    drawPrimers(ctx, [primer], 12, 14, 0, 80, config, 'forward', 'above', 50);

    expect(markerRects(getRecordingLog(canvas))).toHaveLength(1);
    expect(markerTextOps(getRecordingLog(canvas))).toEqual([]);
  });

  it('uses the subtle ambiguity color for degenerate IUPAC bases', () => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    const primer: PrimerDisplay = {
      id: 'degenerate-primer',
      name: 'Degenerate primer',
      start: 10,
      end: 14,
      direction: 'forward',
      bases: 'ARYT',
      tm: 60,
      gc: 50,
    };

    render1DPrimers({
      ctx,
      primers: [primer],
      showPrimers: true,
      columnCount: 50,
      pxPerBase: 12,
      isCircular: false,
      sharedConfig: { ...DEFAULT_EDITOR_CONFIG, charWidth: 12, fontSize: 12 },
      forwardPrimerLaneCount: 1,
      forwardPrimerBandTop: 40,
      reversePrimerLaneCount: 0,
      reversePrimerBandTop: 80,
      scrollLeft: 0,
      cssWidth: 1000,
    });

    const log = getRecordingLog(canvas);
    expect(
      log.filter(
        (operation): operation is Extract<CanvasOp, { op: 'fillText' }> =>
          operation.op === 'fillText' && (operation.text === 'R' || operation.text === 'Y')
      )
    ).toHaveLength(2);
    expect(log).toContainEqual({
      op: 'set',
      prop: 'fillStyle',
      value: PRIMER_COLORS.DEGENERATE_BASE_LIGHT,
    });
  });
});
