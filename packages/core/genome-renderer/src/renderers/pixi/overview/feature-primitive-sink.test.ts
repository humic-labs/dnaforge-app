import { describe, expect, it } from 'vitest';
import { GraphicsPrimitiveSink } from './feature-primitive-sink';

type Op =
  | { op: 'poly'; pts: number[] }
  | { op: 'fill'; style: unknown }
  | { op: 'setStrokeStyle'; style: unknown }
  | { op: 'stroke' };

function fakeGraphics() {
  const ops: Op[] = [];
  const g = {
    poly(pts: number[]) {
      ops.push({ op: 'poly', pts });
      return g;
    },
    fill(style: unknown) {
      ops.push({ op: 'fill', style });
      return g;
    },
    setStrokeStyle(style: unknown) {
      ops.push({ op: 'setStrokeStyle', style });
      return g;
    },
    stroke() {
      ops.push({ op: 'stroke' });
      return g;
    },
  };
  return { g, ops };
}

const fakePath = { scaleStroke: (w: number) => w * 2 } as unknown as Parameters<typeof makeSink>[1];

function makeSink(g: unknown, path: unknown) {
  return new GraphicsPrimitiveSink(
    g as ConstructorParameters<typeof GraphicsPrimitiveSink>[0],
    path as ConstructorParameters<typeof GraphicsPrimitiveSink>[1]
  );
}

describe('GraphicsPrimitiveSink', () => {
  it('fillPoly emits poly then fill, in that order, with the exact fill style', () => {
    const { g, ops } = fakeGraphics();
    makeSink(g, fakePath).fillPoly([0, 0, 10, 0, 10, 5], 0x336699, 0.85);
    expect(ops).toEqual([
      { op: 'poly', pts: [0, 0, 10, 0, 10, 5] },
      { op: 'fill', style: { color: 0x336699, alpha: 0.85 } },
    ]);
  });

  it('strokePoly emits poly → setStrokeStyle → stroke, applying path.scaleStroke to width', () => {
    const { g, ops } = fakeGraphics();
    makeSink(g, fakePath).strokePoly([1, 2, 3, 4, 5, 6], 0xff0000, 0.9, 1.5);
    expect(ops).toEqual([
      { op: 'poly', pts: [1, 2, 3, 4, 5, 6] },
      { op: 'setStrokeStyle', style: { width: 3, color: 0xff0000, alpha: 0.9 } },
      { op: 'stroke' },
    ]);
  });

  it('strokePoly defaults width to 1.5 (matching strokeCurrentPath)', () => {
    const { g, ops } = fakeGraphics();
    makeSink(g, fakePath).strokePoly([0, 0, 1, 1, 2, 2], 0x000000, 1);
    expect(ops[1]).toEqual({
      op: 'setStrokeStyle',
      style: { width: 3, color: 0x000000, alpha: 1 },
    });
  });
});
