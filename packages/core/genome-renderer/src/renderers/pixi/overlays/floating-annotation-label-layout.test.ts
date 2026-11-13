import { describe, expect, it } from 'vitest';

import {
  FLOATING_LABEL_MAX_LEADER_PX,
  floatingAnnotationLabelDensityTarget,
  floatingAnnotationVisibleLeaderSegments,
  floatingLabelOutwardAnchor,
  planFloatingAnnotationLabels,
  precomputeFloatingAnnotationLabelAssignments,
  rankFloatingAnnotationLabelFeatureIds,
  type FloatingAnnotationLabelCandidate,
  type FloatingAnnotationLabelObstacle,
  type FloatingAnnotationLabelPlacedDecision,
  verticalTickX,
  FLOATING_LABEL_TICK_EDGE_INSET_PX,
} from './floating-annotation-label-layout';

function candidate(
  featureId: number,
  x: number,
  overrides: Partial<FloatingAnnotationLabelCandidate> = {}
): FloatingAnnotationLabelCandidate {
  return {
    featureId,
    text: `feature-${featureId}`,
    stableOrder: [featureId * 100, featureId],
    sequenceCenterBp: x,
    outwardSide: -1,
    placementOptions: [
      { tangentStep: 0, layoutCenterBp: x, outwardClearance: 0, outwardRail: -20 },
    ],
    anchor: { x, y: 200 },
    outward: { x: 0, y: -1 },
    textWidth: 54,
    textHeight: 12,
    bodyBounds: { xMin: x - 8, xMax: x + 8, yMin: 193, yMax: 207 },
    normalScale: 1,
    ...overrides,
  };
}

function plan(
  candidates: readonly FloatingAnnotationLabelCandidate[],
  viewport: { width: number; height: number; preloadMargin: number },
  obstacles: readonly FloatingAnnotationLabelObstacle[] = []
) {
  const assignments = precomputeFloatingAnnotationLabelAssignments(candidates, {
    pixelsPerBp: 1,
    genomeLength: 1_000,
    circular: false,
  });
  return planFloatingAnnotationLabels(candidates, assignments.assignments, viewport, obstacles);
}

