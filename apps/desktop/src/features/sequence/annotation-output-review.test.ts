import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSequenceStore } from './store';
import { useAnnotationReviewStore } from './annotation-review-store';
import {
  reviewSelectedAnnotationOutput,
  applyAnnotationOutputReview,
} from './annotation-output-review';

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), apply: vi.fn(), parse: vi.fn() }));
vi.mock('./annotation-output-import', () => ({
  inspectAnnotationOutput: mocks.inspect,
  applyAnnotationOutput: mocks.apply,
}));
vi.mock('./annotation-output-client', () => ({ parseAnnotationOutputFile: mocks.parse }));

const documentId = 'import-review-document';
const folders = [{ path: '/project', name: 'Project' }];
const feature = {
  name: 'reviewed feature',
  accession: '',
  type: 'misc_feature',
  description: '',
  start: 1,
  end: 4,
  strand: 1,
  identity: 100,
  coverage: 100,
  fragment: false,
  ref_start: 1,
  ref_end: 4,
  ref_length: 4,
  db_source: 'nucleotide',
};

describe('human annotation output review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAnnotationReviewStore.getState().reset();
    useSequenceStore.getState().clearAll();
    useSequenceStore.getState().setSequence(documentId, {
      id: documentId,
      name: 'sample',
      sequence: 'ACGT',
      length: 4,
      circular: true,
      annotations: [],
    });
    mocks.inspect.mockResolvedValue({
      targetDocumentId: documentId,
      targetDocumentRevision: 'before',
      outputSha256: 'file-hash',
      analyzedInputRevision: null,
      result: { features: [feature], sequence_length: 4 },
      candidates: [{ id: 'file-hash:0', index: 0, feature }],
    });
  });

  it('admits the exact human-picked external file and retains an ordinary review', async () => {
    await reviewSelectedAnnotationOutput('/external/run.gff3', documentId, folders);
    expect(mocks.inspect).toHaveBeenCalledWith(
      {
        source: {
          kind: 'granted-file',
          absolutePath: '/external/run.gff3',
          grantedFiles: ['/external/run.gff3'],
        },
        format: 'gff3',
        targetDocumentId: documentId,
        folders,
      },
      { parse: mocks.parse }
    );
    const review = useAnnotationReviewStore.getState().getSession(documentId);
    expect(review?.drafts[0].id).toBe('file-hash:0');
    expect(review?.operationId).toBeUndefined();
    expect(review?.inputRevision).toBeUndefined();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('keeps choices and advances only the explicit retry precondition after a failed save', async () => {
    await reviewSelectedAnnotationOutput('/external/run.json', documentId, folders);
    mocks.apply.mockResolvedValueOnce({
      status: 'save-failed',
      reason: 'disk full',
      retryTargetDocumentRevision: 'owned-merge',
    });
    const result = await applyAnnotationOutputReview(documentId, folders);
    expect(result.status).toBe('save-failed');
    expect(useAnnotationReviewStore.getState().getSession(documentId)?.drafts[0].accepted).toBe(
      true
    );
    mocks.apply.mockResolvedValueOnce({ status: 'saved', targetDocumentRevision: 'saved' });
    await applyAnnotationOutputReview(documentId, folders);
    expect(mocks.apply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedTargetDocumentRevision: 'owned-merge',
        expectedOutputSha256: 'file-hash',
        selectedCandidateIds: ['file-hash:0'],
      }),
      { parse: mocks.parse }
    );
    expect(useAnnotationReviewStore.getState().getSession(documentId)).toBeUndefined();
  });

  it('keeps a blocked review without silently adopting a changed document revision', async () => {
    await reviewSelectedAnnotationOutput('/external/run.json', documentId, folders);
    mocks.apply.mockResolvedValue({
      status: 'blocked',
      reason: 'document changed',
      targetDocumentRevision: 'foreign-edit',
    });
    await applyAnnotationOutputReview(documentId, folders);
    expect(
      useAnnotationReviewStore.getState().getSession(documentId)?.outputImport
        ?.targetDocumentRevision
    ).toBe('before');
  });
  it('passes the actual parent workflow action to the annotation child Save', async () => {
    await reviewSelectedAnnotationOutput('/external/run.json', documentId, folders);
    mocks.apply.mockResolvedValueOnce({ status: 'saved', targetDocumentRevision: 'saved' });
    const parentActionId = '11111111-1111-4111-8111-111111111111';
    await applyAnnotationOutputReview(documentId, folders, parentActionId);
    expect(mocks.apply).toHaveBeenCalledWith(expect.anything(), {
      parse: mocks.parse,
      parentActionId,
    });
  });
});
