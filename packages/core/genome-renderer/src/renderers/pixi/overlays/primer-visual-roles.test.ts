import { describe, expect, it } from 'vitest';
import type { Primer } from '../../../types';
import {
  CLEAVED_COLOR,
  OVERHANG_FILL_ALPHA,
  SPACER_FILL_ALPHA,
  SYNTHETIC_SCAR_COLOR,
  computePrimerVisualPlan,
} from './primer-visual-roles';

function primer(overrides: Partial<Primer>): Primer {
  return {
    id: 'primer',
    renderId: 1,
    name: 'Primer',
    start: 100,
    end: 120,
    direction: 'forward',
    color: 0xd97706,
    bases: 'AACCGGTTAACCGGTTAACC',
    ...overrides,
  };
}

function fillSummary(plan: ReturnType<typeof computePrimerVisualPlan>) {
  return plan.fillSegments.map(({ role, startBase, endBase, strokeStyle, borderMode }) => [
    role,
    startBase,
    endBase,
    strokeStyle,
    borderMode,
  ]);
}

function textSummary(plan: ReturnType<typeof computePrimerVisualPlan>) {
  return plan.textSegments.map(({ role, startBase, endBase, boldText, textColor }) => [
    role,
    startBase,
    endBase,
    !!boldText,
    textColor,
  ]);
}

describe('computePrimerVisualPlan', () => {
  it('splits a forward Gibson primer into Canvas-parity tail, spacer, and PBS fill segments', () => {
    const plan = computePrimerVisualPlan(
      primer({
        overhangLength: 8,
        spacerLength: 3,
        bases: 'A'.repeat(20),
      }),
      20
    );

    expect(fillSummary(plan)).toEqual([
      ['tail', 0, 5, 'dotted', 'open-right'],
      ['spacer', 5, 8, 'dotted', 'horizontal'],
      ['pbs', 8, 20, 'solid', 'primer-forward'],
    ]);
    expect(plan.fillSegments.find((segment) => segment.role === 'spacer')?.alpha).toBe(
      SPACER_FILL_ALPHA
    );
  });

  it('splits a reverse Gibson primer in visual source order without moving the spacer to the wrong side', () => {
    const plan = computePrimerVisualPlan(
      primer({
        direction: 'reverse',
        overhangLength: 8,
        spacerLength: 3,
        bases: 'A'.repeat(20),
      }),
      20
    );

    expect(fillSummary(plan)).toEqual([
      ['pbs', 0, 12, 'solid', 'primer-reverse'],
      ['spacer', 12, 15, 'dotted', 'horizontal'],
      ['tail', 15, 20, 'dotted', 'open-left'],
    ]);
  });

  it('keeps a forward Golden Gate cleaved background continuous and makes every 4 bp scar letter red', () => {
    const plan = computePrimerVisualPlan(
      primer({
        overhangLength: 14,
        cutPositionInOverhang: 4,
        recognitionStart: 1,
        recognitionEnd: 3,
        cognate4bpLength: 2,
        synthetic4bpSpacerLength: 1,
        spacerLength: 2,
        bases: 'A'.repeat(24),
      }),
      24
    );

    expect(fillSummary(plan)).toEqual([
      ['cleaved', 0, 4, 'dotted', 'open-right'],
      ['scar-synthetic', 4, 5, 'dotted', 'horizontal'],
      ['scar-synthetic-spacer', 5, 6, 'dotted', 'horizontal'],
      ['scar-cognate', 6, 8, 'solid', 'horizontal'],
      ['tail', 8, 12, 'dotted', 'horizontal'],
      ['spacer', 12, 14, 'dotted', 'horizontal'],
      ['pbs', 14, 24, 'solid', 'primer-forward'],
    ]);
    expect(plan.fillSegments.some((segment) => segment.role === 'enzyme-site')).toBe(false);
    expect(plan.fillSegments.find((segment) => segment.role === 'cleaved')).toMatchObject({
      fillColor: CLEAVED_COLOR,
      alpha: SPACER_FILL_ALPHA,
    });
    expect(plan.fillSegments.find((segment) => segment.role === 'spacer')).toMatchObject({
      alpha: OVERHANG_FILL_ALPHA,
    });
    expect(textSummary(plan)).toEqual([
      ['cleaved', 0, 1, false, CLEAVED_COLOR],
      ['cleaved', 1, 3, true, CLEAVED_COLOR],
      ['cleaved', 3, 4, false, CLEAVED_COLOR],
      ['scar-marker', 4, 8, true, SYNTHETIC_SCAR_COLOR],
      ['tail', 8, 12, false, 0xd97706],
      ['spacer', 12, 14, false, CLEAVED_COLOR],
      ['pbs', 14, 24, false, 0x8b5cf6],
    ]);
  });

  it('keeps a reverse Golden Gate cleaved background continuous and orders retained backgrounds like Canvas2D', () => {
    const plan = computePrimerVisualPlan(
      primer({
        direction: 'reverse',
        overhangLength: 14,
        cutPositionInOverhang: 4,
        recognitionStart: 1,
        recognitionEnd: 3,
        cognate4bpLength: 2,
        synthetic4bpSpacerLength: 1,
        spacerLength: 2,
        bases: 'A'.repeat(24),
      }),
      24
    );

    expect(fillSummary(plan)).toEqual([
      ['pbs', 0, 10, 'solid', 'primer-reverse'],
      ['spacer', 10, 12, 'dotted', 'horizontal'],
      ['tail', 12, 16, 'dotted', 'horizontal'],
      ['scar-cognate', 16, 18, 'solid', 'horizontal'],
      ['scar-synthetic-spacer', 18, 19, 'dotted', 'horizontal'],
      ['scar-synthetic', 19, 20, 'dotted', 'horizontal'],
      ['cleaved', 20, 24, 'dotted', 'open-left'],
    ]);
    expect(plan.fillSegments.some((segment) => segment.role === 'enzyme-site')).toBe(false);
    expect(textSummary(plan)).toEqual([
      ['pbs', 0, 10, false, 0x8b5cf6],
      ['spacer', 10, 12, false, CLEAVED_COLOR],
      ['tail', 12, 16, false, 0xd97706],
      ['scar-marker', 16, 20, true, SYNTHETIC_SCAR_COLOR],
      ['cleaved', 20, 21, false, CLEAVED_COLOR],
      ['cleaved', 21, 23, true, CLEAVED_COLOR],
      ['cleaved', 23, 24, false, CLEAVED_COLOR],
    ]);
  });

  it('emits only a scar-marker role for marker-only Golden Gate entries', () => {
    const plan = computePrimerVisualPlan(
      primer({
        isScarMarkerOnly: true,
        overhangLength: 4,
        bases: 'A'.repeat(4),
      }),
      4
    );

    expect(fillSummary(plan)).toEqual([['scar-marker', 0, 4, 'none', 'none']]);
    expect(textSummary(plan)).toEqual([['scar-marker', 0, 4, true, SYNTHETIC_SCAR_COLOR]]);
  });
});
