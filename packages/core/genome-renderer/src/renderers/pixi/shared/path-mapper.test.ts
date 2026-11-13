import { describe, it, expect } from 'vitest';
import { LinearPathMapper, StadiumPathMapper, type PathMapper } from './path-mapper';
import { LANE_HEIGHT } from './layout-model';
import { computeUnifiedLayout, type UnifiedLayout } from './track-layout';
import type { Genome, RenderState } from '../../../types';
import { getStadiumDimensions } from '../../../geometry/stadium';

describe('linear nucleotide viewport projection', () => {
  it.each([400, 831])(
    'preserves the physical canvas height %i through unified layout',
    (height) => {
      const state: RenderState = {
        morph: 0,
        viewOffset: 0.352496642,
        zoom: 19617274,
        width: 1155,
        height,
        selectedIds: new Set(),
        hoveredId: null,
        highlightRange: null,
        cursorPosition: null,
        hoveredCutSiteId: null,
        perfPanelVisible: false,
      };
      const genome: Genome = { name: 'GRCh38', circular: false, length: 3088269832, features: [] };
      const layout = computeUnifiedLayout({
        overlays: [],
        genome,
        state,
        pixelsPerBp: 7.3367785685,
        viewportHeight: height,
        hasSequence: true,
        translationLanes: 0,
        annotationLanes: 0,
        cdsLanes: 0,
      });
      const path = LinearPathMapper.fromUnifiedLayout(
        layout,
        state.width,
        1 / 7.3367785685,
        1088604745.3903635,
        1088604902.8164039,
        0,
        0,
        height
      );
      expect(path.getModel().viewportWidth).toBe(state.width);
      expect(path.getModel().viewportHeight).toBe(height);
      for (const center of [path.getModel().fwdStrandCenter, path.getModel().revStrandCenter]) {
        const clipY = 1 - (center / path.getModel().viewportHeight) * 2;
        expect(clipY).toBeGreaterThan(-1);
        expect(clipY).toBeLessThan(1);
      }
    }
  );
});

function maxOuterTurnAngle(points: number[]): number {
  let maxAngle = 0;
  const outerPointCount = points.length / 4;
  for (let i = 1; i < outerPointCount - 1; i++) {
    const ax = points[i * 2] - points[(i - 1) * 2];
    const ay = points[i * 2 + 1] - points[(i - 1) * 2 + 1];
    const bx = points[(i + 1) * 2] - points[i * 2];
    const by = points[(i + 1) * 2 + 1] - points[i * 2 + 1];
    let delta = Math.atan2(by, bx) - Math.atan2(ay, ax);
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    maxAngle = Math.max(maxAngle, Math.abs(delta));
  }
  return maxAngle;
}

function polygonIntersectsViewport(
  points: number[],
  viewportWidth: number,
  viewportHeight: number
): boolean {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < points.length; i += 2) {
    xMin = Math.min(xMin, points[i]);
    xMax = Math.max(xMax, points[i]);
    yMin = Math.min(yMin, points[i + 1]);
    yMax = Math.max(yMax, points[i + 1]);
  }
  return xMax >= 0 && xMin <= viewportWidth && yMax >= 0 && yMin <= viewportHeight;
}

