import { describe, expect, it } from 'vitest';

import {
  FLOATING_LABEL_COLUMN_MAX_LEADER_PX,
  distributeWithMinimumSpacing,
  planCircularColumnLabels,
  type FloatingLabelColumnRing,
} from './floating-annotation-label-columns';
import {
  type FloatingAnnotationLabelCandidate,
  type FloatingAnnotationLabelDecision,
  type FloatingAnnotationLabelPlacedDecision,
} from './floating-annotation-label-layout';

const VIEWPORT = { width: 1600, height: 1000 };
const CENTER = { x: 800, y: 500 };
const BODY_RADIUS = 300;
const RING: FloatingLabelColumnRing = { center: CENTER, radius: BODY_RADIUS + 12 };
const RING_FOR_LANES: FloatingLabelColumnRing = { center: CENTER, radius: BODY_RADIUS + 60 };
const GENOME = 2686;

function candidate(
  featureId: number,
  centerBp: number,
  textWidth: number,
  rotationDegrees: number,
  rank = featureId
): FloatingAnnotationLabelCandidate {
  const angle = (centerBp / GENOME) * 2 * Math.PI - Math.PI / 2 + (rotationDegrees * Math.PI) / 180;
  const outward = { x: Math.cos(angle), y: Math.sin(angle) };
  const anchor = { x: CENTER.x + BODY_RADIUS * outward.x, y: CENTER.y + BODY_RADIUS * outward.y };
  return {
    featureId,
    text: `feature ${featureId}`,
    stableOrder: [rank, featureId],
    sequenceCenterBp: centerBp,
    outwardSide: 1,
    textWidth,
    textHeight: 15,
    placementOptions: [],
    anchor,
    outward,
    bodyBounds: { xMin: anchor.x - 2, xMax: anchor.x + 2, yMin: anchor.y - 2, yMax: anchor.y + 2 },
    normalScale: 1,
  };
}

function placed(decisions: readonly FloatingAnnotationLabelDecision[]) {
  return decisions.filter(
    (decision): decision is FloatingAnnotationLabelPlacedDecision => decision.status === 'placed'
  );
}

function overlappingPairs(decisions: readonly FloatingAnnotationLabelPlacedDecision[]): string[] {
  const pairs: string[] = [];
  for (let left = 0; left < decisions.length; left += 1) {
    for (let right = left + 1; right < decisions.length; right += 1) {
      const a = decisions[left].bounds;
      const b = decisions[right].bounds;
      if (a.xMin < b.xMax && a.xMax > b.xMin && a.yMin < b.yMax && a.yMax > b.yMin) {
        pairs.push(`${decisions[left].featureId}/${decisions[right].featureId}`);
      }
    }
  }
  return pairs;
}

function insideRing(decision: FloatingAnnotationLabelPlacedDecision): boolean {
  const corners = [
    [decision.bounds.xMin, decision.bounds.yMin],
    [decision.bounds.xMax, decision.bounds.yMin],
    [decision.bounds.xMin, decision.bounds.yMax],
    [decision.bounds.xMax, decision.bounds.yMax],
  ];
  const nearestX = Math.min(Math.max(CENTER.x, decision.bounds.xMin), decision.bounds.xMax);
  const nearestY = Math.min(Math.max(CENTER.y, decision.bounds.yMin), decision.bounds.yMax);
  return (
    corners.length > 0 && Math.hypot(nearestX - CENTER.x, nearestY - CENTER.y) < BODY_RADIUS + 1
  );
}

describe('distributeWithMinimumSpacing', () => {
  it('keeps separated preferences untouched', () => {
    expect(distributeWithMinimumSpacing([10, 50, 90], [18, 18], 0, 200)).toEqual([10, 50, 90]);
  });

  it('centers a colliding block on the mean of its preferences', () => {
    expect(distributeWithMinimumSpacing([100, 100, 100], [18, 18], 0, 400)).toEqual([82, 100, 118]);
  });

  it('respects both bounds without reordering', () => {
    const positions = distributeWithMinimumSpacing([0, 0, 0, 395], [18, 18, 18], 4, 380);
    expect(positions[0]).toBe(4);
    expect(positions[3]).toBeLessThanOrEqual(380);
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index] - positions[index - 1]).toBeGreaterThanOrEqual(18 - 1e-9);
    }
  });
});

