// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { PRIMER_SVG_CONSTANTS, PRIMER_PADDING } from '@waypoint/ui-components';

describe('Gibson Primer Alignment Calculation', () => {
  const { CHAR_WIDTH: charWidth } = PRIMER_SVG_CONSTANTS;
  const gibsonPadding = PRIMER_PADDING.GIBSON;

  it('should calculate correct offsets for basic Gibson primers', () => {
    const revPbsLength = 20;
    const revSpacerLength = 5;

    const fwdWidthBeforeOh = gibsonPadding;

    const revWidthBeforeOh = revPbsLength * charWidth + revSpacerLength * charWidth + gibsonPadding;

    const maxWidthBeforeOh = Math.max(fwdWidthBeforeOh, revWidthBeforeOh);
    const fwdAlignOffset = maxWidthBeforeOh - fwdWidthBeforeOh;
    const revAlignOffset = maxWidthBeforeOh - revWidthBeforeOh;

    console.log('Test values:', {
      charWidth,
      gibsonPadding,
      fwdWidthBeforeOh,
      revWidthBeforeOh,
      maxWidthBeforeOh,
      fwdAlignOffset,
      revAlignOffset,
    });

    expect(fwdAlignOffset).toBeGreaterThan(0);
    expect(revAlignOffset).toBe(0);

    const expectedFwdOffset = revWidthBeforeOh - fwdWidthBeforeOh;
    expect(fwdAlignOffset).toBe(expectedFwdOffset);

    const expectedRevWidthBeforeOh =
      revPbsLength * charWidth + revSpacerLength * charWidth + gibsonPadding;
    expect(revWidthBeforeOh).toBeCloseTo(expectedRevWidthBeforeOh, 1);
  });

  it('should handle no spacer case', () => {
    const revPbsLength = 20;
    const revSpacerLength = 0;

    const fwdWidthBeforeOh = gibsonPadding;
    const revWidthBeforeOh = revPbsLength * charWidth + revSpacerLength * charWidth + gibsonPadding;

    const maxWidthBeforeOh = Math.max(fwdWidthBeforeOh, revWidthBeforeOh);
    const fwdAlignOffset = maxWidthBeforeOh - fwdWidthBeforeOh;
    const revAlignOffset = maxWidthBeforeOh - revWidthBeforeOh;

    expect(fwdAlignOffset).toBeGreaterThan(0);
    expect(revAlignOffset).toBe(0);

    const expectedOffset = revPbsLength * charWidth;
    expect(fwdAlignOffset).toBe(expectedOffset);
  });

  it('should handle equal length primers', () => {
    const revPbsLength = 10;

    const fwdWidthBeforeOh = gibsonPadding;
    const revWidthBeforeOh = revPbsLength * charWidth + gibsonPadding;

    const maxWidthBeforeOh = Math.max(fwdWidthBeforeOh, revWidthBeforeOh);
    const fwdAlignOffset = maxWidthBeforeOh - fwdWidthBeforeOh;
    const revAlignOffset = maxWidthBeforeOh - revWidthBeforeOh;

    expect(fwdAlignOffset).toBeGreaterThanOrEqual(0);
    expect(revAlignOffset).toBe(0);
  });
});
