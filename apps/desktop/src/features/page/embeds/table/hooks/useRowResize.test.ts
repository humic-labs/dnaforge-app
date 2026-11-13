// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { autoFitWidthFromMeasurements } from './useRowResize';

const measure = (t: string) => t.length * 8;

describe('autoFitWidthFromMeasurements (column auto-fit)', () => {
  it('fits to the widest cell + padding', () => {
    expect(autoFitWidthFromMeasurements(['a', 'bb', 'elephant'], measure, { minWidth: 40 })).toBe(
      88
    );
  });
  it('uses the longest SINGLE line for wrapped cells', () => {
    expect(autoFitWidthFromMeasurements(['short\nverylongline'], measure, { minWidth: 40 })).toBe(
      120
    );
  });
  it('clamps to minWidth for narrow content', () => {
    expect(autoFitWidthFromMeasurements(['a'], measure, { minWidth: 40 })).toBe(40);
    expect(autoFitWidthFromMeasurements([''], measure, { minWidth: 40 })).toBe(40);
  });
  it('clamps to maxWidth for huge content', () => {
    const huge = 'x'.repeat(200);
    expect(autoFitWidthFromMeasurements([huge], measure, { minWidth: 40, maxWidth: 300 })).toBe(
      300
    );
  });
});
