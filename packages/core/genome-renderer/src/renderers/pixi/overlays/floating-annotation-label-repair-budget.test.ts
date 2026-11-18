// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  FLOATING_LABEL_TANGENT_STEPS,
  planFloatingAnnotationLabels,
  type FloatingAnnotationLabelCandidate,
} from './floating-annotation-label-layout';

describe('floating label frame repair budget', () => {
  it('does not prepare more repair slots after the frame search budget is spent', () => {
    let finalCandidateOptionReads = 0;
    const candidates = Array.from({ length: 128 }, (_, index): FloatingAnnotationLabelCandidate => {
      const options = FLOATING_LABEL_TANGENT_STEPS.map((tangentStep) => ({
        tangentStep,
        layoutCenterBp: index * 100,
        outwardClearance: 0,
        outwardRail: -7,
      }));
      return {
        featureId: index + 1,
        text: `gene-${index + 1}`,
        stableOrder: [index, index + 1],
        sequenceCenterBp: index * 100,
        outwardSide: -1,
        textWidth: 60,
        textHeight: 14,
        get placementOptions() {
          if (index === 127) finalCandidateOptionReads += 1;
          return options;
        },
        anchor: { x: 200, y: 150 },
        outward: { x: 0, y: -1 },
        normalScale: 1,
        bodyBounds: { xMin: 197, xMax: 203, yMin: 143, yMax: 157 },
      };
    });

    const result = planFloatingAnnotationLabels(
      candidates,
      new Map(),
      { width: 400, height: 300, preloadMargin: 80 },
      [{ owner: 'dense-body', xMin: -1_000, xMax: 2_000, yMin: -1_000, yMax: 2_000 }]
    );

    expect(result.decisions).toHaveLength(candidates.length);
    expect(result.decisions.reduce((total, decision) => total + decision.testedSlotCount, 0)).toBe(
      512
    );
    expect(result.decisions.at(-1)).toMatchObject({
      featureId: 128,
      status: 'rejected',
      reason: 'no-assignment',
      testedSlotCount: 0,
    });
    expect(finalCandidateOptionReads).toBe(1);
  });
});