function testPathMapperContract(name: string, createMapper: () => PathMapper) {
  describe(`PathMapper contract: ${name}`, () => {
    it('fwdStrandAt and revStrandAt return different Y (or radial position)', () => {
      const m = createMapper();
      const fwd = m.fwdStrandAt(100);
      const rev = m.revStrandAt(100);
      const dist = Math.sqrt((fwd.x - rev.x) ** 2 + (fwd.y - rev.y) ** 2);
      expect(dist).toBeGreaterThan(0);
    });

    it('cutLineTopAt is above/outside fwdStrandAt', () => {
      const m = createMapper();
      const cutTop = m.cutLineTopAt(100);
      const fwd = m.fwdStrandAt(100);
      const dist = Math.sqrt((cutTop.x - fwd.x) ** 2 + (cutTop.y - fwd.y) ** 2);
      expect(dist).toBeGreaterThan(0);
    });

    it('cutLineBottomAt is below/outside revStrandAt', () => {
      const m = createMapper();
      const cutBot = m.cutLineBottomAt(100);
      const rev = m.revStrandAt(100);
      const dist = Math.sqrt((cutBot.x - rev.x) ** 2 + (cutBot.y - rev.y) ** 2);
      expect(dist).toBeGreaterThan(0);
    });

    it('bpCenterX spacing equals pixelsPerBp', () => {
      const m = createMapper();
      const x1 = m.bpCenterX(100);
      const x2 = m.bpCenterX(101);
      expect(Math.abs(x2 - x1)).toBeCloseTo(m.pixelsPerBp, 1);
    });

    it('bpLeftX is bpCenterX minus half pixelsPerBp', () => {
      const m = createMapper();
      expect(m.bpLeftX(100)).toBeCloseTo(m.bpCenterX(100) - m.pixelsPerBp / 2, 1);
    });

    it('rowHeight equals sequenceFontSize + 2', () => {
      const m = createMapper();
      expect(m.rowHeight).toBeCloseTo(m.sequenceFontSize + 2, 5);
    });

    it('cutLineConnectorAt is between fwdStrand and revStrand', () => {
      const m = createMapper();
      const fwd = m.fwdStrandAt(100);
      const rev = m.revStrandAt(100);
      const conn = m.cutLineConnectorAt(100);
      const fwdDist = Math.sqrt((conn.x - fwd.x) ** 2 + (conn.y - fwd.y) ** 2);
      const revDist = Math.sqrt((conn.x - rev.x) ** 2 + (conn.y - rev.y) ** 2);
      const totalDist = Math.sqrt((fwd.x - rev.x) ** 2 + (fwd.y - rev.y) ** 2);
      expect(fwdDist + revDist).toBeCloseTo(totalDist, 0);
    });

    it('boundaryAt X equals cutLineTopAt X (single source of truth)', () => {
      const m = createMapper();
      const boundary = m.boundaryAt(100, 'cutTop');
      const cutLine = m.cutLineTopAt(100);
      expect(boundary.x).toBeCloseTo(cutLine.x, 5);
      expect(boundary.y).toBeCloseTo(cutLine.y, 5);
    });

    it('boundaryAt(bp) X is between bpCenterX(bp-1) and bpCenterX(bp)', () => {
      const m = createMapper();
      const leftCenter = m.bpCenterX(99);
      const rightCenter = m.bpCenterX(100);
      const boundary = m.boundaryAt(100, 'fwdStrand');
      expect(boundary.x).toBeGreaterThanOrEqual(Math.min(leftCenter, rightCenter) - 1);
      expect(boundary.x).toBeLessThanOrEqual(Math.max(leftCenter, rightCenter) + 1);
    });

    it('boundaryAt(bp) X matches bpLeftX(bp) within tolerance', () => {
      const m = createMapper();
      const boundary = m.boundaryAt(100, 'backbone');
      const leftX = m.bpLeftX(100);
      expect(Math.abs(boundary.x - leftX)).toBeLessThan(m.pixelsPerBp);
    });
  });
}

testPathMapperContract('LinearPathMapper', () => {
  return new LinearPathMapper({
    viewportWidth: 1440,
    viewportHeight: 900,
    bpPerPixel: 0.5,
    viewStartBp: 0,
    viewEndBp: 720,
    annotationLanes: 3,
    translationLanes: 1,
    hasSequence: true,
  });
});

testPathMapperContract('StadiumPathMapper', () => {
  const dims = getStadiumDimensions(1440, 900, 0, 80);
  return new StadiumPathMapper({
    genomeLength: 4641652,
    viewOffset: 0,
    zoom: 2000,
    dims,
    ox: 1440 / 2 - dims.width / 2,
    oy: 900 / 2 - dims.height / 2,
    stagePosX: 0,
    stagePosY: 0,
    bpPerPixel: 4641652 / (1440 * 2000),
    hasSequence: true,
    viewportWidth: 1440,
    viewportHeight: 900,
  });
});

