// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { Annotation } from '@waypoint/sequence-utils';
import type { PrimerDisplay } from '@waypoint/workspace-editor';
import {
  isPositionInHighlightRange,
  resolveContextMenuHighlightRange,
} from './context-menu-selection';

function annotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'ann-1',
    name: 'geneA',
    type: 'gene',
    start: 101,
    end: 200,
    direction: 1,
    color: '#3b82f6',
    lane: 0,
    ...overrides,
  } as Annotation;
}

function primer(overrides: Partial<PrimerDisplay> = {}): PrimerDisplay {
  return {
    id: 'primer-1',
    name: 'Primer 1',
    bases: 'ATGC',
    start: 300,
    end: 320,
    direction: 'forward',
    tm: 55,
    gc: 50,
    ...overrides,
  } as PrimerDisplay;
}

describe('context menu selection resolution', () => {
  it('keeps the current highlight when right-clicking inside it', () => {
    const currentRange = { start: 10, end: 40 };
    expect(
      resolveContextMenuHighlightRange({
        currentRange,
        position: 20,
        annotation: annotation(),
        sequenceLength: 1000,
      })
    ).toBe(currentRange);
  });

  it('keeps the current highlight when right-clicking an annotation outside it', () => {
    const currentRange = { start: 10, end: 40 };
    expect(
      resolveContextMenuHighlightRange({
        currentRange,
        position: 150,
        annotation: annotation(),
        sequenceLength: 1000,
      })
    ).toBe(currentRange);
  });

  it('retargets to the clicked annotation when there is no current highlight', () => {
    expect(
      resolveContextMenuHighlightRange({
        currentRange: null,
        position: 150,
        annotation: annotation(),
        sequenceLength: 1000,
      })
    ).toEqual({ start: 100, end: 199 });
  });

  it('clears the menu selection when right-clicking empty space outside the current highlight', () => {
    expect(
      resolveContextMenuHighlightRange({
        currentRange: { start: 10, end: 40 },
        position: 150,
        annotation: null,
        sequenceLength: 1000,
      })
    ).toBeNull();
  });

  it('treats wrapped highlights as containing positions on either side of the origin', () => {
    const range = { start: 900, end: 40, wraps: true };
    expect(isPositionInHighlightRange(range, 950, 1000)).toBe(true);
    expect(isPositionInHighlightRange(range, 20, 1000)).toBe(true);
    expect(isPositionInHighlightRange(range, 450, 1000)).toBe(false);
  });

  it('keeps the current highlight when right-clicking a primer outside it', () => {
    const currentRange = { start: 10, end: 40 };
    expect(
      resolveContextMenuHighlightRange({
        currentRange,
        position: 310,
        annotation: null,
        primer: primer(),
        sequenceLength: 1000,
      })
    ).toBe(currentRange);
  });

  it('retargets to clicked primers with exclusive primer end converted to inclusive selection end when there is no current highlight', () => {
    expect(
      resolveContextMenuHighlightRange({
        currentRange: null,
        position: 310,
        annotation: null,
        primer: primer(),
        sequenceLength: 1000,
      })
    ).toEqual({ start: 300, end: 319 });
  });
});
