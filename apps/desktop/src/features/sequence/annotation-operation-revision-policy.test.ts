// @vitest-environment node

import { beforeEach, describe, expect, it } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';

import { annotationInputRevision } from './annotation-input-revision';
import { annotationReviewBlockReason } from './annotation-operation-revision-policy';
import { useSequenceStore } from './store';

const DOCUMENT_ID = 'saved-sequence-document';

function savedSequence(sequence: string): AnnotatedSequence {
  return {
    id: DOCUMENT_ID,
    name: 'Saved sequence',
    sequence,
    length: sequence.length,
    circular: false,
    annotations: [],
  };
}

describe('annotationReviewBlockReason', () => {
  beforeEach(() => {
    useSequenceStore.getState().clearAll();
  });

  it('blocks a result whose input revision differs from the currently saved sequence', async () => {
    const analyzedRevision = await annotationInputRevision({ sequence: 'AAAA', linear: true });
    useSequenceStore.getState().setSequence(DOCUMENT_ID, savedSequence('ATGC'));

    await expect(annotationReviewBlockReason(DOCUMENT_ID, analyzedRevision)).resolves.toBe(
      'The sequence differs from the analyzed revision. These results are retained, but cannot be applied at unverified coordinates.'
    );
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(false);
  });
});
