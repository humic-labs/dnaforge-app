import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import { annotationTargetDocumentRevision } from '../../shared/annotation-target-document-revision';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotationDocumentInspection } from '@waypoint/api-client';
import type { DraftAnnotation } from './types';

const metrics = vi.hoisted(() => ({ observe: vi.fn() }));
vi.mock('../../lib/workflow-telemetry', () => ({ observeWorkflowAction: metrics.observe }));
const native = vi.hoisted(() => ({ inspect: vi.fn(), apply: vi.fn() }));
vi.mock('../../services/managed-operations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/managed-operations')>()),
  managedOperations: {
    inspectAnnotationDocument: native.inspect,
    applyAnnotationDocument: native.apply,
  },
}));

import { useAnnotationReviewStore } from './annotation-review-store';
import { useSequenceStore } from './store';
import { ManagedDocumentReceiptFromPreviousRuntimeError } from '../../services/managed-operations';
import {
  applyNativeAnnotationReview,
  prepareNativeAnnotationReview,
  observeNativeAnnotationReopen,
} from './annotation-native-review';

const OPERATION = 'retained-operation';
const DOCUMENT = 'document-a';
const REVISION = `annotation-document-v1:sha256:${'a'.repeat(64)}`;
const INPUT = `annotation-input-v1:sha256:${'b'.repeat(64)}`;

function draft(): DraftAnnotation {
  return {
    id: `${OPERATION}:0`,
    name: 'Reviewed candidate',
    type: 'misc_feature',
    start: 1,
    end: 4,
    strand: 1,
    identity: 100,
    coverage: 100,
    ref_start: 1,
    ref_end: 4,
    ref_length: 4,
    db_source: 'nucleotide',
    fragment: false,
    confidence: 100,
    accepted: true,
    duplicateStatus: { isDuplicate: false },
  };
}

function inspection(revision = REVISION): AnnotationDocumentInspection {
  const {
    confidence: _confidence,
    accepted: _accepted,
    duplicateStatus: _duplicate,
    id,
    ...feature
  } = draft();
  return {
    operationId: OPERATION,
    targetDocumentId: DOCUMENT,
    operationVersion: 2,
    resultSha256: `sha256:${'c'.repeat(64)}`,
    targetDocumentRevision: revision,
    analyzedInputRevision: INPUT,
    candidates: [{ id, index: 0, feature }],
    applicable: true,
  };
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  metrics.observe.mockClear();
  native.inspect.mockReset().mockResolvedValue(inspection());
  native.apply.mockReset().mockResolvedValue({
    actionId: 'native-action',
    outcome: {
      status: 'saved',
      targetDocumentRevision: 'saved-revision',
      checkpoint: { status: 'committed', commit: 'd'.repeat(40) },
      display: 'refreshed',
    },
  });
  useAnnotationReviewStore.getState().reset();
  useSequenceStore.setState({ savedVersions: {} });
  useAnnotationReviewStore.getState().enterReviewMode([draft()], DOCUMENT, 1, {
    operationId: OPERATION,
    inputRevision: INPUT,
  });
});

