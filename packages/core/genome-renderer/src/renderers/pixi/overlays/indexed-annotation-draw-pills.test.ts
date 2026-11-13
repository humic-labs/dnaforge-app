import { describe, expect, it } from 'vitest';
import type { Graphics, Text } from 'pixi.js';
import type { Feature } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import {
  drawLanePillShell,
  drawPillSeparator,
  pushPillHit,
  type PillDrawHost,
} from './indexed-annotation-draw-pills';

type DrawOp =
  | { op: 'poly'; pts: number[] }
  | { op: 'fill'; style: { color: number; alpha: number } }
  | { op: 'roundRect'; x: number; y: number; width: number; height: number; radius: number }
  | { op: 'strokeStyle'; style: unknown }
  | { op: 'moveTo'; x: number; y: number }
  | { op: 'lineTo'; x: number; y: number }
  | { op: 'stroke' };

function recordingGraphics() {
  const ops: DrawOp[] = [];
  return {
    ops,
    poly(pts: number[]) {
      ops.push({ op: 'poly', pts: [...pts] });
    },
    fill(style: { color: number; alpha: number }) {
      ops.push({ op: 'fill', style });
    },
    roundRect(x: number, y: number, width: number, height: number, radius: number) {
      ops.push({ op: 'roundRect', x, y, width, height, radius });
    },
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

function linearPath(): PathMapper {
  return {
    isArcMode: false,
    pixelsPerBp: 1,
    viewStartBp: 0,
    viewEndBp: 800,
    bpLeftX: (bp: number) => bp,
    bpCenterX: (bp: number) => bp + 0.5,
    featureLabelPosAt: (bp: number, offset: number) => ({ x: bp, y: 100 + offset, angle: 0 }),
    featurePolygonAt: (startBp: number, endBp: number, offset: number, halfHeight = 7) => [
      startBp,
      100 + offset - halfHeight,
      endBp,
      100 + offset - halfHeight,
      endBp,
      100 + offset + halfHeight,
      startBp,
      100 + offset + halfHeight,
    ],
  } as PathMapper;
}

function host(): PillDrawHost {
  return {
    genomeLength: 1_000,
    acquireLabel: () => ({}) as Text,
    curvedLabels: { reset() {} } as PillDrawHost['curvedLabels'],
  };
}

function feature(): Feature {
  return {
    id: 7,
    type: 'gene',
    start: 10,
    end: 40,
    direction: 'forward',
    color: 0x3366ff,
    lane: 0,
    displayName: 'gene',
  };
}

describe('indexed annotation draw pills', () => {
  it('draws a solid linear pill as a roundRect and skips non-positive widths', () => {
    const g = recordingGraphics();
    drawLanePillShell(
      host(),
      g as unknown as Graphics,
      linearPath(),
      10,
      20,
      0,
      8,
      0,
      0x112233,
      0.8
    );
    expect(g.ops).toEqual([
      { op: 'roundRect', x: 10, y: 92, width: 20, height: 16, radius: 3 },
      { op: 'fill', style: { color: 0x112233, alpha: 0.8 } },
    ]);

    const skipped = recordingGraphics();
    drawLanePillShell(
      host(),
      skipped as unknown as Graphics,
      linearPath(),
      10,
      0,
      0,
      8,
      0,
      0x112233,
      1
    );
    expect(skipped.ops).toEqual([]);
  });

  it('records a cutout shell, a separator stroke, and a pill hit box', () => {
    const shell = recordingGraphics();
    drawLanePillShell(
      host(),
      shell as unknown as Graphics,
      linearPath(),
      10,
      40,
      0,
      8,
      3,
      0x445566,
      1
    );
    const polys = shell.ops.filter((op) => op.op === 'poly');
    const fills = shell.ops.filter((op) => op.op === 'fill');
    expect(polys.length).toBeGreaterThanOrEqual(2);
    expect(fills.length).toBe(polys.length);
    expect(polys[0]).toMatchObject({ op: 'poly' });
    expect((polys[0] as { pts: number[] }).pts.length).toBeGreaterThanOrEqual(6);

    const separator = recordingGraphics();
    drawPillSeparator(separator as unknown as Graphics, linearPath(), 10, 8, 0, 10, 1);
    expect(separator.ops).toEqual([
      { op: 'strokeStyle', style: { width: 1, color: 0xffffff, alpha: 0.3 } },
      { op: 'moveTo', x: 18, y: 97 },
      { op: 'lineTo', x: 18, y: 103 },
      { op: 'stroke' },
    ]);

    const hitHost = { genomeLength: 1_000, hitCache: [] as Array<Record<string, unknown>> };
    pushPillHit(hitHost, feature(), 10, 20, 0, 4, 10, 30, linearPath());
    expect(hitHost.hitCache).toEqual([
      {
        id: 7,
        start: 10,
        end: 30,
        displayName: 'gene',
        type: 'gene',
        lane: 0,
        direction: 'forward',
        pts: [10, 96, 30, 96, 30, 104, 10, 104],
        xMin: 10,
        xMax: 30,
        yMin: 96,
        yMax: 104,
      },
    ]);
  });
});
