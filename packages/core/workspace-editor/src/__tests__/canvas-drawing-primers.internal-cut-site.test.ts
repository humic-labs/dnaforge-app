// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GOLDEN_GATE_JUNCTION_VISUAL } from '@waypoint/sequence-utils';
import { drawPrimers } from '../canvas-drawing-primers';
import { drawAllGGScarBackgrounds } from '../canvas-drawing-restriction';
import { render1DPrimers } from '../primer-1d-render';
import {
  DEFAULT_EDITOR_CONFIG,
  type LinePositions,
  type PrimerDisplay,
  type RenderedGGProductLabel,
} from '../types';
import { getCanvasTheme } from '../canvas-theme';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
  getRecordingLog,
  type CanvasOp,
} from '../testing/recording-canvas-context';

function scarMarker(overrides: Partial<PrimerDisplay> = {}): PrimerDisplay {
  return {
    id: 'scar-1',
    name: 'BsaI',
    start: 10,
    end: 16,
    direction: 'forward',
    bases: 'GGTCTC',
    tm: 0,
    gc: 0,
    mismatches: [],
    overhangLength: 4,
    pbsColor: 'transparent',
    overhangColor: 'transparent',
    cutPositionInOverhang: 1,
    enzymeName: 'BsaI',
    scarAbsolutePosition: 10,
    isScarMarkerOnly: true,
    ...overrides,
  };
}

function reversePrimer(id: string, start: number, end: number): PrimerDisplay {
  return {
    id,
    name: id,
    start,
    end,
    direction: 'reverse',
    bases: 'A'.repeat(Math.max(1, end - start)),
    tm: 60,
    gc: 50,
    mismatches: [],
  };
}

function goldenGatePrimer(): PrimerDisplay {
  return {
    id: 'gg-primer-1',
    name: 'Golden Gate primer',
    start: 10,
    end: 24,
    direction: 'forward',
    bases: 'GGTCTCAATGAAAA',
    tm: 60,
    gc: 50,
    mismatches: [],
    overhangLength: 10,
    cutPositionInOverhang: 6,
    enzymeName: 'BsaI',
    junctionIndex: 0,
  };
}

function draw(primer: PrimerDisplay, extra: PrimerDisplay[] = []): CanvasOp[] {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  render1DPrimers({
    ctx,
    primers: [primer, ...extra],
    showPrimers: true,
    columnCount: 50,
    pxPerBase: 12,
    isCircular: false,
    sharedConfig: DEFAULT_EDITOR_CONFIG,
    forwardPrimerLaneCount: 1,
    forwardPrimerBandTop: 40,
    reversePrimerLaneCount: 2,
    reversePrimerBandTop: 80,
    scrollLeft: 0,
    cssWidth: 1000,
    hoveredPrimerId: null,
  });
  return getRecordingLog(canvas);
}

function drawWrapped2D(primer: PrimerDisplay): CanvasOp[] {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Expected a 2D recording context.');
  drawPrimers(
    ctx,
    [primer],
    0,
    50,
    0,
    40,
    { ...DEFAULT_EDITOR_CONFIG, charWidth: 12 },
    'forward',
    'above',
    50,
    new Map(),
    0,
    []
  );
  return getRecordingLog(canvas);
}

const strokeColors = (log: CanvasOp[]): unknown[] =>
  log
    .filter((o) => o.op === 'set' && o.prop === 'strokeStyle')
    .map((o) => (o as { value: unknown }).value);
const texts = (log: CanvasOp[]): string[] =>
  log
    .filter((o): o is Extract<CanvasOp, { op: 'fillText' }> => o.op === 'fillText')
    .map((o) => o.text);
const fillColors = (log: CanvasOp[]): unknown[] =>
  log
    .filter((o): o is Extract<CanvasOp, { op: 'set' }> => o.op === 'set' && o.prop === 'fillStyle')
    .map((o) => o.value);

