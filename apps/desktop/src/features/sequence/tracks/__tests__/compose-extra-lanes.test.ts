import { describe, it, expect } from 'vitest';
import type { ReferenceColumnOverlay, SequenceExtraLane } from '@waypoint/workspace-editor';
import {
  composeExtraLanes,
  RESIDUE_LINK_LANE_ID,
  buildResidueLinkLane,
} from '../SequenceTracksView';

const NOOP_DRAW = () => {};

function makeTrackLane(id: string, height = 24): SequenceExtraLane {
  return { id, height, draw: NOOP_DRAW };
}

function makeOverlay(columns: number[]): ReferenceColumnOverlay {
  return {
    id: `overlay-${columns.join('-')}`,
    target: 'sequenceBand',
    columns,
    color: '#fbbf24',
    kind: 'columnWash',
    alpha: 0.5,
  };
}

const GC = makeTrackLane('gc-content', 22);
const CHROMATOGRAM = makeTrackLane('sanger-attached-read1', 80);

describe('composeExtraLanes', () => {
  it('returns undefined when tracksMode=false and no residue overlay', () => {
    expect(composeExtraLanes(false, [], null)).toBeUndefined();
    expect(composeExtraLanes(false, [GC, CHROMATOGRAM], null)).toBeUndefined();
    expect(composeExtraLanes(false, [], [])).toBeUndefined();
  });

  it('returns undefined when tracksMode=true but trackLanes is empty AND no residue overlay', () => {
    expect(composeExtraLanes(true, [], null)).toBeUndefined();
  });

  it('returns the trackLanes when tracksMode=true and no residue overlay', () => {
    const result = composeExtraLanes(true, [GC, CHROMATOGRAM], null);
    expect(result).toEqual([GC, CHROMATOGRAM]);
  });

  it('injects the residue lane regardless of tracksMode (Slice 2 invariant)', () => {
    const overlay = makeOverlay([100, 101, 102]);
    const offResult = composeExtraLanes(false, [GC, CHROMATOGRAM], [overlay]);
    expect(offResult).toHaveLength(1);
    expect(offResult?.[0].id).toBe(RESIDUE_LINK_LANE_ID);
    expect(offResult?.[0].referenceColumnOverlays).toEqual([overlay]);
  });

  it('injects the residue lane AFTER track lanes when tracksMode=true', () => {
    const overlay = makeOverlay([100, 101, 102]);
    const result = composeExtraLanes(true, [GC, CHROMATOGRAM], [overlay]);
    expect(result).toHaveLength(3);
    expect(result?.[0].id).toBe('gc-content');
    expect(result?.[1].id).toBe('sanger-attached-read1');
    expect(result?.[2].id).toBe(RESIDUE_LINK_LANE_ID);
  });

  it('the residue lane is height=0 with a no-op draw (overlay-only, byte-identical layout)', () => {
    const overlay = makeOverlay([100, 101, 102]);
    const result = composeExtraLanes(false, [], [overlay]);
    const lane = result?.[0];
    expect(lane?.height).toBe(0);
    expect(typeof lane?.draw).toBe('function');
  });

  it('forwards the overlays array unchanged on the residue lane', () => {
    const overlays = [makeOverlay([100, 101, 102]), makeOverlay([500, 501, 502])];
    const result = composeExtraLanes(false, [], overlays);
    expect(result?.[0].referenceColumnOverlays).toEqual(overlays);
  });

  it('omits the residue lane when overlays array is present but empty', () => {
    expect(composeExtraLanes(false, [], [])).toBeUndefined();
    const trackOnly = composeExtraLanes(true, [GC], []);
    expect(trackOnly).toEqual([GC]);
  });
});

describe('buildResidueLinkLane', () => {
  it('produces a height-0 overlay-only lane carrying the supplied overlays', () => {
    const overlays = [makeOverlay([10, 11, 12])];
    const lane = buildResidueLinkLane(overlays);
    expect(lane.id).toBe(RESIDUE_LINK_LANE_ID);
    expect(lane.height).toBe(0);
    expect(lane.referenceColumnOverlays).toEqual(overlays);
  });
});
