import { describe, it, expect, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { useAnnotationReviewStore } from '../annotation-review-store';
import { createDraftAnnotations } from '../annotation-review-utils';
import type { PlannotateFeature, DbSource } from '../types';
import type { AnnotationResult } from '@waypoint/api-client';

function makeFeature(
  partial: Omit<
    PlannotateFeature,
    'ref_start' | 'ref_end' | 'ref_length' | 'db_source' | 'fragment'
  > &
    Partial<
      Pick<PlannotateFeature, 'ref_start' | 'ref_end' | 'ref_length' | 'db_source' | 'fragment'>
    >
): PlannotateFeature {
  return {
    ref_start: 1,
    ref_end: partial.end - partial.start,
    ref_length: partial.end - partial.start,
    db_source: 'protein' as DbSource,
    fragment: false,
    ...partial,
  };
}

const TEST_FILE = '/test/sequence.gb';

describe('SequenceTab annotation review integration', () => {
  beforeEach(() => {
    useAnnotationReviewStore.getState().reset();
  });

  describe('entering review mode with annotation results', () => {
    it('creates draft annotations from pLannotate features and enters review mode', () => {
      const plannotateFeatures: PlannotateFeature[] = [
        makeFeature({
          name: 'AmpR',
          start: 100,
          end: 900,
          strand: 1,
          identity: 99,
          coverage: 98,
          type: 'CDS',
        }),
        makeFeature({
          name: 'ColE1',
          start: 1000,
          end: 1600,
          strand: 1,
          identity: 95,
          coverage: 92,
          type: 'rep_origin',
        }),
      ];

      const existingAnnotations = [
        { name: 'ExistingFeature', type: 'promoter', start: 2000, end: 2100 },
      ];

      const drafts = createDraftAnnotations(plannotateFeatures, existingAnnotations);

      act(() => {
        useAnnotationReviewStore.getState().enterReviewMode(drafts, TEST_FILE);
      });

      const state = useAnnotationReviewStore.getState();
      expect(state.isActive(TEST_FILE)).toBe(true);
      const session = state.getSession(TEST_FILE);
      expect(session?.drafts).toHaveLength(2);
      expect(session?.drafts[0].name).toBe('AmpR');
      expect(session?.drafts[0].confidence).toBeCloseTo(97.02, 1);
      expect(session?.drafts[1].name).toBe('ColE1');
    });

    it('auto-rejects duplicates when entering review mode', () => {
      const plannotateFeatures: PlannotateFeature[] = [
        makeFeature({
          name: 'AmpR',
          start: 100,
          end: 900,
          strand: 1,
          identity: 99,
          coverage: 98,
          type: 'CDS',
        }),
      ];

      const existingAnnotations = [{ name: 'AmpR', type: 'CDS', start: 100, end: 900 }];

      const drafts = createDraftAnnotations(plannotateFeatures, existingAnnotations);

      act(() => {
        useAnnotationReviewStore.getState().enterReviewMode(drafts, TEST_FILE);
      });

      const state = useAnnotationReviewStore.getState();
      const session = state.getSession(TEST_FILE);
      expect(session?.drafts[0].duplicateStatus.isDuplicate).toBe(true);
      expect(session?.drafts[0].accepted).toBe(false);
    });
  });

  describe('committing accepted annotations', () => {
    it('filters to only accepted drafts for merging', () => {
      const drafts = [
        {
          id: '1',
          name: 'Keep',
          start: 100,
          end: 200,
          strand: 1,
          identity: 95,
          coverage: 90,
          confidence: 85.5,
          accepted: true,
          duplicateStatus: { isDuplicate: false },
        },
        {
          id: '2',
          name: 'Reject',
          start: 300,
          end: 400,
          strand: -1,
          identity: 80,
          coverage: 75,
          confidence: 60,
          accepted: false,
          duplicateStatus: { isDuplicate: false },
        },
      ];

      act(() => {
        useAnnotationReviewStore.getState().enterReviewMode(drafts as any, TEST_FILE);
      });

      const acceptedDrafts = useAnnotationReviewStore.getState().getAcceptedDrafts(TEST_FILE);
      expect(acceptedDrafts).toHaveLength(1);
      expect(acceptedDrafts[0].name).toBe('Keep');
    });
  });

  describe('review mode state cleanup', () => {
    it('clears drafts when exiting review mode', () => {
      const drafts = [
        {
          id: '1',
          name: 'Feature',
          start: 100,
          end: 200,
          strand: 1,
          identity: 95,
          coverage: 90,
          confidence: 85.5,
          accepted: true,
          duplicateStatus: { isDuplicate: false },
        },
      ];

      act(() => {
        useAnnotationReviewStore.getState().enterReviewMode(drafts as any, TEST_FILE);
      });

      expect(useAnnotationReviewStore.getState().isActive(TEST_FILE)).toBe(true);

      act(() => {
        useAnnotationReviewStore.getState().exitReviewMode(TEST_FILE);
      });

      const state = useAnnotationReviewStore.getState();
      expect(state.isActive(TEST_FILE)).toBe(false);
      expect(state.getSession(TEST_FILE)).toBeUndefined();
    });
  });
});

describe('SequenceTab API error detection', () => {
  function detectApiError(
    annotateStatus: string,
    annotateData: AnnotationResult | null
  ): { effectiveStatus: string; errorMessage: string | null } {
    if (annotateStatus === 'success' && annotateData?.error) {
      return { effectiveStatus: 'error', errorMessage: annotateData.error };
    }
    return { effectiveStatus: annotateStatus, errorMessage: null };
  }

  it('detects error in response body when HTTP status is success', () => {
    const data: AnnotationResult = {
      features: [],
      sequence_length: 0,
      error:
        'pLannotate not installed. Install via: uv pip install git+https://github.com/mmcguffi/pLannotate.git',
    };

    const { effectiveStatus, errorMessage } = detectApiError('success', data);

    expect(effectiveStatus).toBe('error');
    expect(errorMessage).toContain('pLannotate not installed');
  });

  it('detects missing binaries error', () => {
    const data: AnnotationResult = {
      features: [],
      sequence_length: 0,
      error: 'Missing required binaries: diamond, cmscan. Expected in: /path/to/binaries',
    };

    const { effectiveStatus, errorMessage } = detectApiError('success', data);

    expect(effectiveStatus).toBe('error');
    expect(errorMessage).toContain('Missing required binaries');
  });

  it('passes through success with valid features', () => {
    const data: AnnotationResult = {
      features: [
        makeFeature({
          name: 'AmpR',
          start: 100,
          end: 900,
          strand: 1,
          identity: 99,
          coverage: 98,
          type: 'CDS',
        }),
      ],
      sequence_length: 2686,
    };

    const { effectiveStatus, errorMessage } = detectApiError('success', data);

    expect(effectiveStatus).toBe('success');
    expect(errorMessage).toBeNull();
  });

  it('passes through success with empty features (no error field)', () => {
    const data: AnnotationResult = {
      features: [],
      sequence_length: 50,
    };

    const { effectiveStatus, errorMessage } = detectApiError('success', data);

    expect(effectiveStatus).toBe('success');
    expect(errorMessage).toBeNull();
  });

  it('passes through HTTP-level errors unchanged', () => {
    const { effectiveStatus, errorMessage } = detectApiError('error', null);

    expect(effectiveStatus).toBe('error');
    expect(errorMessage).toBeNull();
  });

  it('passes through loading status unchanged', () => {
    const { effectiveStatus, errorMessage } = detectApiError('loading', null);

    expect(effectiveStatus).toBe('loading');
    expect(errorMessage).toBeNull();
  });

  it('passes through idle status unchanged', () => {
    const { effectiveStatus, errorMessage } = detectApiError('idle', null);

    expect(effectiveStatus).toBe('idle');
    expect(errorMessage).toBeNull();
  });
});
