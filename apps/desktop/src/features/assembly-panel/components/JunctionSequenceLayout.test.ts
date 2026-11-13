// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { calculateAlignedJunctionSequenceLayout } from './JunctionSequenceLayout';

describe('calculateAlignedJunctionSequenceLayout', () => {
  it('aligns every row on the same molecular junction coordinate', () => {
    const layout = calculateAlignedJunctionSequenceLayout([
      { pxBeforeJunction: 0, pxTotal: 180 },
      { pxBeforeJunction: 68, pxTotal: 210 },
      { pxBeforeJunction: 34, pxTotal: 140 },
    ]);

    const junctionXs = [0, 68, 34].map(
      (pxBeforeJunction, index) => layout.alignOffsets[index] + pxBeforeJunction
    );

    expect(new Set(junctionXs).size).toBe(1);
    expect(layout.sharedSvgWidth).toBeGreaterThan(210);
  });
});
