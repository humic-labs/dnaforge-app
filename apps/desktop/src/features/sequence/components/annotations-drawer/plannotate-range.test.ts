// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { displayRangeToWire } from './plannotate-range';

describe('displayRangeToWire', () => {
  it('converts 1-indexed inclusive display to 0-indexed half-open wire', () => {
    expect(displayRangeToWire('100', '150', 3000)).toEqual({ start: 99, end: 150 });
  });

  it('handles a single-base selection', () => {
    expect(displayRangeToWire('1', '1', 3000)).toEqual({ start: 0, end: 1 });
  });

  it('handles a full-length selection', () => {
    expect(displayRangeToWire('1', '3000', 3000)).toEqual({ start: 0, end: 3000 });
  });

  it('returns null for empty or partial fields (→ full sequence)', () => {
    expect(displayRangeToWire('', '', 3000)).toBeNull();
    expect(displayRangeToWire('100', '', 3000)).toBeNull();
    expect(displayRangeToWire('', '150', 3000)).toBeNull();
  });

  it('returns null for non-numeric input', () => {
    expect(displayRangeToWire('abc', '150', 3000)).toBeNull();
  });

  it('returns null for start < 1 (fields are 1-indexed)', () => {
    expect(displayRangeToWire('0', '150', 3000)).toBeNull();
    expect(displayRangeToWire('-5', '150', 3000)).toBeNull();
  });

  it('returns null when end < start', () => {
    expect(displayRangeToWire('150', '100', 3000)).toBeNull();
  });

  it('returns null when end exceeds sequence length', () => {
    expect(displayRangeToWire('100', '5000', 3000)).toBeNull();
  });
});