describe('GoldenGate scar marker primitive  #10)', () => {
  beforeEach(() => installRecordingCanvas());
  afterEach(() => uninstallRecordingCanvas());

  it('retains primer letter case in the preview and wrapping canvas', () => {
    const primer: PrimerDisplay = {
      id: 'mixed-case',
      name: 'mixed-case',
      start: 10,
      end: 16,
      direction: 'forward',
      bases: 'aCgTrY',
      tm: 60,
      gc: 50,
    };
    for (const log of [draw(primer), drawWrapped2D(primer)]) {
      expect(
        texts(log)
          .filter((text) => text.length === 1)
          .join('')
      ).toBe(primer.bases);
    }
  });

  it('does NOT special-case internal sites — the scar UI never renders red or a ! badge', () => {
    const theme = getCanvasTheme();
    const log = draw(scarMarker({ isInternalCutSite: true }));

    expect(texts(log)).not.toContain('!');
    expect(strokeColors(log)).toContain(theme.fg);
    expect(strokeColors(log)).not.toContain(theme.error);
  });

  it('offsets the GG scar label below the FULL reverse-primer band, scaling with lanes  carried-over)', () => {
    const scarLabelY = (reverses: PrimerDisplay[]): number => {
      const log = draw(scarMarker({ isInternalCutSite: false }), reverses);
      const label = log.find(
        (o): o is Extract<CanvasOp, { op: 'fillText' }> => o.op === 'fillText' && o.text === 'BsaI'
      );
      if (!label) throw new Error('scar label not drawn');
      return label.y;
    };
    const oneLane = scarLabelY([reversePrimer('r1', 4, 26)]);
    const twoLanes = scarLabelY([reversePrimer('r1', 4, 26), reversePrimer('r2', 8, 30)]);
    expect(twoLanes).toBeGreaterThan(oneLane);
  });

  it('leaves a normal junction scar marker black with no ! badge', () => {
    const theme = getCanvasTheme();
    const log = draw(scarMarker({ isInternalCutSite: false, junctionIndex: 0 }));

    expect(texts(log)).not.toContain('!');
    expect(strokeColors(log)).toContain(theme.fg);
    expect(strokeColors(log)).not.toContain(theme.error);
  });

  it('uses the shared junction contract for the red scar bases and white identity label', () => {
    const log = drawWrapped2D(goldenGatePrimer());

    expect(texts(log)).toContain('BsaI J1');
    expect(fillColors(log)).toContain(GOLDEN_GATE_JUNCTION_VISUAL.primer.scarBaseColorHex);
    expect(fillColors(log)).toContain(GOLDEN_GATE_JUNCTION_VISUAL.identityLabel.lightBackgroundCss);
  });

  it('uses the shared junction contract for the orange product-base highlight', () => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Expected a 2D recording context.');
    const linePositions = [
      {
        line: {
          lineIndex: 0,
          startPos: 0,
          endPos: 20,
          sequence: 'A'.repeat(20),
          complementSequence: 'T'.repeat(20),
          y: 0,
          annotations: [],
          annotationLaneCount: 0,
          translationLaneCount: 0,
        },
        annotationY: 0,
        translationY: 0,
        translationLaneCount: 0,
        sequenceY: 20,
        complementY: 40,
        mutationTrackY: 0,
        hasMutationTrack: false,
        rulerY: 0,
        forwardPrimerY: 0,
        reversePrimerY: 0,
        lineEndY: 60,
        hasPrimers: true,
        hasForwardPrimers: true,
        hasReversePrimers: false,
        absoluteLineY: 0,
        forwardOrfY: 0,
        reverseOrfY: 0,
        forwardOrfLaneCount: 0,
        reverseOrfLaneCount: 0,
      } satisfies LinePositions,
    ];
    const labels = [
      {
        primer: scarMarker({ junctionIndex: 0 }),
        labelBounds: { x: 0, y: 0, width: 0, height: 0 },
        scarStart: 4,
        scarEnd: 8,
        lineIndex: 0,
      } satisfies RenderedGGProductLabel,
    ];

    drawAllGGScarBackgrounds(ctx, linePositions, labels, 0, DEFAULT_EDITOR_CONFIG, 20);

    expect(fillColors(getRecordingLog(canvas))).toContain(
      GOLDEN_GATE_JUNCTION_VISUAL.productScar.fillCss
    );
  });
});
