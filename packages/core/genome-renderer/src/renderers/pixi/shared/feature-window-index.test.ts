import { describe, expect, it } from 'vitest';
import type { Feature } from '../../../types';
import { FeatureWindowIndex } from './feature-window-index';
import { StadiumPathMapper } from './path-mapper';
import { getStadiumDimensions } from '../../../geometry/stadium';

function feature(id: number, start: number, end: number): Feature {
  return {
    id,
    type: 'gene',
    start,
    end,
    direction: 'none',
    displayName: `feature-${id}`,
    color: 0x22c55e,
    lane: 0,
  };
}

function pathWindow(params: {
  start: number;
  end: number;
  pixelsPerBp?: number;
  sequenceVisible?: boolean;
}) {
  return {
    isArcMode: true,
    sequenceVisible: params.sequenceVisible ?? true,
    viewStartBp: params.start,
    viewEndBp: params.end,
    pixelsPerBp: params.pixelsPerBp ?? 1.6,
  };
}

describe('FeatureWindowIndex', () => {
  it('returns only sequence-viewport candidates while preserving feature order', () => {
    const features = [
      feature(1, 10, 80),
      feature(2, 50_200, 50_700),
      feature(3, 99_850, 200),
      feature(4, 75_000, 76_000),
      feature(5, 51_000, 51_400),
    ];
    const index = new FeatureWindowIndex({ genomeLength: 100_000, circular: true, features });

    const candidates = index.candidatesForPath(pathWindow({ start: 49_800, end: 51_200 }));

    expect(candidates.map((candidate) => candidate.id)).toEqual([2, 5]);
  });

  it('includes origin-wrapping features when the circular viewport crosses zero', () => {
    const features = [
      feature(1, 10_000, 10_800),
      feature(2, 98_800, 600),
      feature(3, 50_000, 51_000),
    ];
    const index = new FeatureWindowIndex({ genomeLength: 100_000, circular: true, features });

    const candidates = index.candidatesForPath(pathWindow({ start: 99_300, end: 100_700 }));

    expect(candidates.map((candidate) => candidate.id)).toEqual([2]);
  });

  it('does not narrow feature-LOD or non-arc paths', () => {
    const features = [feature(1, 10, 80), feature(2, 50_000, 51_000)];
    const index = new FeatureWindowIndex({ genomeLength: 100_000, circular: true, features });

    expect(
      index.candidatesForPath(pathWindow({ start: 50_000, end: 51_000, sequenceVisible: false }))
    ).toBe(features);
    expect(
      index
        .candidatesForPath(
          pathWindow({ start: 50_000, end: 51_000, sequenceVisible: false }),
          features,
          64,
          { forceWindowing: true }
        )
        .map((candidate) => candidate.id)
    ).toEqual([2]);
    expect(
      index.candidatesForPath({
        ...pathWindow({ start: 50_000, end: 51_000 }),
        isArcMode: false,
      })
    ).toBe(features);
  });

  it('uses the stadium nucleotide viewport window rather than the raw viewOffset neighborhood', () => {
    const genomeLength = 1_000_000;
    const viewportWidth = 1200;
    const geometryHeight = 240;
    const viewOffset = 0.1;
    const zoom = 5000;
    const dims = getStadiumDimensions(viewportWidth, geometryHeight, 0, 0);
    const topCameraPinFrac = dims.straightLength / dims.totalLength / 2;
    const rawCenterBp = Math.round(viewOffset * genomeLength);
    const visibleCenterBp = Math.round(
      ((((topCameraPinFrac + viewOffset) % 1) + 1) % 1) * genomeLength
    );
    const features = [
      feature(1, rawCenterBp - 30, rawCenterBp + 30),
      feature(2, visibleCenterBp - 30, visibleCenterBp + 30),
    ];
    const index = new FeatureWindowIndex({ genomeLength, circular: true, features });
    const path = new StadiumPathMapper({
      genomeLength,
      viewOffset,
      zoom,
      dims,
      ox: viewportWidth / 2 - dims.width / 2,
      oy: geometryHeight / 2 - dims.height / 2,
      stagePosX: 0,
      stagePosY: 0,
      bpPerPixel: genomeLength / (dims.totalLength * zoom),
      hasSequence: true,
      viewportWidth,
      viewportHeight: geometryHeight,
      geometryHeight,
    });

    const candidates = index.candidatesForPath(path);

    expect(candidates.map((candidate) => candidate.id)).toEqual([2]);
  });
});
