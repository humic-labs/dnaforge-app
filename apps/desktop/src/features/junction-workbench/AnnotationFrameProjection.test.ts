// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { qualifiersForSourceSpaceAnnotationSlice } from './AnnotationFrameProjection';

describe('qualifiersForSourceSpaceAnnotationSlice', () => {
  it('keeps forward source CDS phase anchored when the visible slice starts after the CDS start', () => {
    const qualifiers = qualifiersForSourceSpaceAnnotationSlice({
      annotation: {
        type: 'CDS',
        start: 100,
        end: 400,
        strand: 'forward',
      },
      clippedStart: 251,
      clippedEnd: 330,
    });

    expect(qualifiers?.codon_start).toBe('3');
  });

  it('keeps reverse source CDS phase anchored when the visible slice ends before the CDS end', () => {
    const qualifiers = qualifiersForSourceSpaceAnnotationSlice({
      annotation: {
        type: 'CDS',
        start: 100,
        end: 400,
        strand: 'reverse',
      },
      clippedStart: 170,
      clippedEnd: 302,
    });

    expect(qualifiers?.codon_start).toBe('2');
  });

  it('threads existing qualifiers while recomputing local frame offset', () => {
    const qualifiers = qualifiersForSourceSpaceAnnotationSlice({
      annotation: {
        type: 'CDS',
        start: 100,
        end: 400,
        strand: 'forward',
        qualifiers: {
          note: 'source anchored',
          codon_start: '2',
        },
      },
      clippedStart: 104,
      clippedEnd: 160,
    });

    expect(qualifiers).toEqual({
      note: 'source anchored',
      codon_start: '1',
    });
  });

  it('does not add frame metadata to non-CDS annotations', () => {
    const qualifiers = qualifiersForSourceSpaceAnnotationSlice({
      annotation: {
        type: 'misc_feature',
        start: 100,
        end: 400,
        strand: 'forward',
      },
      clippedStart: 120,
      clippedEnd: 160,
    });

    expect(qualifiers).toBeUndefined();
  });
});
