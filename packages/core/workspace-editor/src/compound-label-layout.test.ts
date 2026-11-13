import { describe, expect, it } from 'vitest';
import { placeCompoundLabels } from './compound-label-layout';

describe('compound CDS labels', () => {
  it.each([120, 300, 800])(
    'keeps long names and clustered narrow exon pills inside %i px without collisions',
    (width) => {
      const labels = placeCompoundLabels(
        [
          { x: 50, width: 600, kind: 'name' },
          { x: 55, width: 110, kind: 'exon1' },
          { x: 60, width: 115, kind: 'exon2' },
          { x: 480, width: 120, kind: 'exon3' },
        ],
        50,
        50 + width
      );
      expect(labels.map((l) => l.kind)).toEqual(['name', 'exon1', 'exon2', 'exon3']);
      for (const [i, label] of labels.entries()) {
        expect(label.x).toBeGreaterThanOrEqual(50 - 1e-8);
        expect(label.x + label.width).toBeLessThanOrEqual(50 + width + 1e-8);
        if (i) expect(label.x).toBeGreaterThanOrEqual(labels[i - 1].x + labels[i - 1].width);
      }
    }
  );
  it('retains separated exon anchors when space exists', () => {
    expect(
      placeCompoundLabels(
        [
          { x: 50, width: 100 },
          { x: 400, width: 100 },
        ],
        50,
        800
      ).map((l) => l.x)
    ).toEqual([50, 400]);
  });
});

it('contains every semantic pill even when the entire band is narrower than its gaps', () => {
  const result = placeCompoundLabels(
    [
      { x: 1, width: 20 },
      { x: 1, width: 30 },
      { x: 1, width: 20 },
    ],
    1,
    4
  );
  expect(result).toHaveLength(3);
  for (const pill of result) {
    expect(pill.x).toBeGreaterThanOrEqual(1);
    expect(pill.x + pill.width).toBeLessThanOrEqual(4.00001);
  }
});
