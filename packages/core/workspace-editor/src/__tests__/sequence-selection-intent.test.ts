import { describe, expect, it } from 'vitest';
import type { SearchMatch } from '@waypoint/sequence-utils';
import type { AnnotationStateIdentity } from '../annotation-render-state';
import {
  annotationIdentityEqual,
  projectSequenceSelectionFromInput,
  resolveSequenceSelectionIntent,
} from '../sequence-selection-intent';

const PROMOTER: AnnotationStateIdentity = {
  type: 'promoter',
  name: 'AmpR promoter',
  start: 1179,
  end: 1283,
  direction: 1,
};

const CDS: AnnotationStateIdentity = {
  type: 'CDS',
  name: 'AmpR',
  start: 1284,
  end: 2144,
  direction: 1,
};

function searchMatch(overrides: Partial<SearchMatch>): SearchMatch {
  return {
    start: 0,
    end: 10,
    strand: 'forward',
    type: 'nucleotide',
    ...overrides,
  };
}

describe('sequence selection intent projection', () => {
  it('projects a search annotation match as one annotation intent for every renderer', () => {
    const projection = projectSequenceSelectionFromInput({
      localCursor: 42,
      localRange: null,
      localSelectedAnnotation: null,
      activeSearchRange: { start: 1178, end: 1282 },
      activeSearchMatch: searchMatch({
        start: 1178,
        end: 1282,
        type: 'annotation',
        label: 'AmpR promoter',
        annotation: PROMOTER,
      }),
    });

    expect(projection.intent.kind).toBe('annotation');
    expect(projection.intent.source).toBe('search');
    expect(projection.canvas.highlightedRange).toEqual({ start: 1178, end: 1282 });
    expect(projection.oneD.selection).toEqual(projection.canvas.highlightedRange);
    expect(projection.minimap.selectionStart).toBe(1178);
    expect(projection.minimap.selectionEnd).toBe(1282);
    expect(projection.canvas.selectedAnnotation).toEqual(PROMOTER);
    expect(projection.oneD.selectedAnnotation).toEqual(PROMOTER);
    expect(projection.minimap.selectedAnnotation).toEqual(PROMOTER);
    expect(projection.oneD.selectedAnnotationId).toBe('AmpR promoter:1179-1283:1');
  });

  it('keeps protein-match codon range and parent CDS identity together', () => {
    const projection = projectSequenceSelectionFromInput({
      localCursor: null,
      localRange: null,
      localSelectedAnnotation: null,
      activeSearchRange: { start: 1283, end: 1291 },
      activeSearchMatch: searchMatch({
        start: 1283,
        end: 1291,
        type: 'protein',
        label: 'AmpR',
        annotation: CDS,
      }),
    });

    expect(projection.intent.kind).toBe('protein-match');
    expect(projection.canvas.highlightedRange).toEqual({ start: 1283, end: 1291 });
    expect(projection.canvas.selectedAnnotation).toEqual(CDS);
    expect(projection.oneD.selectedAnnotation).toEqual(CDS);
    expect(projection.minimap.selectedAnnotation).toEqual(CDS);
  });

  it('projects nucleotide search matches as range-only selection for every renderer', () => {
    const projection = projectSequenceSelectionFromInput({
      localCursor: null,
      localRange: null,
      localSelectedAnnotation: PROMOTER,
      activeSearchRange: { start: 10, end: 14, wraps: true },
      activeSearchMatch: searchMatch({ start: 10, end: 14, wraps: true }),
    });

    expect(projection.intent.kind).toBe('range');
    expect(projection.intent.source).toBe('search');
    expect(projection.canvas.highlightedRange).toEqual({ start: 10, end: 14, wraps: true });
    expect(projection.oneD.selection).toEqual(projection.canvas.highlightedRange);
    expect(projection.minimap.selectionStart).toBe(10);
    expect(projection.minimap.selectionEnd).toBe(14);
    expect(projection.minimap.selectionWraps).toBe(true);
    expect(projection.canvas.selectedAnnotation).toBeNull();
    expect(projection.oneD.selectedAnnotation).toBeNull();
    expect(projection.minimap.selectedAnnotation).toBeNull();
  });

  it('lets active search selection override stale local annotation state', () => {
    const projection = projectSequenceSelectionFromInput({
      localCursor: null,
      localRange: { start: 1, end: 2 },
      localSelectedAnnotation: CDS,
      activeSearchRange: { start: 1178, end: 1282 },
      activeSearchMatch: searchMatch({
        start: 1178,
        end: 1282,
        type: 'annotation',
        annotation: PROMOTER,
      }),
    });

    expect(projection.canvas.highlightedRange).toEqual({ start: 1178, end: 1282 });
    expect(projection.canvas.selectedAnnotation).toEqual(PROMOTER);
    expect(projection.oneD.selectedAnnotation).toEqual(PROMOTER);
    expect(projection.minimap.selectedAnnotation).toEqual(PROMOTER);
  });

  it('falls back to local annotation projection when search is released', () => {
    const projection = projectSequenceSelectionFromInput({
      localCursor: null,
      localRange: { start: 1178, end: 1282 },
      localSelectedAnnotation: PROMOTER,
      activeSearchRange: null,
      activeSearchMatch: null,
    });

    expect(projection.intent.kind).toBe('annotation');
    expect(projection.intent.source).toBe('local');
    expect(projection.canvas.highlightedRange).toEqual({ start: 1178, end: 1282 });
    expect(projection.canvas.selectedAnnotation).toEqual(PROMOTER);
    expect(projection.oneD.selectedAnnotation).toEqual(PROMOTER);
    expect(projection.minimap.selectedAnnotation).toEqual(PROMOTER);
  });

  it('uses one structural equality rule for annotations', () => {
    expect(annotationIdentityEqual(PROMOTER, { ...PROMOTER })).toBe(true);
    expect(annotationIdentityEqual(PROMOTER, { ...PROMOTER, direction: 0 })).toBe(false);
  });

  it('resolves cursor-only local state without leaking renderer annotation state', () => {
    const intent = resolveSequenceSelectionIntent({
      localCursor: 100,
      localRange: null,
      localSelectedAnnotation: null,
      activeSearchRange: null,
      activeSearchMatch: null,
    });

    expect(intent).toEqual({ kind: 'cursor', source: 'local', position: 100 });
  });

  it(': clicking a FindBar result releases the search range in favor of the plain local-annotation projection (native outline, no redundant range bar)', () => {
    const projection = projectSequenceSelectionFromInput({
      localCursor: null,
      localRange: null,
      localSelectedAnnotation: PROMOTER,
      activeSearchRange: null,
      activeSearchMatch: null,
    });

    expect(projection.intent.source).toBe('local');
    expect(projection.canvas.selectedAnnotation).toEqual(PROMOTER);
    expect(projection.canvas.highlightedRange).toBeNull();
    expect(projection.oneD.selection).toBeNull();
    expect(projection.minimap.selectionStart).toBeNull();
  });
});
