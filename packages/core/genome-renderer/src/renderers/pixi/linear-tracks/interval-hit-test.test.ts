import { describe, expect, it } from 'vitest';

import { hitTestIntervalTrack } from './interval-hit-test';
import type { AnnotationLaneAssignment } from './annotation-track-draw-ops';
import type { TrackHoverArgs } from './types';

const ROW_HEIGHT = 20;
const VIEW_WIDTH = 1000;
const VIEW_START = 1000;

function pointer(localX: number, localY: number): TrackHoverArgs {
  return {
    container: {} as TrackHoverArgs['container'],
    localX,
    localY,
    viewportWidthPx: VIEW_WIDTH,
    layoutEntry: { height: ROW_HEIGHT * 3 } as TrackHoverArgs['layoutEntry'],
    pathMapper: {
      pixelsPerBp: 1,
      bpLeftX: (bp: number) => bp - VIEW_START,
    } as TrackHoverArgs['pathMapper'],
    viewportBpRange: { start: VIEW_START, end: VIEW_START + VIEW_WIDTH },
    chromosome: { id: 'chr1' } as TrackHoverArgs['chromosome'],
  };
}

function lanes(values: ReadonlyArray<number>): AnnotationLaneAssignment {
  return {
    lanes: Int16Array.from(values),
    numLanes: Math.max(...values, -1) + 1,
    droppedCount: values.filter((lane) => lane < 0).length,
  };
}

describe('clicking an imported interval', () => {
  const records = [
    { start: 1100, end: 1200, name: 'first' },
    { start: 1300, end: 1400, name: 'second' },
    { start: 1150, end: 1250, name: 'overlapping, second lane' },
  ];
  const assignment = lanes([0, 0, 1]);

  it('selects the interval under the pointer, without moving the view', () => {
    const hit = hitTestIntervalTrack({
      pointer: pointer(150, 5),
      records,
      assignment,
      rowHeightPx: ROW_HEIGHT,
      nameOf: (record) => record.name,
    });
    expect(hit).toEqual({
      kind: 'select-bp-range',
      startBp: 1100,
      endBp: 1200,
      chromosomeId: 'chr1',
      name: 'first',
    });
  });

  it('reads the lane off the pointer height, not just the base', () => {
    const first = hitTestIntervalTrack({
      pointer: pointer(180, 5),
      records,
      assignment,
      rowHeightPx: ROW_HEIGHT,
    });
    const second = hitTestIntervalTrack({
      pointer: pointer(180, 25),
      records,
      assignment,
      rowHeightPx: ROW_HEIGHT,
    });
    expect(first).toMatchObject({ startBp: 1100, endBp: 1200 });
    expect(second).toMatchObject({ startBp: 1150, endBp: 1250 });
  });

  it('returns nothing for a click on empty track, which changes no selection', () => {
    expect(
      hitTestIntervalTrack({
        pointer: pointer(280, 5),
        records,
        assignment,
        rowHeightPx: ROW_HEIGHT,
      })
    ).toBeNull();
  });

  it('returns nothing below the last lane in use', () => {
    expect(
      hitTestIntervalTrack({
        pointer: pointer(150, 45),
        records,
        assignment,
        rowHeightPx: ROW_HEIGHT,
      })
    ).toBeNull();
  });

  it('prefers the narrowest match, so a click inside a small interval is not the big one', () => {
    const nested = [
      { start: 1000, end: 1900, name: 'gene' },
      { start: 1400, end: 1440, name: 'exon' },
    ];
    const hit = hitTestIntervalTrack({
      pointer: pointer(420, 5),
      records: nested,
      assignment: lanes([0, 0]),
      rowHeightPx: ROW_HEIGHT,
      nameOf: (record) => record.name,
    });
    expect(hit).toMatchObject({ name: 'exon', startBp: 1400, endBp: 1440 });
  });

  it('leaves out the name when a record has none', () => {
    const hit = hitTestIntervalTrack({
      pointer: pointer(150, 5),
      records: [{ start: 1100, end: 1200 }],
      assignment: lanes([0]),
      rowHeightPx: ROW_HEIGHT,
    });
    expect(hit).toEqual({
      kind: 'select-bp-range',
      startBp: 1100,
      endBp: 1200,
      chromosomeId: 'chr1',
    });
  });

  it('has nothing to say about a track with no records', () => {
    expect(
      hitTestIntervalTrack({
        pointer: pointer(150, 5),
        records: [],
        assignment: lanes([]),
        rowHeightPx: ROW_HEIGHT,
      })
    ).toBeNull();
  });
});

describe('clicking where the track only shows a summary', () => {
  it('selects nothing, because a density bar is a count and not a feature', () => {
    const hit = hitTestIntervalTrack({
      pointer: pointer(150, 5),
      records: [{ start: 1100, end: 1200, extra: { dnaforgeDensity: 14 } }],
      assignment: lanes([0]),
      rowHeightPx: ROW_HEIGHT,
    });
    expect(hit).toBeNull();
  });

  it('still finds a real interval sharing the lane with a summary bar', () => {
    const hit = hitTestIntervalTrack({
      pointer: pointer(150, 5),
      records: [
        { start: 1000, end: 1900, extra: { dnaforgeDensity: 14 } },
        { start: 1100, end: 1200, name: 'real' },
      ],
      assignment: lanes([0, 0]),
      rowHeightPx: ROW_HEIGHT,
      nameOf: (record) => (record as { name?: string }).name,
    });
    expect(hit).toMatchObject({ name: 'real', startBp: 1100, endBp: 1200 });
  });
});