describe('StadiumPathMapper nearestBpAt', () => {
  it('inverts backboneAt to within one base', () => {
    const dims = getStadiumDimensions(1440, 900, 0, 80);
    const genomeLength = 4_641_652;
    const zoom = 3;
    const pm = new StadiumPathMapper({
      genomeLength,
      viewOffset: 0.37,
      zoom,
      dims,
      ox: 1440 / 2 - dims.width / 2,
      oy: 900 / 2 - dims.height / 2,
      stagePosX: 0,
      stagePosY: 0,
      bpPerPixel: genomeLength / (dims.totalLength * zoom),
      hasSequence: false,
      viewportWidth: 1440,
      viewportHeight: 900,
    });
    for (const bp of [10, 480_000, 1_200_000, 2_320_826, 3_900_000, genomeLength - 10]) {
      const point = pm.backboneAt(bp);
      const back = pm.nearestBpAt(point.x, point.y);
      const wrapped = Math.min(Math.abs(back - bp), genomeLength - Math.abs(back - bp));
      expect(wrapped).toBeLessThanOrEqual(1);
    }
  });
});

describe('StadiumPathMapper feature polygon memo', () => {
  function mapper(): StadiumPathMapper {
    const dims = getStadiumDimensions(1440, 900, 0, 80);
    return new StadiumPathMapper({
      genomeLength: 4_641_652,
      viewOffset: 0.25,
      zoom: 30,
      dims,
      ox: 1440 / 2 - dims.width / 2,
      oy: 900 / 2 - dims.height / 2,
      stagePosX: 0,
      stagePosY: 0,
      bpPerPixel: 4_641_652 / (dims.totalLength * 30),
      hasSequence: false,
      viewportWidth: 1440,
      viewportHeight: 900,
    });
  }

  it('returns the identical polygon for a repeated request and recomputes for a new one', () => {
    const pm = mapper();
    const first = pm.featurePolygonAt(1_160_000, 1_161_200, -14, 7);
    const again = pm.featurePolygonAt(1_160_000, 1_161_200, -14, 7);
    expect(again).toBe(first);
    expect(first.length).toBeGreaterThanOrEqual(8);

    const other = pm.featurePolygonAt(1_160_000, 1_161_200, -14, 5);
    expect(other).not.toBe(first);
    expect(other).not.toStrictEqual(first);
    const back = pm.featurePolygonAt(1_160_000, 1_161_200, -14, 7);
    expect(back).not.toBe(first);
    expect(back).toStrictEqual(first);
  });

  it('matches a fresh mapper point for point', () => {
    const cached = mapper();
    cached.featurePolygonAt(2_000_000, 2_000_900, 4, 7);
    const repeat = cached.featurePolygonAt(2_000_000, 2_000_900, 4, 7);
    expect(repeat).toStrictEqual(mapper().featurePolygonAt(2_000_000, 2_000_900, 4, 7));
  });
});

describe('StadiumPathMapper sequence viewport window', () => {
  it('centers nucleotide-LOD culling on the same top camera pin used by the sequence renderer', () => {
    const genomeLength = 4_641_652;
    const viewportWidth = 1327;
    const viewportHeight = 260;
    const geometryHeight = 220;
    const viewOffset = 0.23;
    const zoom = 8874;
    const dims = getStadiumDimensions(viewportWidth, geometryHeight, 0, 0);
    const pm = new StadiumPathMapper({
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
      viewportHeight,
      geometryHeight,
    });

    const topCameraPinFrac = dims.straightLength / dims.totalLength / 2;
    const expectedCenterBp = ((((topCameraPinFrac + viewOffset) % 1) + 1) % 1) * genomeLength;
    const expectedSpanBp = ((viewportWidth + geometryHeight) * 2) / pm.pixelsPerBp;
    const actualCenterBp = (pm.viewStartBp + pm.viewEndBp) / 2;
    const rawViewOffsetCenterBp = viewOffset * genomeLength;

    expect(actualCenterBp).toBeCloseTo(expectedCenterBp, 0);
    expect(Math.abs(pm.viewEndBp - pm.viewStartBp - expectedSpanBp)).toBeLessThanOrEqual(2);
    expect(Math.abs(actualCenterBp - rawViewOffsetCenterBp)).toBeGreaterThan(genomeLength * 0.05);
  });
});

