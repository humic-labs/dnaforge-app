// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { suggestedStackedMapPaneHeight } from './stacked-map-pane-height';

const base = {
  viewportHeight: 820,
  sequenceLength: 1_000,
  circular: true,
  primers: 0,
};

describe('initial stacked map pane height', () => {
  it('leaves room for the linear viewer instead of splitting the screen evenly', () => {
    expect(suggestedStackedMapPaneHeight({ ...base, features: [] })).toBeLessThan(410);
    expect(suggestedStackedMapPaneHeight({ ...base, viewportHeight: 0, features: [] })).toBe(
      suggestedStackedMapPaneHeight({ ...base, features: [] })
    );
  });

  it('allocates more height when overlapping annotation labels need room', () => {
    const sparse = suggestedStackedMapPaneHeight({
      ...base,
      features: [{ start: 100, end: 200 }],
    });
    const crowded = suggestedStackedMapPaneHeight({
      ...base,
      features: [
        { start: 100, end: 300 },
        { start: 150, end: 350 },
        { start: 175, end: 400 },
        { start: 200, end: 450 },
      ],
    });

    expect(crowded).toBeGreaterThan(sparse);
    expect(crowded).toBeLessThan(base.viewportHeight - 96);
  });

  it('caps the map pane so the sequence retains its minimum height', () => {
    expect(
      suggestedStackedMapPaneHeight({
        ...base,
        viewportHeight: 360,
        features: Array.from({ length: 20 }, () => ({ start: 100, end: 500 })),
      })
    ).toBeLessThanOrEqual(260);
  });
});
