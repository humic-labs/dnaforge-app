// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  selectionToAnnotationBoundaryRange,
  selectionToAskAiRange,
  viewerSelectionForAnnotationBoundaryState,
} from './annotation-boundaries';

describe('viewerSelectionForAnnotationBoundaryState', () => {
  it('preserves wrapped selection state for the drawer boundary conversion', () => {
    expect(viewerSelectionForAnnotationBoundaryState({ start: 90, end: 4, wraps: true })).toEqual({
      start: 90,
      end: 4,
      wraps: true,
    });
  });

  it('keeps contiguous selections in the existing compact shape', () => {
    expect(viewerSelectionForAnnotationBoundaryState({ start: 12, end: 45 })).toEqual({
      start: 12,
      end: 45,
    });
  });
});

describe('selectionToAnnotationBoundaryRange', () => {
  it('converts 0-indexed viewer selections into 1-indexed annotation boundaries', () => {
    expect(selectionToAnnotationBoundaryRange({ start: 12, end: 45 })).toEqual({
      start: 13,
      end: 46,
    });
  });

  it('normalizes reverse drag selections before converting to annotation boundaries', () => {
    expect(selectionToAnnotationBoundaryRange({ start: 45, end: 12 })).toEqual({
      start: 13,
      end: 46,
    });
  });

  it('refuses wrapped selections because the add-annotation form is contiguous-only', () => {
    expect(selectionToAnnotationBoundaryRange({ start: 90, end: 4, wraps: true })).toBeNull();
  });
});

describe('selectionToAskAiRange (wrap-capable Ask-AI source, ', () => {
  it('matches the annotation-boundary conversion for contiguous forward selections', () => {
    expect(selectionToAskAiRange({ start: 12, end: 45 })).toEqual({ start: 13, end: 46 });
  });

  it('normalizes reverse (non-wrapping) drags like the annotation path', () => {
    expect(selectionToAskAiRange({ start: 45, end: 12 })).toEqual({ start: 13, end: 46 });
  });

  it('PRESERVES an origin-spanning selection instead of nulling it (the bug fix)', () => {
    expect(selectionToAskAiRange({ start: 90, end: 4, wraps: true })).toEqual({
      start: 91,
      end: 5,
      wraps: true,
    });
  });

  it('returns null when there is no selection', () => {
    expect(selectionToAskAiRange(null)).toBeNull();
  });
});