describe('LinearPathMapper.featurePolygon', () => {
  const INPUTS = {
    viewportWidth: 1440,
    viewportHeight: 900,
    bpPerPixel: 10,
    viewStartBp: 0,
    viewEndBp: 14400,
    annotationLanes: 3,
    translationLanes: 0,
    hasSequence: false,
  };

  it('returns exactly 8 values (4 corners of a rectangle)', () => {
    const pm = new LinearPathMapper(INPUTS);
    const pts = pm.featurePolygonAt(100, 200, 0);
    expect(pts).toHaveLength(8);
  });

  it('rectangle X coords match bpLeftX for start and end', () => {
    const pm = new LinearPathMapper(INPUTS);
    const pts = pm.featurePolygonAt(100, 200, 0);
    const x1 = pm.bpLeftX(100);
    const x2 = pm.bpLeftX(200);
    expect(pts[0]).toBeCloseTo(x1, 5);
    expect(pts[2]).toBeCloseTo(x2, 5);
    expect(pts[4]).toBeCloseTo(x2, 5);
    expect(pts[6]).toBeCloseTo(x1, 5);
  });

  it('default halfHeight is LANE_HEIGHT / 2', () => {
    const pm = new LinearPathMapper(INPUTS);
    const pts = pm.featurePolygonAt(100, 200, 0);
    const height = pts[5] - pts[1];
    expect(height).toBeCloseTo(LANE_HEIGHT, 5);
  });

  it('halfHeight override produces thinner polygon', () => {
    const pm = new LinearPathMapper(INPUTS);
    const pts = pm.featurePolygonAt(100, 200, 0, 3);
    const height = pts[5] - pts[1];
    expect(height).toBeCloseTo(6, 5);
  });

  it('halfHeight override keeps same center Y', () => {
    const pm = new LinearPathMapper(INPUTS);
    const defPts = pm.featurePolygonAt(100, 200, 0);
    const thinPts = pm.featurePolygonAt(100, 200, 0, 3);
    const defCenter = (defPts[1] + defPts[5]) / 2;
    const thinCenter = (thinPts[1] + thinPts[5]) / 2;
    expect(thinCenter).toBeCloseTo(defCenter, 5);
  });

  it('offset parameter moves polygon vertically by that many pixels', () => {
    const pm = new LinearPathMapper(INPUTS);
    const pts0 = pm.featurePolygonAt(100, 200, 0);
    const pts20 = pm.featurePolygonAt(100, 200, -20);
    const center0 = (pts0[1] + pts0[5]) / 2;
    const center20 = (pts20[1] + pts20[5]) / 2;
    expect(center0 - center20).toBeCloseTo(20, 5);
  });
});

describe('LinearPathMapper.featureLabelPos', () => {
  const INPUTS = {
    viewportWidth: 1440,
    viewportHeight: 900,
    bpPerPixel: 10,
    viewStartBp: 0,
    viewEndBp: 14400,
    annotationLanes: 3,
    translationLanes: 0,
    hasSequence: false,
  };

  it('returns bpCenterX, not bpLeftX', () => {
    const pm = new LinearPathMapper(INPUTS);
    const pos = pm.featureLabelPosAt(100, 0);
    expect(pos.x).toBeCloseTo(pm.bpCenterX(100), 5);
  });

  it('returns Y at fwdStrandTop + offset', () => {
    const pm = new LinearPathMapper(INPUTS);
    const model = pm.getModel();
    const pos = pm.featureLabelPosAt(100, -30);
    expect(pos.y).toBeCloseTo(model.fwdStrandTop - 30, 5);
  });

  it('angle is 0 in linear mode', () => {
    const pm = new LinearPathMapper(INPUTS);
    expect(pm.featureLabelPosAt(100, 0).angle).toBe(0);
  });
});

