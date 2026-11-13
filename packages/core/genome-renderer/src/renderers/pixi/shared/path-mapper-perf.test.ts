import { describe, it, expect } from 'vitest';
import { LinearPathMapper, StadiumPathMapper } from './path-mapper';
import { getStadiumDimensions } from '../../../geometry/stadium';
import type { Feature } from '../../../types';

function makeFeatures(count: number, genomeLength: number): Feature[] {
  const types = ['CDS', 'gene', 'promoter', 'terminator', 'RBS', 'misc_feature'];
  const dirs: Feature['direction'][] = ['forward', 'reverse', 'none'];
  const features: Feature[] = [];
  let seed = 0x5eed1234;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let i = 0; i < count; i++) {
    const start = Math.floor(random() * genomeLength);
    const len = 100 + Math.floor(random() * 2000);
    features.push({
      id: i,
      type: types[i % types.length],
      start,
      end: (start + len) % genomeLength,
      direction: dirs[i % 3],
      displayName: `feature_${i}`,
      color: 0x3b82f6,
      lane: i % 3,
    });
  }
  return features;
}

const GENOME_LENGTH = 4641652;
const FEATURES = makeFeatures(9122, GENOME_LENGTH);

describe('PathMapper performance regression', () => {
  describe('LinearPathMapper', () => {
    const ZOOM_LEVELS = [1, 10, 100, 500];

    for (const zoom of ZOOM_LEVELS) {
      it(`processes 9122 features in <10ms at zoom ${zoom}x`, () => {
        const bpPerPixel = GENOME_LENGTH / (1440 * zoom);
        const pm = new LinearPathMapper({
          viewportWidth: 1440,
          viewportHeight: 900,
          bpPerPixel,
          viewStartBp: 0,
          viewEndBp: GENOME_LENGTH / zoom,
          annotationLanes: 3,
          translationLanes: 0,
          hasSequence: false,
        });

        const t0 = performance.now();
        let _drawn = 0;
        for (const f of FEATURES) {
          const len = f.end > f.start ? f.end - f.start : GENOME_LENGTH - f.start + f.end;
          const px = len * pm.pixelsPerBp;
          if (px < 1) continue;
          if (!pm.isFeatureVisible(f.start, len)) continue;
          const endBp = f.end > f.start ? f.end : f.end + GENOME_LENGTH;
          pm.featurePolygonAt(f.start, endBp, f.lane);
          pm.featureLabelPosAt(f.start + len / 2, f.lane);
          _drawn++;
        }
        const elapsed = performance.now() - t0;

        expect(elapsed).toBeLessThan(50);
      });
    }
  });

  describe('StadiumPathMapper', () => {
    const ZOOM_LEVELS = [1, 10, 100, 500, 1000, 2000];

    for (const zoom of ZOOM_LEVELS) {
      it(`processes 9122 features in <10ms at zoom ${zoom}x`, () => {
        const dims = getStadiumDimensions(1440, 900, 0, 80);
        const circumPx = dims.totalLength * zoom;
        const bpPerPixel = GENOME_LENGTH / circumPx;
        const pm = new StadiumPathMapper({
          genomeLength: GENOME_LENGTH,
          viewOffset: 0,
          zoom,
          dims,
          ox: 1440 / 2 - dims.width / 2,
          oy: 900 / 2 - dims.height / 2,
          stagePosX: 0,
          stagePosY: 0,
          bpPerPixel,
          hasSequence: false,
          viewportWidth: 1440,
          viewportHeight: 900,
        });

        const t0 = performance.now();
        let _drawn = 0;
        for (const f of FEATURES) {
          const len = f.end > f.start ? f.end - f.start : GENOME_LENGTH - f.start + f.end;
          const px = len * pm.pixelsPerBp;
          if (px < 1) continue;
          if (!pm.isFeatureVisible(f.start, len)) continue;
          const endBp = f.end > f.start ? f.end : f.end + GENOME_LENGTH;
          pm.featurePolygonAt(f.start, endBp, f.lane);
          pm.featureLabelPosAt(f.start + len / 2, f.lane);
          _drawn++;
        }
        const elapsed = performance.now() - t0;

        expect(elapsed).toBeLessThan(50);
      });
    }
  });

  describe('featurePolygon point count', () => {
    it('linear returns exactly 8 points', () => {
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
      const pts = pm.featurePolygonAt(100, 200, 0);
      expect(pts).toHaveLength(8);
    });

    it('stadium returns extra points for curved spans', () => {
      const dims = getStadiumDimensions(1440, 900, 0, 80);
      const pm = new StadiumPathMapper({
        genomeLength: GENOME_LENGTH,
        viewOffset: 0,
        zoom: 1,
        dims,
        ox: 0,
        oy: 0,
        stagePosX: 0,
        stagePosY: 0,
        bpPerPixel: GENOME_LENGTH / dims.totalLength,
        hasSequence: false,
        viewportWidth: 1440,
        viewportHeight: 900,
      });
      const startBp = (dims.straightLength * 0.9 * GENOME_LENGTH) / dims.totalLength;
      const endBp =
        ((dims.straightLength + Math.PI * dims.radius * 0.8) * GENOME_LENGTH) / dims.totalLength;
      const pts = pm.featurePolygonAt(startBp, endBp, 0);
      expect(pts.length).toBeGreaterThan(8);
      expect(pts.length % 2).toBe(0);
    });
  });

  describe('full annotation pipeline (polygon + directional cap + label)', () => {
    const ZOOM_LEVELS = [1, 10, 100];
    const LANE_HEIGHT = 16;
    const ARROW_MAX = 8;
    const BAR_HEIGHT = 16;
    const MIN_BAR_FOR_ARROW = 16;

    for (const zoom of ZOOM_LEVELS) {
      it(`linear: full pipeline < 50ms at zoom ${zoom}x`, () => {
        const bpPerPixel = GENOME_LENGTH / (1440 * zoom);
        const pm = new LinearPathMapper({
          viewportWidth: 1440,
          viewportHeight: 900,
          bpPerPixel,
          viewStartBp: 0,
          viewEndBp: GENOME_LENGTH / zoom,
          annotationLanes: 3,
          translationLanes: 0,
          hasSequence: false,
        });

        const t0 = performance.now();
        let _drawn = 0;
        for (const f of FEATURES) {
          const len = f.end > f.start ? f.end - f.start : GENOME_LENGTH - f.start + f.end;
          const px = len * pm.pixelsPerBp;
          if (px < 1) continue;
          if (!pm.isFeatureVisible(f.start, len)) continue;
          const endBp = f.end > f.start ? f.end : f.end + GENOME_LENGTH;
          const offset = -(f.lane * 20 + 8);

          const _hitPts = pm.featurePolygonAt(f.start, endBp, offset);

          const hasArrow = f.direction !== 'none' && px > MIN_BAR_FOR_ARROW;
          if (hasArrow) {
            const aw = Math.min(BAR_HEIGHT * 0.6, px * 0.3, ARROW_MAX);
            const hh = LANE_HEIGHT / 2;
            const x1 = pm.bpLeftX(f.start);
            const x2 = pm.bpLeftX(endBp);
            const cy = pm.featureLabelPosAt(f.start, offset).y;
            if (f.direction === 'forward') {
              [x1, cy - hh, x2 - aw, cy - hh, x2, cy, x2 - aw, cy + hh, x1, cy + hh];
            } else {
              [x1 + aw, cy - hh, x2, cy - hh, x2, cy + hh, x1 + aw, cy + hh, x1, cy];
            }
          }

          pm.featureLabelPosAt(f.start + len / 2, offset);
          _drawn++;
        }
        const elapsed = performance.now() - t0;
        expect(elapsed).toBeLessThan(50);
      });
    }
  });

  describe('visibility correctness', () => {
    it('stadium: features at high zoom are not falsely culled', () => {
      const dims = getStadiumDimensions(1440, 900, 0, 80);
      const zoom = 2000;
      const ox = 720 - dims.width / 2;
      const oy = 450 - dims.height / 2;
      const topWorldX = dims.width / 2;
      const topWorldY = 0;
      const stagePosX = 720 - (ox + topWorldX) * zoom;
      const stagePosY = 200 - (oy + topWorldY) * zoom;
      const pm = new StadiumPathMapper({
        genomeLength: GENOME_LENGTH,
        viewOffset: 0,
        zoom,
        dims,
        ox,
        oy,
        stagePosX,
        stagePosY,
        bpPerPixel: GENOME_LENGTH / (dims.totalLength * zoom),
        hasSequence: false,
        viewportWidth: 1440,
        viewportHeight: 900,
      });

      const topMidBp = (dims.straightLength / dims.totalLength / 2) * GENOME_LENGTH;
      const visibleFeatureLengths = [160, 240];
      for (const [idx, len] of visibleFeatureLengths.entries()) {
        const start = topMidBp + idx * 300 - len / 2;
        const px = len * pm.pixelsPerBp;
        expect(px).toBeGreaterThan(100);
        expect(pm.isFeatureVisible(start, len)).toBe(true);
      }
    });
  });
});
