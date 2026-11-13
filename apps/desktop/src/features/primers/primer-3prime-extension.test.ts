// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { computeBindingPositions, templateExtensionBase } from './primer-3prime-extension';

const REF = 'ACGTACGTACGT';

describe('computeBindingPositions', () => {
  it('forward ext=0 reproduces the original "3\' fixed, grow 5\'" geometry', () => {
    expect(
      computeBindingPositions({
        direction: 'forward',
        length: 8,
        threePrimeExt: 0,
        initialBindingStart: 0,
        initialBindingEnd: 8,
      })
    ).toEqual({ start: 0, end: 8 });
  });

  it("forward extending the 3' end moves the 3' anchor out while the 5' end stays put", () => {
    expect(
      computeBindingPositions({
        direction: 'forward',
        length: 10,
        threePrimeExt: 2,
        initialBindingStart: 0,
        initialBindingEnd: 8,
      })
    ).toEqual({ start: 0, end: 10 });
  });

  it("reverse ext=0 reproduces original geometry (3' at the low, inclusive end)", () => {
    expect(
      computeBindingPositions({
        direction: 'reverse',
        length: 6,
        threePrimeExt: 0,
        initialBindingStart: 2,
        initialBindingEnd: 8,
      })
    ).toEqual({ start: 2, end: 8 });
  });

  it("reverse extending the 3' end moves the low anchor down; the 5' end (high) stays put", () => {
    expect(
      computeBindingPositions({
        direction: 'reverse',
        length: 7,
        threePrimeExt: 1,
        initialBindingStart: 2,
        initialBindingEnd: 8,
      })
    ).toEqual({ start: 1, end: 8 });
  });

  it("forward wraps the 3' anchor across the origin on circular sequences", () => {
    expect(
      computeBindingPositions({
        direction: 'forward',
        length: 5,
        threePrimeExt: 2,
        initialBindingStart: 8,
        initialBindingEnd: 11,
        circular: true,
        sequenceLength: 12,
      })
    ).toEqual({ start: 8, end: 1 });
  });
});

describe('templateExtensionBase', () => {
  it.each([
    ['forward', 2, 4, 'aCgt', 'aC'],
    ['reverse', 2, 4, 'aCgt', 'Gt'],
  ] as const)(
    'preserves template case for %s extension',
    (direction, initialBindingStart, initialBindingEnd, reference, expected) => {
      const extension = [0, 1]
        .map((threePrimeExt) =>
          templateExtensionBase({
            direction,
            initialBindingStart,
            initialBindingEnd,
            reference,
            threePrimeExt,
            circular: true,
            sequenceLength: reference.length,
          })
        )
        .join('');
      expect(extension).toBe(expected);
    }
  );

  it("forward pulls the template base at the current exclusive 3' end", () => {
    const base = (ext: number) =>
      templateExtensionBase({
        direction: 'forward',
        threePrimeExt: ext,
        initialBindingStart: 0,
        initialBindingEnd: 8,
        reference: REF,
      });
    expect(base(0)).toBe('A');
    expect(base(1)).toBe('C');
  });

  it("reverse pulls the COMPLEMENT of the template base just upstream of the 3' start", () => {
    const base = (ext: number) =>
      templateExtensionBase({
        direction: 'reverse',
        threePrimeExt: ext,
        initialBindingStart: 2,
        initialBindingEnd: 8,
        reference: REF,
      });
    expect(base(0)).toBe('G');
    expect(base(1)).toBe('T');
  });

  it('returns null at the linear-sequence boundary (no more template to pull)', () => {
    expect(
      templateExtensionBase({
        direction: 'forward',
        threePrimeExt: 1,
        initialBindingStart: 4,
        initialBindingEnd: 11,
        reference: REF,
      })
    ).toBeNull();
  });

  it('wraps across the origin on circular sequences instead of returning null', () => {
    expect(
      templateExtensionBase({
        direction: 'forward',
        threePrimeExt: 1,
        initialBindingStart: 4,
        initialBindingEnd: 11,
        reference: REF,
        circular: true,
        sequenceLength: 12,
      })
    ).toBe('A');
  });
});