describe('LinearPathMapper.isArcMode', () => {
  it('is false', () => {
    const pm = new LinearPathMapper({
      viewportWidth: 1440,
      viewportHeight: 900,
      bpPerPixel: 10,
      viewStartBp: 0,
      viewEndBp: 14400,
      annotationLanes: 1,
      translationLanes: 0,
      hasSequence: false,
    });
    expect(pm.isArcMode).toBe(false);
  });
});

describe('LinearPathMapper.isFeatureVisible', () => {
  const INPUTS = {
    viewportWidth: 1440,
    viewportHeight: 900,
    bpPerPixel: 10,
    viewStartBp: 0,
    viewEndBp: 14400,
    annotationLanes: 1,
    translationLanes: 0,
    hasSequence: false,
  };

  it('true for feature fully in viewport', () => {
    const pm = new LinearPathMapper(INPUTS);
    expect(pm.isFeatureVisible(100, 100)).toBe(true);
  });

  it('true for feature partially visible on left', () => {
    const pm = new LinearPathMapper(INPUTS);
    expect(pm.isFeatureVisible(-400, 1000)).toBe(true);
  });

  it('false for feature completely off-screen right', () => {
    const pm = new LinearPathMapper(INPUTS);
    expect(pm.isFeatureVisible(20000, 1000)).toBe(false);
  });

  it('false for feature completely off-screen left', () => {
    const pm = new LinearPathMapper(INPUTS);
    expect(pm.isFeatureVisible(-10000, 1000)).toBe(false);
  });
});