describe('floating annotation label layout', () => {
  it('builds one input-order-independent spatial priority whose prefixes stay nested', () => {
    const features = [
      { featureId: 5, sequenceCenterBp: 950 },
      { featureId: 2, sequenceCenterBp: 250 },
      { featureId: 4, sequenceCenterBp: 750 },
      { featureId: 1, sequenceCenterBp: 50 },
      { featureId: 3, sequenceCenterBp: 500 },
    ];
    const ranked = rankFloatingAnnotationLabelFeatureIds(features, 1_000);
    const reversed = rankFloatingAnnotationLabelFeatureIds([...features].reverse(), 1_000);

    expect(reversed).toStrictEqual(ranked);
    expect(new Set(ranked)).toStrictEqual(new Set(features.map(({ featureId }) => featureId)));
    const widerPrefix = new Set(ranked.slice(0, 4));
    expect(ranked.slice(0, 2).every((featureId) => widerPrefix.has(featureId))).toBe(true);
    expect(
      ranked
        .slice(0, 4)
        .map((featureId) => features.find((f) => f.featureId === featureId)?.sequenceCenterBp)
    ).toStrictEqual([500, 250, 750, 50]);
  });

  it('thins labels in discrete nested octave steps without ever reaching zero', () => {
    const genomeLength = 4_641_652;
    const maxCandidates = 6_000;
    const broad = floatingAnnotationLabelDensityTarget({
      genomeLength,
      bandMinPixelsPerBp: 2 ** -14,
      maxCandidates,
    });
    const sameBand = floatingAnnotationLabelDensityTarget({
      genomeLength,
      bandMinPixelsPerBp: 2 ** -14,
      maxCandidates,
    });
    const nextOctave = floatingAnnotationLabelDensityTarget({
      genomeLength,
      bandMinPixelsPerBp: 2 ** -13,
      maxCandidates,
    });
    const microscopic = floatingAnnotationLabelDensityTarget({
      genomeLength,
      bandMinPixelsPerBp: 2 ** -30,
      maxCandidates,
    });

    expect(broad).toBe(sameBand);
    expect(broad).toBeGreaterThan(0);
    expect(nextOctave).toBeGreaterThan(broad);
    expect(nextOctave).toBeLessThanOrEqual(broad * 2 + 1);
    expect(microscopic).toBeGreaterThan(0);
    expect(nextOctave).toBeLessThan(maxCandidates);
  });

  it('centers a flat outward edge instead of flipping endpoints under sub-pixel camera noise', () => {
    const center = { x: 0, y: 0 };
    const polygon = [-20, -5, 20, -5, 20, 5, -20, 5];

    const leaningLeft = floatingLabelOutwardAnchor(center, { x: -1e-10, y: -1 }, polygon);
    const leaningRight = floatingLabelOutwardAnchor(center, { x: 1e-10, y: -1 }, polygon);

    expect(leaningLeft).toStrictEqual({ x: 0, y: -5 });
    expect(leaningRight).toStrictEqual(leaningLeft);
  });

  it('precomputes byte-identical genome-space assignments independent of input order', () => {
    const candidates = [candidate(3, 300), candidate(1, 100), candidate(2, 200)];
    const options = { pixelsPerBp: 1, genomeLength: 1_000, circular: false };
    const first = precomputeFloatingAnnotationLabelAssignments(candidates, options);
    const revisited = precomputeFloatingAnnotationLabelAssignments(
      [...candidates].reverse(),
      options
    );

    expect([...revisited.assignments]).toStrictEqual([...first.assignments]);
    expect(revisited.fingerprint).toBe(first.fingerprint);
  });

  it('returns one explicit decision for every candidate instead of silently dropping labels', () => {
    const result = plan(
      Array.from({ length: 8 }, (_, index) => candidate(index + 1, 70 + index * 90)),
      { width: 800, height: 300, preloadMargin: 80 }
    );

    expect(result.decisions).toHaveLength(8);
    expect(result.decisions.every((decision) => decision.status === 'placed')).toBe(true);
    expect(new Set(result.decisions.map((decision) => decision.featureId)).size).toBe(8);
  });

  it('uses the nearest outward row when there is room and never emits a runaway leader', () => {
    const result = plan([candidate(1, 200)], {
      width: 400,
      height: 300,
      preloadMargin: 80,
    });
    const decision = result.decisions[0];

    expect(decision.status).toBe('placed');
    if (decision.status !== 'placed') throw new Error('expected a placed label');
    expect(decision.slot.outwardRow).toBe(0);
    expect(decision.slot.tangentStep).toBe(0);
    expect(decision.leader.length).toBeLessThanOrEqual(FLOATING_LABEL_MAX_LEADER_PX);
    expect(decision.y).toBeGreaterThanOrEqual(170);
  });

  it('routes each callout through a slanted leader and an eight-pixel horizontal terminal tick', () => {
    const result = plan(
      [
        candidate(1, 200, {
          outwardSide: 1,
          outward: { x: 1, y: 0 },
          placementOptions: [
            { tangentStep: 1, layoutCenterBp: 218, outwardClearance: 0, outwardRail: 20 },
          ],
        }),
      ],
      { width: 400, height: 300, preloadMargin: 80 }
    );
    const decision = result.decisions[0];

    expect(decision.status).toBe('placed');
    if (decision.status !== 'placed') throw new Error('expected a placed label');
    expect(decision.leader).toMatchObject({
      attachment: 'left',
      start: { x: 200, y: 200 },
      elbow: { x: 201, y: 218 },
      end: { x: 209, y: 218 },
    });
  });

  it('can attach the horizontal terminal tick to the label right edge', () => {
    const decision = plan(
      [
        candidate(1, 200, {
          outward: { x: -1, y: 0 },
          placementOptions: [
            { tangentStep: -1, layoutCenterBp: 182, outwardClearance: 0, outwardRail: -20 },
          ],
        }),
      ],
      { width: 400, height: 300, preloadMargin: 80 }
    ).decisions[0];

    expect(decision.status).toBe('placed');
    if (decision.status !== 'placed') throw new Error('expected a placed label');
    expect(decision.leader.attachment).toBe('right');
    expect(decision.leader.elbow.y).toBe(decision.leader.end.y);
    expect(decision.leader.elbow.x).toBeGreaterThan(decision.leader.end.x);
  });

  it('attaches to the label bottom with a short vertical tick when the label is above its body', () => {
    const decision = plan([candidate(1, 200)], {
      width: 400,
      height: 300,
      preloadMargin: 80,
    }).decisions[0];

    expect(decision.status).toBe('placed');
    if (decision.status !== 'placed') throw new Error('expected a placed label');
    expect(decision.leader.attachment).toBe('bottom');
    expect(decision.leader.elbow.x).toBe(decision.leader.end.x);
    expect(decision.leader.elbow.y).toBeGreaterThan(decision.leader.end.y);
  });

  it('attaches to the label top with a short vertical tick when the label is below its body', () => {
    const decision = plan([candidate(1, 200, { outwardSide: 1, outward: { x: 0, y: 1 } })], {
      width: 400,
      height: 300,
      preloadMargin: 80,
    }).decisions[0];

    expect(decision.status).toBe('placed');
    if (decision.status !== 'placed') throw new Error('expected a placed label');
    expect(decision.leader.attachment).toBe('top');
    expect(decision.leader.elbow.x).toBe(decision.leader.end.x);
    expect(decision.leader.elbow.y).toBeLessThan(decision.leader.end.y);
  });

  it('lands a top or bottom tick under the anchor instead of the text center', () => {
    const bounds = { xMin: 100, xMax: 160, yMin: 40, yMax: 52 };
    expect(verticalTickX(130, bounds)).toBe(130);
    expect(verticalTickX(112, bounds)).toBe(112);
    expect(verticalTickX(20, bounds)).toBe(100 + FLOATING_LABEL_TICK_EDGE_INSET_PX);
    expect(verticalTickX(300, bounds)).toBe(160 - FLOATING_LABEL_TICK_EDGE_INSET_PX);
    expect(verticalTickX(999, { xMin: 100, xMax: 104, yMin: 40, yMax: 52 })).toBe(102);

    const slanted = plan([candidate(1, 200, { outward: { x: 0.6, y: -0.8 } })], {
      width: 400,
      height: 300,
      preloadMargin: 80,
    }).decisions[0];
    expect(slanted.status).toBe('placed');
    if (slanted.status !== 'placed') throw new Error('expected a placed label');
    expect(slanted.leader.attachment).toBe('bottom');
    expect(slanted.x).toBeGreaterThan(200 + 5);
    expect(slanted.leader.end.x).toBe(200);
    expect(slanted.leader.elbow.x).toBe(200);
    const toAnchor = {
      x: slanted.leader.start.x - slanted.leader.elbow.x,
      y: slanted.leader.start.y - slanted.leader.elbow.y,
    };
    const toEnd = {
      x: slanted.leader.end.x - slanted.leader.elbow.x,
      y: slanted.leader.end.y - slanted.leader.elbow.y,
    };
    expect(toAnchor.x * toEnd.x + toAnchor.y * toEnd.y).toBeLessThanOrEqual(0);

    const centered = plan([candidate(1, 200)], { width: 400, height: 300, preloadMargin: 80 })
      .decisions[0];
    if (centered.status !== 'placed') throw new Error('expected a placed label');
    expect(centered.leader.end.x).toBe(centered.x);
  });

  it('knocks leader segments out only where they cross label text bounds', () => {
    const template = plan([candidate(1, 200)], {
      width: 400,
      height: 300,
      preloadMargin: 80,
    }).decisions[0];
    expect(template.status).toBe('placed');
    if (template.status !== 'placed') throw new Error('expected a placed label');

    const crossing: FloatingAnnotationLabelPlacedDecision = {
      ...template,
      featureId: 1,
      bounds: { xMin: 120, xMax: 140, yMin: 40, yMax: 60 },
      bodyBounds: { xMin: 20, xMax: 30, yMin: 40, yMax: 60 },
      leader: {
        attachment: 'left',
        start: { x: 0, y: 50 },
        elbow: { x: 92, y: 50 },
        end: { x: 100, y: 50 },
        length: 100,
      },
    };
    const maskingLabel: FloatingAnnotationLabelPlacedDecision = {
      ...template,
      featureId: 2,
      bounds: { xMin: 40, xMax: 60, yMin: 40, yMax: 60 },
      bodyBounds: { xMin: 70, xMax: 80, yMin: 40, yMax: 60 },
      leader: {
        attachment: 'left',
        start: { x: 70, y: 70 },
        elbow: { x: 92, y: 70 },
        end: { x: 100, y: 70 },
        length: 30,
      },
    };

    const crossingSegments = floatingAnnotationVisibleLeaderSegments(
      [crossing, maskingLabel],
      0
    ).filter(({ featureId }) => featureId === crossing.featureId);

    expect(crossingSegments).toStrictEqual([
      { featureId: 1, start: { x: 0, y: 50 }, end: { x: 40, y: 50 } },
      { featureId: 1, start: { x: 60, y: 50 }, end: { x: 92, y: 50 } },
      { featureId: 1, start: { x: 92, y: 50 }, end: { x: 100, y: 50 } },
    ]);
  });

  it('never masks a leader merely because it crosses annotation body geometry', () => {
    const template = plan([candidate(1, 200)], {
      width: 400,
      height: 300,
      preloadMargin: 80,
    }).decisions[0];
    expect(template.status).toBe('placed');
    if (template.status !== 'placed') throw new Error('expected a placed label');
    const bodyCrossing: FloatingAnnotationLabelPlacedDecision = {
      ...template,
      bounds: { xMin: 120, xMax: 140, yMin: 40, yMax: 60 },
      bodyBounds: { xMin: 40, xMax: 60, yMin: 40, yMax: 60 },
      leader: {
        attachment: 'left',
        start: { x: 0, y: 50 },
        elbow: { x: 92, y: 50 },
        end: { x: 100, y: 50 },
        length: 100,
      },
    };

    expect(floatingAnnotationVisibleLeaderSegments([bodyCrossing], 0)).toStrictEqual([
      { featureId: 1, start: { x: 0, y: 50 }, end: { x: 92, y: 50 } },
      { featureId: 1, start: { x: 92, y: 50 }, end: { x: 100, y: 50 } },
    ]);
  });

  it('packs nearby labels into bounded deterministic rows without overlaps', () => {
    const result = plan(
      [candidate(1, 180), candidate(2, 195), candidate(3, 210), candidate(4, 225)],
      { width: 400, height: 300, preloadMargin: 80 }
    );
    const placed = result.decisions.filter((decision) => decision.status === 'placed');

    expect(placed).toHaveLength(4);
    for (let left = 0; left < placed.length; left++) {
      for (let right = left + 1; right < placed.length; right++) {
        const a = placed[left].bounds;
        const b = placed[right].bounds;
        expect(a.xMin < b.xMax && a.xMax > b.xMin && a.yMin < b.yMax && a.yMax > b.yMin).toBe(
          false
        );
      }
      expect(placed[left].leader.length).toBeLessThanOrEqual(FLOATING_LABEL_MAX_LEADER_PX);
    }
  });

  it('jointly searches fixed tangent offsets and rows instead of dropping a dense locus', () => {
    const crowded = Array.from({ length: 8 }, (_, index) =>
      candidate(index + 1, 200, {
        placementOptions: [0, -1, 1, -2, 2, -3, 3, -4, 4].map((tangentStep) => ({
          tangentStep,
          layoutCenterBp: 200 + tangentStep * 18,
          outwardClearance: 0,
          outwardRail: -20,
        })),
      })
    );
    const assignmentPlan = precomputeFloatingAnnotationLabelAssignments(crowded, {
      pixelsPerBp: 1,
      genomeLength: 1_000,
      circular: false,
    });

    expect(assignmentPlan.assignedCount).toBe(crowded.length);
    expect([...assignmentPlan.assignments.values()].some((slot) => slot.tangentStep !== 0)).toBe(
      true
    );
    expect(
      new Set([...assignmentPlan.assignments.values()].map((slot) => JSON.stringify(slot))).size
    ).toBe(crowded.length);
  });

  it('bounds displacement work when a dense locus has more labels than legal slots', () => {
    const placementOptions = [0, -1, 1, -2, 2, -3, 3, -4, 4].map((tangentStep) => ({
      tangentStep,
      layoutCenterBp: 200 + tangentStep * 18,
      outwardClearance: 0,
      outwardRail: -20,
    }));
    const overCapacity = Array.from({ length: 37 }, (_, index) =>
      candidate(index + 1, 200, {
        textWidth: 10,
        placementOptions,
      })
    );
    const assignmentPlan = precomputeFloatingAnnotationLabelAssignments(overCapacity, {
      pixelsPerBp: 1,
      genomeLength: 1_000,
      circular: false,
    });

    expect(assignmentPlan.assignedCount).toBe(36);
    expect(assignmentPlan.searchBudgetExhaustionCount).toBe(1);
    expect(assignmentPlan.searchStepCount).toBeLessThan(4_000);
  });

  it('displaces an earlier flexible assignment for a later constrained feature', () => {
    const flexible = candidate(1, 200, {
      textWidth: 20,
      placementOptions: [
        { tangentStep: 0, layoutCenterBp: 200, outwardClearance: 92, outwardRail: -112 },
        { tangentStep: -2, layoutCenterBp: 164, outwardClearance: 92, outwardRail: -112 },
      ],
    });
    const constrained = candidate(2, 200, {
      textWidth: 20,
      placementOptions: [
        { tangentStep: 0, layoutCenterBp: 200, outwardClearance: 92, outwardRail: -112 },
      ],
    });
    const assignmentPlan = precomputeFloatingAnnotationLabelAssignments([flexible, constrained], {
      pixelsPerBp: 1,
      genomeLength: 1_000,
      circular: false,
    });

    expect(assignmentPlan.assignedCount).toBe(2);
    expect(assignmentPlan.assignments.get(1)?.tangentStep).toBe(-2);
    expect(assignmentPlan.assignments.get(2)?.tangentStep).toBe(0);
  });

  it('separates lane/row pairs whose projected radial bands overlap', () => {
    const innerLaneA = candidate(1, 200, {
      textWidth: 24,
      textHeight: 14,
      placementOptions: [
        { tangentStep: 0, layoutCenterBp: 200, outwardClearance: 0, outwardRail: -94 },
      ],
    });
    const innerLaneB = candidate(2, 200, {
      textWidth: 24,
      textHeight: 14,
      placementOptions: [
        { tangentStep: 0, layoutCenterBp: 200, outwardClearance: 0, outwardRail: -94 },
      ],
    });
    const outerLane = candidate(3, 200, {
      textWidth: 24,
      textHeight: 14,
      placementOptions: [
        { tangentStep: 0, layoutCenterBp: 200, outwardClearance: 0, outwardRail: -112 },
      ],
    });
    const assignments = precomputeFloatingAnnotationLabelAssignments(
      [innerLaneA, innerLaneB, outerLane],
      { pixelsPerBp: 1, genomeLength: 1_000, circular: false }
    ).assignments;

    expect(assignments.get(1)?.outwardRow).toBe(0);
    expect(assignments.get(2)?.outwardRow).toBe(1);
    expect(assignments.get(3)?.outwardRow).not.toBe(0);
  });

  it('records an auditable fixed-slot blocker without searching a new position', () => {
    const blocked = plan([candidate(1, 200)], { width: 400, height: 300, preloadMargin: 0 }, [
      { xMin: 0, xMax: 400, yMin: 0, yMax: 190, owner: 'occupied-surface' },
    ]).decisions[0];

    expect(blocked).toMatchObject({
      featureId: 1,
      status: 'rejected',
      reason: 'blocked-fixed-slot',
    });
    if (blocked.status !== 'rejected') throw new Error('expected a rejected label');
    expect(blocked.testedSlotCount).toBeGreaterThan(0);
    expect(blocked.blockers).toContain('occupied-surface');
  });

  it('plans labels in a fixed offscreen runway so they exist before scrolling onscreen', () => {
    const result = plan([candidate(1, -42)], {
      width: 400,
      height: 300,
      preloadMargin: 96,
    });

    expect(result.decisions[0]).toMatchObject({ featureId: 1, status: 'placed' });
  });

  it('keeps unblocked slots fixed and moves a blocked label to a free slot instead of hiding it', () => {
    const source = [candidate(1, 180), candidate(2, 195), candidate(3, 210)];
    const assignmentPlan = precomputeFloatingAnnotationLabelAssignments(source, {
      pixelsPerBp: 1,
      genomeLength: 1_000,
      circular: false,
    });
    const viewport = { width: 400, height: 300, preloadMargin: 80 };
    const first = planFloatingAnnotationLabels(source, assignmentPlan.assignments, viewport, []);
    const firstPlaced = first.decisions.filter((decision) => decision.status === 'placed');
    expect(firstPlaced).toHaveLength(3);
    const obstacleTarget = firstPlaced[0];
    if (obstacleTarget.status !== 'placed') throw new Error('expected a placed label');
    const obstacle = {
      ...obstacleTarget.bounds,
      owner: 'transient-obstacle',
    };
    const second = planFloatingAnnotationLabels(source, assignmentPlan.assignments, viewport, [
      obstacle,
    ]);

    for (const decision of second.decisions) {
      expect(decision.status, `feature ${decision.featureId}`).toBe('placed');
      if (decision.status !== 'placed') continue;
      const before = first.decisions.find((item) => item.featureId === decision.featureId);
      if (before?.status !== 'placed') throw new Error('expected a placed label');
      const blockedBefore =
        before.bounds.xMin < obstacle.xMax &&
        before.bounds.xMax > obstacle.xMin &&
        before.bounds.yMin < obstacle.yMax &&
        before.bounds.yMax > obstacle.yMin;
      if (blockedBefore) {
        expect(decision.slot).not.toStrictEqual(before.slot);
        expect(
          decision.bounds.xMin < obstacle.xMax &&
            decision.bounds.xMax > obstacle.xMin &&
            decision.bounds.yMin < obstacle.yMax &&
            decision.bounds.yMax > obstacle.yMin
        ).toBe(false);
      } else {
        expect(decision.slot).toStrictEqual(before.slot);
      }
    }
  });

  it('blocks a label only where an obstacle outline is drawn, not across its empty bounding box', () => {
    const label = candidate(1, 200);
    const assignments = precomputeFloatingAnnotationLabelAssignments([label], {
      pixelsPerBp: 1,
      genomeLength: 1_000,
      circular: false,
    }).assignments;
    const viewport = { width: 400, height: 300, preloadMargin: 0 };
    const free = planFloatingAnnotationLabels([label], assignments, viewport, []).decisions[0];
    if (free.status !== 'placed') throw new Error('expected a placed label');
    const corner = {
      xMin: free.bounds.xMin - 40,
      xMax: free.bounds.xMax + 40,
      yMin: free.bounds.yMin - 40,
      yMax: free.bounds.yMax + 40,
    };
    const cornerBand = [
      corner.xMin,
      corner.yMin,
      corner.xMin + 4,
      corner.yMin,
      corner.xMin + 4,
      corner.yMax - 4,
      corner.xMax,
      corner.yMax - 4,
      corner.xMax,
      corner.yMax,
      corner.xMin,
      corner.yMax,
    ];
    const throughBox = planFloatingAnnotationLabels([label], assignments, viewport, [
      { ...corner, owner: 'body:9', pts: cornerBand },
    ]).decisions[0];
    if (throughBox.status !== 'placed') throw new Error('expected a placed label');
    expect(throughBox.slot).toStrictEqual(free.slot);
  });

  it('keeps two neighbouring circular labels visible through a full rotation', () => {
    const genomeLength = 2686;
    const radius = 300;
    const center = { x: 800, y: 500 };
    const pixelsPerBp = (2 * Math.PI * radius) / genomeLength;
    const descriptor = (featureId: number, centerBp: number, textWidth: number) => ({
      featureId,
      text: `feature-${featureId}`,
      stableOrder: [featureId, featureId] as const,
      sequenceCenterBp: centerBp,
      outwardSide: 1 as const,
      textWidth,
      textHeight: 15,
      placementOptions: [0, -1, 1, -2, 2, -3, 3, -4, 4].map((tangentStep) => ({
        tangentStep,
        layoutCenterBp: centerBp + (tangentStep * 18) / pixelsPerBp,
        outwardClearance: 0,
        outwardRail: 0,
      })),
    });
    const descriptors = [descriptor(1, 1000, 80), descriptor(2, 1010, 60)];
    const assignments = precomputeFloatingAnnotationLabelAssignments(descriptors, {
      pixelsPerBp,
      genomeLength,
      circular: true,
    }).assignments;
    for (let degrees = 0; degrees < 360; degrees += 5) {
      const rotationBp = (degrees / 360) * genomeLength;
      const frame = planFloatingAnnotationLabels(
        descriptors.map((item) => {
          const theta =
            ((item.sequenceCenterBp + rotationBp) / genomeLength) * 2 * Math.PI - Math.PI / 2;
          const outward = { x: Math.cos(theta), y: Math.sin(theta) };
          const anchor = { x: center.x + radius * outward.x, y: center.y + radius * outward.y };
          return {
            ...item,
            anchor,
            outward,
            bodyBounds: {
              xMin: anchor.x - 1,
              xMax: anchor.x + 1,
              yMin: anchor.y - 1,
              yMax: anchor.y + 1,
            },
            normalScale: 1,
          };
        }),
        assignments,
        { width: 1600, height: 1000, preloadMargin: 800 }
      );
      expect(
        frame.decisions.filter((decision) => decision.status !== 'placed').map((d) => d.featureId),
        `${degrees} degrees`
      ).toEqual([]);
    }
  });

  it('treats the beginning and end of a circular genome as adjacent during assignment', () => {
    const nearStart = candidate(1, 10, { sequenceCenterBp: 10 });
    const nearEnd = candidate(2, 990, { sequenceCenterBp: 990 });
    const assignments = precomputeFloatingAnnotationLabelAssignments([nearStart, nearEnd], {
      pixelsPerBp: 1,
      genomeLength: 1_000,
      circular: true,
    }).assignments;

    expect(assignments.get(1)?.outwardRow).toBe(0);
    expect(assignments.get(2)?.outwardRow).toBe(1);
  });
});
