import { describe, expect, it } from 'vitest';
import type { Graphics } from 'pixi.js';
import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import {
  cdsChevronEndBp,
  cdsChevronStartBp,
  drawTranscriptIntronChevrons,
} from './indexed-annotation-draw-geometry';

type StrokeOp =
  | { op: 'strokeStyle'; style: unknown }
  | { op: 'moveTo'; x: number; y: number }
  | { op: 'lineTo'; x: number; y: number }
  | { op: 'stroke' };

function recordingGraphics() {
  const ops: StrokeOp[] = [];
  return {
    ops,
    setStrokeStyle(style: unknown) {
      ops.push({ op: 'strokeStyle', style });
    },
    moveTo(x: number, y: number) {
      ops.push({ op: 'moveTo', x, y });
    },
    lineTo(x: number, y: number) {
      ops.push({ op: 'lineTo', x, y });
    },
    stroke() {
      ops.push({ op: 'stroke' });
    },
  };
}

function linearPath(overrides: { isArcMode?: boolean; pixelsPerBp?: number } = {}): PathMapper {
  const pixelsPerBp = overrides.pixelsPerBp ?? 1;
  return {
    isArcMode: overrides.isArcMode ?? false,
    pixelsPerBp,
    viewStartBp: 0,
    viewEndBp: 800,
    bpCenterX: (bp: number) => bp * pixelsPerBp,
    featureLabelPosAt: (_bp: number, offset: number) => ({ x: 0, y: 50 + offset, angle: 0 }),
  } as PathMapper;
}

function transcript(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 1,
    type: 'mRNA',
    start: 0,
    end: 400,
    direction: 'forward',
    color: 0x3366ff,
    lane: 0,
    displayName: 'tx',
    exons: [
      { start: 1, end: 40 },
      { start: 200, end: 260 },
    ],
    ...overrides,
  };
}

function state(): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 800,
    height: 400,
    themeMode: 'light',
    selectedIds: new Set(),
    hoveredId: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
}

describe('indexed annotation draw geometry', () => {
  it('shifts CDS chevron endpoints only in arc mode', () => {
    expect(cdsChevronStartBp(linearPath(), 12)).toBe(12);
    expect(cdsChevronEndBp(linearPath(), 40)).toBe(40);
    expect(cdsChevronStartBp(linearPath({ isArcMode: true }), 12)).toBe(11.5);
    expect(cdsChevronEndBp(linearPath({ isArcMode: true }), 40)).toBe(39.5);
  });

  it('draws intron chevrons on a wide linear gap and no-ops arc or single-exon features', () => {
    const drawn = recordingGraphics();
    drawTranscriptIntronChevrons(
      drawn as unknown as Graphics,
      transcript(),
      linearPath(),
      state(),
      1,
      0
    );
    expect(drawn.ops.some((op) => op.op === 'stroke')).toBe(true);
    expect(drawn.ops.filter((op) => op.op === 'moveTo').length).toBeGreaterThan(0);
    const firstMove = drawn.ops.find((op) => op.op === 'moveTo') as {
      op: 'moveTo';
      x: number;
      y: number;
    };
    expect(firstMove.y).toBe(47.75);

    const skipped = recordingGraphics();
    drawTranscriptIntronChevrons(
      skipped as unknown as Graphics,
      transcript(),
      linearPath({ isArcMode: true }),
      state(),
      1,
      0
    );
    drawTranscriptIntronChevrons(
      skipped as unknown as Graphics,
      transcript({ exons: [{ start: 1, end: 40 }] }),
      linearPath(),
      state(),
      1,
      0
    );
    drawTranscriptIntronChevrons(
      skipped as unknown as Graphics,
      transcript({
        exons: [
          { start: 1, end: 10 },
          { start: 12, end: 20 },
        ],
      }),
      linearPath(),
      state(),
      1,
      0
    );
    expect(skipped.ops).toEqual([]);
  });
});