describe('StadiumPathMapper.featurePolygon', () => {
  it('keeps straight stadium feature spans sparse instead of over-tessellating them', () => {
    const dims = getStadiumDimensions(1440, 900, 0, 80);
    const pm = new StadiumPathMapper({
      genomeLength: 4641652,
      viewOffset: 0,
      zoom: 1,
      dims,
      ox: 1440 / 2 - dims.width / 2,
      oy: 900 / 2 - dims.height / 2,
      stagePosX: 0,
      stagePosY: 0,
      bpPerPixel: 4641652 / 1440,
      hasSequence: false,
      viewportWidth: 1440,
      viewportHeight: 900,
    });
    const pts = pm.featurePolygonAt(100, 5000, 0);
    expect(pts.length).toBeLessThanOrEqual(16);
    expect(pts.length % 2).toBe(0);
  });

  it('isArcMode is true', () => {
    const dims = getStadiumDimensions(1440, 900, 0, 80);
    const pm = new StadiumPathMapper({
      genomeLength: 4641652,
      viewOffset: 0,
      zoom: 1,
      dims,
      ox: 0,
      oy: 0,
      stagePosX: 0,
      stagePosY: 0,
      bpPerPixel: 4641652 / 1440,
      hasSequence: false,
      viewportWidth: 1440,
      viewportHeight: 900,
    });
    expect(pm.isArcMode).toBe(true);
  });

  it('compacts stadium lane centers and detailed feature thickness together', () => {
    const dims = getStadiumDimensions(600, 160, 0, 20);
    const overviewLaneScale = 0.35;
    const pm = new StadiumPathMapper({
      genomeLength: 4641652,
      viewOffset: 0,
      zoom: 1,
      dims,
      ox: 0,
      oy: 0,
      stagePosX: 0,
      stagePosY: 0,
      bpPerPixel: 4641652 / 600,
      hasSequence: false,
      viewportWidth: 600,
      viewportHeight: 160,
      layout: {
        overviewLaneScale,
        sequenceVisible: false,
        rowHeight: 12,
        sequenceFontSize: 10,
        fwdStrandOffset: 0,
        revStrandOffset: 20,
        cutLineTopOffset: -4,
        cutLineConnectorOffset: 12,
        cutLineBottomOffset: 24,
        cutLabelOffset: 34,
        rulerOffset: 40,
      } as UnifiedLayout,
    });

    const halfHeight = 2.5;
    const pts = pm.featurePolygonAt(100, 5000, -20, halfHeight);
    const firstOuterX = pts[0];
    const firstOuterY = pts[1];
    const firstInnerX = pts[pts.length - 2];
    const firstInnerY = pts[pts.length - 1];
    const renderedThickness = Math.hypot(firstOuterX - firstInnerX, firstOuterY - firstInnerY);

    expect(renderedThickness).toBeCloseTo(halfHeight * 2 * overviewLaneScale, 5);

    const center = pm.featureLabelPosAt(100, 0);
    const compactedCenter = pm.featureLabelPosAt(100, -20);
    const compactedOffset = Math.hypot(center.x - compactedCenter.x, center.y - compactedCenter.y);
    expect(compactedOffset).toBeCloseTo(20 * overviewLaneScale, 5);
  });

  it('keeps adjacent compacted stadium annotation lanes from overlapping', () => {
    const dims = getStadiumDimensions(600, 160, 0, 20);
    const overviewLaneScale = 0.35;
    const pm = new StadiumPathMapper({
      genomeLength: 4641652,
      viewOffset: 0,
      zoom: 1,
      dims,
      ox: 0,
      oy: 0,
      stagePosX: 0,
      stagePosY: 0,
      bpPerPixel: 4641652 / 600,
      hasSequence: false,
      viewportWidth: 600,
      viewportHeight: 160,
      layout: {
        overviewLaneScale,
        sequenceVisible: false,
        rowHeight: 12,
        sequenceFontSize: 10,
        fwdStrandOffset: 0,
        revStrandOffset: 20,
        cutLineTopOffset: -4,
        cutLineConnectorOffset: 12,
        cutLineBottomOffset: 24,
        cutLabelOffset: 34,
        rulerOffset: 40,
      } as UnifiedLayout,
    });
    const laneStepPx = 16;
    const halfHeight = 7;
    const polygonHalfHeight = (offsetPx: number) => {
      const pts = pm.featurePolygonAt(100, 5000, offsetPx, halfHeight);
      return Math.hypot(pts[0] - pts[pts.length - 2], pts[1] - pts[pts.length - 1]) / 2;
    };
    const lane0 = pm.featureLabelPosAt(100, 0);
    const lane1 = pm.featureLabelPosAt(100, -laneStepPx);
    const centerDistance = Math.hypot(lane0.x - lane1.x, lane0.y - lane1.y);
    const visualGap = centerDistance - polygonHalfHeight(0) - polygonHalfHeight(-laneStepPx);

    expect(visualGap).toBeCloseTo((laneStepPx - halfHeight * 2) * overviewLaneScale, 5);
    expect(visualGap).toBeGreaterThan(0);
  });

  it('keeps pAJM stadium annotation polygons smooth on curved caps without straight-run oversampling', () => {
    const dims = getStadiumDimensions(1000, 120, 0, 0);
    const pAJMFeatures = [
      { name: 'EYFP', start: 264, end: 983 },
      { name: 'cymR', start: 1131, end: 1742 },
      { name: 'p15A ori', start: 2318, end: 2863 },
    ];

    for (const viewOffset of [0, 0.125, 0.25, 0.375, 0.5]) {
      const pm = new StadiumPathMapper({
        genomeLength: 3867,
        viewOffset,
        zoom: 1,
        dims,
        ox: 0,
        oy: 0,
        stagePosX: 0,
        stagePosY: 0,
        bpPerPixel: 3867 / 1000,
        hasSequence: false,
        viewportWidth: 1000,
        viewportHeight: 120,
      });

      for (const feature of pAJMFeatures) {
        const pts = pm.featurePolygonAt(feature.start, feature.end, -20, 7);
        expect(
          maxOuterTurnAngle(pts),
          `${feature.name} viewOffset=${viewOffset} max outer turn`
        ).toBeLessThanOrEqual(0.35);
        expect(pts.length / 2, `${feature.name} point count`).toBeLessThanOrEqual(512);
      }
    }
  });

  it('bounds MG1655 nucleotide-zoom annotation polygon complexity', () => {
    const dims = getStadiumDimensions(1327, 240, 0, 0);
    const pm = new StadiumPathMapper({
      genomeLength: 4641652,
      viewOffset: 0.8,
      zoom: 8874,
      dims,
      ox: 1327 / 2 - dims.width / 2,
      oy: 240 / 2 - dims.height / 2,
      stagePosX: 0,
      stagePosY: 0,
      bpPerPixel: 4641652 / (1327 * 8874),
      hasSequence: true,
      viewportWidth: 1327,
      viewportHeight: 240,
    });

    const pts = pm.featurePolygonAt(1000, 2500, -20, 7);
    expect(pts.length / 2).toBeLessThanOrEqual(256);
  });

  it('does not cull circular lane polygons that are visible only because of lane-stack offset', () => {
    const viewportWidth = 2048;
    const viewportHeight = 620;
    const dims = getStadiumDimensions(viewportWidth, 620, 0.55, 20);
    const pm = new StadiumPathMapper({
      genomeLength: 4_641_652,
      viewOffset: 0.58,
      zoom: 3.5,
      dims,
      ox: viewportWidth / 2 - dims.width / 2,
      oy: viewportHeight / 2 - dims.height / 2,
      stagePosX: 0,
      stagePosY: -250,
      bpPerPixel: 4_641_652 / (dims.totalLength * 3.5),
      hasSequence: false,
      viewportWidth,
      viewportHeight,
    });
    let visibleOnlyWithLaneOffset: { start: number; length: number; offset: number } | null = null;

    for (const offset of [-180, -140, -100, 100, 140, 180]) {
      for (let start = 0; start < 4_641_652; start += 25_000) {
        const length = 18_000;
        const pts = pm.featurePolygonAt(start, start + length, offset, 7);
        if (
          polygonIntersectsViewport(pts, viewportWidth, viewportHeight) &&
          !pm.isFeatureVisible(start, length, offset, 7)
        ) {
          visibleOnlyWithLaneOffset = { start, length, offset };
          break;
        }
      }
      if (visibleOnlyWithLaneOffset) break;
    }

    expect(visibleOnlyWithLaneOffset).toBeNull();
  });
});