describe('planCircularColumnLabels', () => {
  it('keeps two neighbouring labels visible through a complete revolution', () => {
    for (let degrees = 0; degrees < 360; degrees += 1) {
      const decisions = planCircularColumnLabels(
        [candidate(1, 1000, 80, degrees), candidate(2, 1010, 60, degrees)],
        RING,
        VIEWPORT
      );
      expect(
        placed(decisions).map((decision) => decision.featureId),
        `${degrees} degrees`
      ).toEqual([1, 2]);
      expect(overlappingPairs(placed(decisions)), `${degrees} degrees`).toEqual([]);
    }
  });

  it('shows the same dense label set at every angle without overlaps or crossing into the map', () => {
    const features: Array<[number, number, number]> = [];
    let seed = 7;
    const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let id = 1; id <= 24; id += 1) {
      features.push([id, Math.floor(random() * GENOME), 30 + Math.floor(random() * 70)]);
    }
    for (const bp of [400, 410, 418, 1500, 1506]) features.push([features.length + 1, bp, 50]);
    for (let degrees = 0; degrees < 360; degrees += 1) {
      const decisions = planCircularColumnLabels(
        features.map(([id, bp, width]) => candidate(id, bp, width, degrees)),
        RING,
        VIEWPORT
      );
      const shown = placed(decisions);
      expect(shown, `${degrees} degrees`).toHaveLength(features.length);
      expect(overlappingPairs(shown), `${degrees} degrees`).toEqual([]);
      expect(shown.filter(insideRing).map((decision) => decision.featureId)).toEqual([]);
      for (const decision of shown) {
        expect(decision.leader.length).toBeLessThanOrEqual(FLOATING_LABEL_COLUMN_MAX_LEADER_PX);
      }
    }
  });

  it('moves labels continuously while rotating, away from the poles and side changes', () => {
    const features = [
      candidate(1, 300, 70, 0),
      candidate(2, 320, 40, 0),
      candidate(3, 900, 90, 0),
      candidate(4, 2000, 60, 0),
    ];
    let previous = new Map<number, FloatingAnnotationLabelPlacedDecision>();
    for (let tenth = 0; tenth < 3600; tenth += 1) {
      const degrees = tenth / 10;
      const decisions = placed(
        planCircularColumnLabels(
          features.map((feature) =>
            candidate(feature.featureId, feature.sequenceCenterBp, feature.textWidth, degrees)
          ),
          RING,
          VIEWPORT
        )
      );
      const sideChanged = decisions.some((decision) => {
        const before = previous.get(decision.featureId);
        return before !== undefined && before.leader.attachment !== decision.leader.attachment;
      });
      for (const decision of decisions) {
        const before = previous.get(decision.featureId);
        if (!before || sideChanged) continue;
        if (Math.abs(decision.y - CENTER.y) > 0.8 * RING.radius) continue;
        expect(
          Math.hypot(decision.x - before.x, decision.y - before.y),
          `feature ${decision.featureId} at ${degrees} degrees`
        ).toBeLessThan(6);
      }
      previous = new Map(decisions.map((decision) => [decision.featureId, decision]));
    }
  });

  function crossingAngles(shown: readonly FloatingAnnotationLabelPlacedDecision[]): string[] {
    type P = { x: number; y: number };
    const side = (p: P, q: P, r: P) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const crosses = (a: P, b: P, c: P, d: P) =>
      side(c, d, a) * side(c, d, b) < 0 && side(a, b, c) * side(a, b, d) < 0;
    const angle = (a: P, b: P, c: P, d: P) => {
      const first = Math.atan2(b.y - a.y, b.x - a.x);
      const second = Math.atan2(d.y - c.y, d.x - c.x);
      const delta = Math.abs(((first - second + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      return (Math.min(delta, Math.PI - delta) * 180) / Math.PI;
    };
    const segments = (decision: FloatingAnnotationLabelPlacedDecision) => [
      [decision.leader.start, decision.leader.elbow],
      [decision.leader.elbow, decision.leader.end],
    ];
    const found: string[] = [];
    for (let left = 0; left < shown.length; left += 1) {
      for (let right = left + 1; right < shown.length; right += 1) {
        for (const [a, b] of segments(shown[left])) {
          for (const [c, d] of segments(shown[right])) {
            if (crosses(a, b, c, d)) {
              found.push(
                `${shown[left].featureId}x${shown[right].featureId}@${angle(a, b, c, d).toFixed(1)}`
              );
            }
          }
        }
      }
    }
    return found;
  }

  it('never crosses leaders within a cluster of nearby annotations on mixed lanes', () => {
    for (let degrees = 0; degrees < 360; degrees += 2) {
      const cluster = [0, 16, 0, 32, 16, 0].map((laneOffset, index) => {
        const base = candidate(index + 1, 900 + index * 8, 50 + (index % 3) * 20, degrees);
        return {
          ...base,
          anchor: {
            x: base.anchor.x + base.outward.x * laneOffset,
            y: base.anchor.y + base.outward.y * laneOffset,
          },
        };
      });
      const shown = placed(planCircularColumnLabels(cluster, RING_FOR_LANES, VIEWPORT));
      expect(shown, `${degrees} degrees`).toHaveLength(cluster.length);
      expect(crossingAngles(shown), `${degrees} degrees`).toEqual([]);
    }
  });

  it('drops the lowest-priority labels only when a side is genuinely full', () => {
    const crowd = Array.from({ length: 120 }, (_, index) =>
      candidate(index + 1, 600 + index, 60, 0, index)
    );
    const decisions = planCircularColumnLabels(crowd, RING, VIEWPORT);
    const shown = placed(decisions);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(crowd.length);
    expect(overlappingPairs(shown)).toEqual([]);
    const hiddenRanks = decisions
      .filter((decision) => decision.status === 'rejected')
      .map((decision) => decision.featureId);
    const shownRanks = shown.map((decision) => decision.featureId);
    expect(Math.min(...hiddenRanks)).toBeGreaterThan(Math.min(...shownRanks));
    for (const decision of decisions) {
      if (decision.status === 'rejected') expect(decision.reason).toBe('column-capacity');
    }
  });
});
