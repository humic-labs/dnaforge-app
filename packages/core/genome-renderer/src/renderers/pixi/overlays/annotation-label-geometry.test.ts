import { describe, expect, it } from 'vitest';
import type { Feature } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';

import {
  bestVisibleFeatureLabelPlacement,
  bestVisiblePolygonLabelCandidate,
  truncateForWidth,
  visibleCenterFromPolygon,
} from './annotation-label-geometry';

function linearPath(viewStartBp: number, viewEndBp: number): PathMapper {
  return {
    isArcMode: false,
    pixelsPerBp: 1,
    viewStartBp,
    viewEndBp,
    bpLeftX: (bp: number) => bp - viewStartBp,
    featureLabelPosAt: (bp: number, offsetPx: number) => ({
      x: bp - viewStartBp,
      y: 50 + offsetPx,
      angle: 0,
    }),
  } as PathMapper;
}

function compoundFeature(parts: 'exons' | 'segments'): Feature {
  return {
    id: 7,
    type: parts === 'exons' ? 'mRNA' : 'CDS',
    start: 99,
    end: 900,
    direction: 'forward',
    displayName: 'occupied geometry',
    color: 0x3b82f6,
    lane: 0,
    qualifiers: parts === 'segments' ? { _locationString: 'join(100..200,800..900)' } : undefined,
    [parts]: [
      { start: 100, end: 200 },
      { start: 800, end: 900 },
    ],
  } as Feature;
}

describe('annotation label geometry', () => {
  it('centers a label on the fully visible outer arc and between polygon edges', () => {
    expect(visibleCenterFromPolygon([0, 0, 100, 0, 100, 20, 0, 20], 100, 20)).toEqual({
      cx: 50,
      cy: 10,
      visibleWidth: 100,
      fraction: 0.5,
    });
  });

  it('centers on the clipped visible arc without moving toward the offscreen portion', () => {
    expect(visibleCenterFromPolygon([-50, 0, 150, 0, 150, 20, -50, 20], 100, 20)).toEqual({
      cx: 50,
      cy: 10,
      visibleWidth: 100,
      fraction: 0.5,
    });
    expect(visibleCenterFromPolygon([0, 0, 200, 0, 200, 20, 0, 20], 100, 20)).toEqual({
      cx: 50,
      cy: 10,
      visibleWidth: 100,
      fraction: 0.25,
    });
  });

  it('falls back to the polygon midpoint when no outer segment is visible', () => {
    expect(visibleCenterFromPolygon([200, 0, 300, 0, 300, 20, 200, 20], 100, 20)).toEqual({
      cx: 300,
      cy: 10,
      visibleWidth: 0,
      fraction: 1,
    });
  });

  it('selects the widest visible painted polygon instead of an offscreen larger part', () => {
    const selected = bestVisiblePolygonLabelCandidate(
      [
        [-400, 0, -100, 0, -100, 20, -400, 20],
        [20, 0, 120, 0, 120, 20, 20, 20],
      ],
      200,
      100
    );

    expect(selected).toMatchObject({
      candidateIndex: 1,
      cx: 70,
      cy: 10,
      visibleWidth: 100,
    });
  });

  it('does not manufacture a polygon label when only empty space is visible', () => {
    expect(
      bestVisiblePolygonLabelCandidate(
        [
          [-300, 0, -200, 0, -200, 20, -300, 20],
          [300, 0, 400, 0, 400, 20, 300, 20],
        ],
        100,
        100
      )
    ).toBeNull();
  });

  it.each(['exons', 'segments'] as const)(
    'anchors retained labels to a visible %s block instead of the compound feature bounds',
    (parts) => {
      const placement = bestVisibleFeatureLabelPlacement(
        compoundFeature(parts),
        linearPath(700, 1_000),
        300,
        100,
        0,
        1_000
      );

      expect(placement).toMatchObject({
        candidateIndex: 1,
        rangeStartBp: 799,
        rangeEndBp: 900,
        startBp: 799,
        widthPx: 101,
      });
    }
  );

  it.each(['exons', 'segments'] as const)(
    'suppresses retained %s labels when the viewport contains only an intron',
    (parts) => {
      expect(
        bestVisibleFeatureLabelPlacement(
          compoundFeature(parts),
          linearPath(300, 700),
          400,
          100,
          0,
          1_000
        )
      ).toBeNull();
    }
  );

  it('truncates by the existing approximate character width and caches the decision', () => {
    const cache = new Map<number, { text: string; width: number }>();

    expect(truncateForWidth('ABCDEFGHIJ', 45.5, cache, 7)).toBe('ABCDEF…');
    expect(cache.get(7)).toEqual({ text: 'ABCDEF…', width: 45.5 });
    expect(truncateForWidth('changed-name', 46, cache, 7)).toBe('ABCDEF…');
  });

  it('suppresses labels below the minimum and preserves a fitting full label', () => {
    const cache = new Map<number, { text: string; width: number }>();

    expect(truncateForWidth('ABCD', 25.9, cache, 1)).toBeNull();
    expect(truncateForWidth('ABCD', 26, cache, 1)).toBe('ABCD');
  });
});