describe('native annotation review', () => {
  it('does not expose private native inspection detail', async () => {
    const raw = 'platform.trackViews.list is not available in the hosted browser runtime';
    native.inspect.mockRejectedValueOnce(
      Object.assign(new Error(raw), {
        body: { detail: { message: raw } },
      })
    );
    await prepareNativeAnnotationReview(OPERATION);
    const result = useAnnotationReviewStore.getState().sessions[OPERATION].nativeInspection;
    expect(result?.status).toBe('unavailable');
    if (result?.status !== 'unavailable') throw new Error('Expected unavailable inspection');
    expect(result.reason).not.toContain(raw);
    expect(toUserMessage(result.reason)).toBe(result.reason);
    expect(result.recovery).toBe('refresh');
    expect(native.apply).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'save-failed', 'outcome-unresolved'] as const)(
    'does not expose private native %s detail while retaining the receipt',
    async (status) => {
      await prepareNativeAnnotationReview(OPERATION);
      const receipt = {
        actionId: 'native-action',
        outcome: { status, reason: 'VITE_API_URL is not set', actionId: 'native-action' },
      };
      native.apply.mockResolvedValueOnce(receipt);
      const result = await applyNativeAnnotationReview(OPERATION);
      expect(result).toMatchObject({ status, actionId: receipt.actionId, receipt });
      if (!('reason' in result)) throw new Error('Expected refused or unresolved result');
      expect(result.reason).not.toContain('VITE_API_URL');
      expect(toUserMessage(result.reason)).toBe(result.reason);
      expect(useAnnotationReviewStore.getState().sessions[OPERATION].disposition).toBe('in-review');
      expect(native.apply).toHaveBeenCalledOnce();
    }
  );

  it('requires a native inspection before admitting a UI Apply', async () => {
    await expect(applyNativeAnnotationReview(OPERATION)).resolves.toMatchObject({
      status: 'blocked',
    });
    expect(native.apply).not.toHaveBeenCalled();
    expect(native.inspect).not.toHaveBeenCalled();
  });

  it('distinguishes an unprovable coordinate path from a retryable inspection failure', async () => {
    native.inspect.mockResolvedValueOnce({
      ...inspection(),
      applicable: false,
      blockReason: 'No verified saved edit history reaches the current document.',
    });
    await prepareNativeAnnotationReview(OPERATION);
    expect(useAnnotationReviewStore.getState().sessions[OPERATION].nativeInspection).toEqual({
      status: 'unavailable',
      reason: userMessage('annotation.resultNotApplicable'),
      recovery: 'rerun',
    });

    useAnnotationReviewStore.getState().reset();
    useAnnotationReviewStore.getState().enterReviewMode([draft()], DOCUMENT, 1, {
      operationId: OPERATION,
      inputRevision: INPUT,
    });
    native.inspect.mockRejectedValueOnce(new Error('Native inspection transport failed.'));
    await prepareNativeAnnotationReview(OPERATION);
    expect(useAnnotationReviewStore.getState().sessions[OPERATION].nativeInspection).toEqual({
      status: 'unavailable',
      reason: userMessage('annotation.documentFailed'),
      recovery: 'refresh',
    });
  });

  it('preserves bounded server diagnosis and selected candidates through safe refresh', async () => {
    const error = Object.assign(new Error('Bad Gateway'), {
      body: {
        detail: {
          reasonCode: 'dispatch_incomplete',
          message: 'The document owner did not confirm the inspection. Refresh review.',
        },
      },
    });
    const initial = useAnnotationReviewStore.getState().sessions[OPERATION];
    useAnnotationReviewStore.getState().toggleDraftAccepted(DOCUMENT, initial.drafts[0].id);
    native.inspect.mockRejectedValueOnce(error);
    await prepareNativeAnnotationReview(OPERATION);
    expect(useAnnotationReviewStore.getState().sessions[OPERATION].nativeInspection).toMatchObject({
      status: 'unavailable',
      reason: error.body.detail.message,
      recovery: 'refresh',
    });
    await prepareNativeAnnotationReview(OPERATION, { refresh: true });
    const recovered = useAnnotationReviewStore.getState().sessions[OPERATION];
    expect(recovered.nativeInspection?.status).toBe('ready');
    expect(recovered.drafts[0].accepted).toBe(false);
    expect(recovered.selectedId).toBe(initial.selectedId);
    expect(native.inspect).toHaveBeenCalledTimes(2);
    expect(native.apply).not.toHaveBeenCalled();
  });

  it('observes a reopened result only for the same document and exact saved receipt revision', async () => {
    const sequence = parseGenBankFull(
      readFileSync('../../test-fixtures/sequences/circular/pUC19.gb', 'utf8')
    );
    const revision = await annotationTargetDocumentRevision({ ...sequence, id: DOCUMENT });
    const review = useAnnotationReviewStore.getState().sessions[OPERATION];
    const savedReview = {
      ...review,
      disposition: 'applied' as const,
      nativeApplyResult: {
        status: 'saved' as const,
        actionId: 'action-a',
        receipt: {
          actionId: 'action-a',
          outcome: {
            status: 'saved' as const,
            targetDocumentRevision: revision,
            checkpoint: { status: 'not-required' as const },
            display: 'pending' as const,
          },
        },
      },
    };
    await observeNativeAnnotationReopen('different-document', sequence, [savedReview]);
    expect(metrics.observe).not.toHaveBeenCalled();
    await observeNativeAnnotationReopen(
      DOCUMENT,
      { ...sequence, name: 'different saved revision' },
      [savedReview]
    );
    expect(metrics.observe).not.toHaveBeenCalled();
    await observeNativeAnnotationReopen(DOCUMENT, sequence, [savedReview]);
    expect(metrics.observe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        operationId: OPERATION,
        outcomeKind: 'reopened_confirmed',
        initiator: 'system',
        valueDelivered: false,
        usableResult: false,
      })
    );
    expect(JSON.stringify(metrics.observe.mock.calls)).not.toContain(sequence.name);
    expect(JSON.stringify(metrics.observe.mock.calls)).not.toContain(sequence.sequence);
    expect(JSON.stringify(metrics.observe.mock.calls)).not.toContain(revision);
  });

  it('reports an explicit absent native owner as a refusal before admission', async () => {
    await prepareNativeAnnotationReview(OPERATION);
    native.apply.mockRejectedValue({
      status: 503,
      body: {
        detail: {
          code: 'NATIVE_DOCUMENT_CONNECTION_UNAVAILABLE',
          message: 'No native owner is connected.',
        },
      },
    });
    await expect(applyNativeAnnotationReview(OPERATION)).resolves.toMatchObject({
      status: 'blocked',
      reason: userMessage('annotation.documentUnavailable'),
    });
    expect(native.apply).toHaveBeenCalledOnce();
  });

  it('keeps an unknown save unresolved across refresh and repeated Apply', async () => {
    await prepareNativeAnnotationReview(OPERATION);
    native.apply.mockRejectedValue(new TypeError('Connection lost'));
    await expect(applyNativeAnnotationReview(OPERATION)).resolves.toMatchObject({
      status: 'outcome-unresolved',
    });
    await prepareNativeAnnotationReview(OPERATION, { refresh: true });
    await expect(applyNativeAnnotationReview(OPERATION)).resolves.toMatchObject({
      status: 'outcome-unresolved',
    });
    expect(native.apply).toHaveBeenCalledOnce();
    expect(native.inspect).toHaveBeenCalledOnce();
  });

  it('retains a known save from the previous runtime without calling its outcome unknown', async () => {
    await prepareNativeAnnotationReview(OPERATION);
    const receipt = {
      actionId: 'prior-runtime-action',
      outcome: {
        status: 'saved' as const,
        targetDocumentRevision: 'saved-revision',
        checkpoint: { status: 'not-required' as const },
        display: 'refreshed' as const,
      },
    };
    native.apply.mockRejectedValue(
      new ManagedDocumentReceiptFromPreviousRuntimeError(OPERATION, receipt)
    );
    await expect(applyNativeAnnotationReview(OPERATION)).resolves.toMatchObject({
      status: 'previous-runtime',
      actionId: receipt.actionId,
      receipt,
    });
    await prepareNativeAnnotationReview(OPERATION, { refresh: true });
    await expect(applyNativeAnnotationReview(OPERATION)).resolves.toMatchObject({
      status: 'previous-runtime',
    });
    expect(useAnnotationReviewStore.getState().sessions[OPERATION].disposition).toBe('in-review');
    expect(native.apply).toHaveBeenCalledOnce();
    expect(native.inspect).toHaveBeenCalledOnce();
  });

  it('applies the reviewed revision and selected IDs without inspecting again', async () => {
    await prepareNativeAnnotationReview(OPERATION);
    native.inspect.mockResolvedValue(inspection('newer-unreviewed-revision'));
    const result = await applyNativeAnnotationReview(OPERATION);
    expect(result).toMatchObject({ status: 'saved', actionId: 'native-action' });
    expect(native.apply).toHaveBeenCalledExactlyOnceWith({
      operationId: OPERATION,
      targetDocumentId: DOCUMENT,
      expectedOperationVersion: 2,
      expectedResultSha256: `sha256:${'c'.repeat(64)}`,
      expectedTargetDocumentRevision: REVISION,
      selectedCandidateIds: [`${OPERATION}:0`],
    });
    expect(native.inspect).toHaveBeenCalledOnce();
    expect(useAnnotationReviewStore.getState().sessions[OPERATION].disposition).toBe('applied');
    expect(useAnnotationReviewStore.getState().getSession(DOCUMENT)).toBeUndefined();
    expect(useAnnotationReviewStore.getState().isActive(DOCUMENT)).toBe(false);
  });

  it('changes the frozen revision only when the user explicitly refreshes the review', async () => {
    await prepareNativeAnnotationReview(OPERATION);
    native.inspect.mockResolvedValue(inspection('refreshed-document-revision'));
    await prepareNativeAnnotationReview(OPERATION);
    expect(native.inspect).toHaveBeenCalledOnce();
    await prepareNativeAnnotationReview(OPERATION, { refresh: true });
    await applyNativeAnnotationReview(OPERATION);
    expect(native.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedTargetDocumentRevision: 'refreshed-document-revision',
      })
    );
    expect(native.inspect).toHaveBeenCalledTimes(2);
  });

  it('stamps each inspection with the settled renderer save revision', async () => {
    useSequenceStore.setState({ savedVersions: { [DOCUMENT]: 4 } });
    await prepareNativeAnnotationReview(OPERATION);
    expect(useAnnotationReviewStore.getState().sessions[OPERATION].nativeInspection).toMatchObject({
      status: 'ready',
      savedVersion: 4,
    });

    useSequenceStore.setState({ savedVersions: { [DOCUMENT]: 5 } });
    await prepareNativeAnnotationReview(OPERATION, { refresh: true });
    expect(useAnnotationReviewStore.getState().sessions[OPERATION].nativeInspection).toMatchObject({
      status: 'ready',
      savedVersion: 5,
    });
  });

  it.each(['blocked', 'save-failed', 'outcome-unresolved'] as const)(
    'keeps the review and original action when the native result is %s',
    async (status) => {
      await prepareNativeAnnotationReview(OPERATION);
      native.apply.mockResolvedValue({
        actionId: 'native-action',
        outcome: { status, reason: 'Native outcome', actionId: 'native-action' },
      });
      await expect(applyNativeAnnotationReview(OPERATION)).resolves.toMatchObject({
        status,
        actionId: 'native-action',
        reason: userMessage(
          status === 'blocked'
            ? 'annotation.applyBlocked'
            : status === 'save-failed'
              ? 'annotation.saveFailed'
              : 'annotation.outcomeUnresolved'
        ),
      });
      const session = useAnnotationReviewStore.getState().sessions[OPERATION];
      expect(session.disposition).toBe('in-review');
      expect(session.drafts).toEqual([draft()]);
      expect(native.apply).toHaveBeenCalledOnce();
    }
  );

  it('does not install a late inspection into a discarded review', async () => {
    let finish!: (value: AnnotationDocumentInspection) => void;
    native.inspect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = prepareNativeAnnotationReview(OPERATION);
    useAnnotationReviewStore.getState().reset();
    finish(inspection());
    await pending;
    expect(useAnnotationReviewStore.getState().sessions).toEqual({});
  });

  it('refuses an inspection for a different analyzed input without a write', async () => {
    native.inspect.mockResolvedValue({ ...inspection(), analyzedInputRevision: 'another-input' });
    await prepareNativeAnnotationReview(OPERATION);
    await expect(applyNativeAnnotationReview(OPERATION)).resolves.toMatchObject({
      status: 'blocked',
    });
    expect(native.apply).not.toHaveBeenCalled();
  });
});
