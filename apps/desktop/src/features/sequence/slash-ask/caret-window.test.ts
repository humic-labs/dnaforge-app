// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { computeCaretWindow, SLASH_ASK_CARET_WINDOW_CODONS } from './caret-window';

const SPAN = 2 * SLASH_ASK_CARET_WINDOW_CODONS * 3;

describe('computeCaretWindow  caret-only inference)', () => {
  it('returns a bounded, codon-aligned window centered near the caret (never whole-entity)', () => {
    const seqLen = 3000;
    const { start, end } = computeCaretWindow(1500, seqLen, false);

    expect((start - 1) % 3).toBe(0);
    expect(end - start + 1).toBe(SPAN);
    expect(start).toBeGreaterThan(1);
    expect(end).toBeLessThan(seqLen);
    expect(start).toBeLessThanOrEqual(1500);
    expect(end).toBeGreaterThanOrEqual(1500);
  });

  it('clamps the start to 1 near the sequence start (still frame-aligned)', () => {
    const { start, end } = computeCaretWindow(5, 3000, false);
    expect(start).toBe(1);
    expect((start - 1) % 3).toBe(0);
    expect(end).toBe(SPAN);
  });

  it('clamps the end to the sequence length near the sequence end', () => {
    const seqLen = 3000;
    const { start, end } = computeCaretWindow(seqLen - 2, seqLen, false);
    expect(end).toBe(seqLen);
    expect((start - 1) % 3).toBe(0);
    expect(start).toBeGreaterThan(1);
  });

  it('window is much smaller than a large sequence (never dumps the whole chromosome)', () => {
    const seqLen = 4_600_000;
    const { start, end } = computeCaretWindow(2_000_000, seqLen, false);
    expect(end - start + 1).toBe(SPAN);
    expect(end - start + 1).toBeLessThan(seqLen);
  });

  it('degenerate: a sequence shorter than the window clamps to its bounds', () => {
    const { start, end } = computeCaretWindow(10, 20, false);
    expect(start).toBe(1);
    expect(end).toBe(20);
  });

  it('the window constant is 10 codons per side (a short-peptide neighborhood)', () => {
    expect(SLASH_ASK_CARET_WINDOW_CODONS).toBe(10);
  });
});