describe('LinearPathMapper specifics', () => {
  it('all angles are 0', () => {
    const m = new LinearPathMapper({
      viewportWidth: 1440,
      viewportHeight: 900,
      bpPerPixel: 0.5,
      viewStartBp: 0,
      viewEndBp: 720,
      annotationLanes: 3,
      translationLanes: 1,
      hasSequence: true,
    });
    expect(m.fwdStrandAt(100).angle).toBe(0);
    expect(m.revStrandAt(100).angle).toBe(0);
    expect(m.backboneAt(100).angle).toBe(0);
  });

  it('Y stacking is monotonic: annotation < translation < fwd < rev < ruler', () => {
    const m = new LinearPathMapper({
      viewportWidth: 1440,
      viewportHeight: 900,
      bpPerPixel: 0.5,
      viewStartBp: 0,
      viewEndBp: 720,
      annotationLanes: 3,
      translationLanes: 1,
      hasSequence: true,
    });
    const ann = m.annotationAt(100, 0);
    const trans = m.translationAt(100, 0);
    const fwd = m.fwdStrandAt(100);
    const rev = m.revStrandAt(100);
    const ruler = m.rulerAt(100);
    expect(ann.y).toBeLessThan(trans.y);
    expect(trans.y).toBeLessThan(fwd.y);
    expect(fwd.y).toBeLessThan(rev.y);
    expect(rev.y).toBeLessThan(ruler.y);
  });
});
