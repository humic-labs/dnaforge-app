import {
  toUserMessage,
  userMessage,
  UserMessageError,
  type UserMessage,
} from '@waypoint/user-messages';
import { observeWorkflowAction } from '../../lib/workflow-telemetry';
import { annotationTargetDocumentRevision } from '../../shared/annotation-target-document-revision';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import type { AnnotationDocumentSelection } from '@waypoint/api-client';
import {
  managedOperations,
  ManagedDocumentReceiptFromPreviousRuntimeError,
} from '../../services/managed-operations';
import { useAnnotationReviewStore, type ReviewSession } from './annotation-review-store';
import { createDraftAnnotations } from './annotation-review-utils';
import { useSequenceStore } from './store';

import type {
  NativeAnnotationReviewInspection,
  NativeAnnotationReviewResult,
} from './annotation-review-types';

export type {
  NativeAnnotationReviewInspection,
  NativeAnnotationReviewResult,
} from './annotation-review-types';

export function nativeAnnotationReviewNeedsObservation(
  result?: NativeAnnotationReviewResult
): boolean {
  return result?.status === 'outcome-unresolved' || result?.status === 'previous-runtime';
}

function updateReview(
  operationId: string,
  expected: ReviewSession['nativeInspection'],
  update: (session: ReviewSession) => ReviewSession
): void {
  useAnnotationReviewStore.setState((state) => {
    const session = state.sessions[operationId];
    if (!session || session.disposition !== 'in-review' || session.nativeInspection !== expected)
      return state;
    return { sessions: { ...state.sessions, [operationId]: update(session) } };
  });
}

function failureMessage(error: unknown): UserMessage {
  if (inspectionFailureReason(error) === 'dispatch_incomplete')
    return userMessage('annotation.inspectionUnconfirmed');
  if (typeof error === 'object' && error !== null && 'body' in error) {
    const body = error.body;
    if (typeof body === 'object' && body !== null && 'detail' in body) {
      const detail = body.detail;
      if (
        typeof detail === 'object' &&
        detail !== null &&
        'code' in detail &&
        detail.code === 'NATIVE_DOCUMENT_CONNECTION_UNAVAILABLE'
      )
        return userMessage('annotation.documentUnavailable');
    }
  }
  return toUserMessage(error, 'annotation.documentFailed');
}

export async function prepareNativeAnnotationReview(
  operationId: string,
  options: { refresh?: boolean } = {}
): Promise<void> {
  const session = useAnnotationReviewStore.getState().sessions[operationId];
  if (
    !session?.documentId ||
    !session.inputRevision ||
    session.disposition !== 'in-review' ||
    session.nativeApplyPending
  )
    return;
  const documentId = session.documentId;
  const savedVersion = useSequenceStore.getState().savedVersions[documentId] ?? 0;
  if (nativeAnnotationReviewNeedsObservation(session.nativeApplyResult)) return;
  if (
    session.nativeInspection?.status === 'checking' ||
    (session.nativeInspection && !options.refresh)
  )
    return;
  const checking: NativeAnnotationReviewInspection = { status: 'checking' };
  updateReview(operationId, session.nativeInspection, (current) => ({
    ...current,
    nativeInspection: checking,
  }));
  try {
    const inspected = await managedOperations.inspectAnnotationDocument({
      operationId,
      targetDocumentId: documentId,
    });
    if (
      inspected.operationId !== operationId ||
      inspected.targetDocumentId !== session.documentId ||
      inspected.analyzedInputRevision !== session.inputRevision ||
      inspected.candidates.some(
        (candidate) => !session.drafts.some((draft) => draft.id === candidate.id)
      )
    ) {
      throw new UserMessageError('annotation.reviewMismatch');
    }
    if (!inspected.applicable) {
      if (
        useAnnotationReviewStore.getState().sessions[operationId]?.nativeInspection === checking
      ) {
        observeAnnotationReview({
          operationId,
          outcomeKind: 'inspection_blocked',
          errorClass: 'document_not_applicable',
        });
      }
      updateReview(operationId, checking, (current) => ({
        ...current,
        nativeInspection: {
          status: 'unavailable',
          reason: userMessage('annotation.resultNotApplicable'),
          recovery: 'rerun',
        },
      }));
      return;
    }
    updateReview(operationId, checking, (current) => {
      const accepted = new Map(current.drafts.map((draft) => [draft.id, draft.accepted]));
      const sequence = useSequenceStore.getState().getSequence(documentId);
      const existing = (sequence?.annotations ?? []).map(
        ({ name, type, start, end, direction }) => ({
          name,
          type,
          start,
          end,
          strand: direction,
        })
      );
      const drafts = createDraftAnnotations(
        inspected.candidates.map((candidate) => candidate.feature),
        existing
      ).map((draft, index) => ({
        ...draft,
        id: inspected.candidates[index].id,
        accepted: accepted.get(inspected.candidates[index].id) ?? draft.accepted,
        savedSubstitutionOverlap: inspected.candidates[index].substitutionOverlap,
      }));
      observeAnnotationReview({ operationId, outcomeKind: 'inspection_ready' });
      return {
        ...current,
        drafts,
        selectedId: drafts.some((draft) => draft.id === current.selectedId)
          ? current.selectedId
          : (drafts[0]?.id ?? null),
        nativeInspection: {
          status: 'ready',
          savedVersion,
          selection: {
            operationId,
            targetDocumentId: documentId,
            expectedOperationVersion: inspected.operationVersion,
            expectedResultSha256: inspected.resultSha256,
            expectedTargetDocumentRevision: inspected.targetDocumentRevision,
          },
          coordinates: inspected.coordinates,
          transitionCount: inspected.transitionCount,
          substitutionOverlap: inspected.candidates.some(
            (candidate) => candidate.substitutionOverlap
          ),
        },
        nativeApplyResult: undefined,
      };
    });
  } catch (error) {
    if (useAnnotationReviewStore.getState().sessions[operationId]?.nativeInspection === checking) {
      observeAnnotationReview({
        operationId,
        outcomeKind: 'inspection_blocked',
        errorClass: inspectionFailureReason(error),
      });
    }
    updateReview(operationId, checking, (current) => ({
      ...current,
      nativeInspection: {
        status: 'unavailable',
        reason: failureMessage(error),
        recovery: 'refresh',
      },
    }));
  }
}

export function nativeAnnotationReviewBlockReason(session: ReviewSession): UserMessage | undefined {
  if (session.nativeApplyPending) return userMessage('annotation.savingReview');
  const result = session.nativeApplyResult;
  if (result && result.status !== 'saved' && result.status !== 'already-applied')
    return result.reason;
  const inspection = session.nativeInspection;
  if (!inspection || inspection.status === 'checking')
    return userMessage('annotation.checkingDocument');
  if (inspection.status === 'unavailable') return inspection.reason;
  return session.blockedReason;
}

const applying = new Map<string, { key: string; promise: Promise<NativeAnnotationReviewResult> }>();

export function applyNativeAnnotationReview(
  operationId: string,
  options: { readOnly?: boolean } = {}
): Promise<NativeAnnotationReviewResult> {
  const session = useAnnotationReviewStore.getState().sessions[operationId];
  const blocked = (reason: UserMessage): Promise<NativeAnnotationReviewResult> =>
    Promise.resolve({ status: 'blocked', reason });
  if (options.readOnly) return blocked(userMessage('annotation.documentReadOnly'));
  if (session?.disposition === 'applied') return Promise.resolve({ status: 'already-applied' });
  if (!session || session.disposition !== 'in-review')
    return blocked(userMessage('annotation.reviewInactive'));
  if (
    session.nativeApplyResult &&
    nativeAnnotationReviewNeedsObservation(session.nativeApplyResult)
  )
    return Promise.resolve(session.nativeApplyResult);
  const inspection = session.nativeInspection;
  if (inspection?.status !== 'ready')
    return blocked(
      nativeAnnotationReviewBlockReason(session) ?? userMessage('annotation.inspectBeforeApply')
    );
  const selectedCandidateIds = session.drafts
    .filter((draft) => draft.accepted)
    .map((draft) => draft.id);
  if (selectedCandidateIds.length === 0)
    return blocked(userMessage('annotation.selectBeforeApply'));
  const selection = { ...inspection.selection, selectedCandidateIds };
  const key = JSON.stringify(selection);
  const pending = applying.get(operationId);
  if (pending)
    return pending.key === key
      ? pending.promise
      : blocked(userMessage('annotation.selectionAlreadySaving'));
  updateReview(operationId, inspection, (current) => ({ ...current, nativeApplyPending: true }));
  const promise = apply(selection)
    .then((result) => {
      updateReview(operationId, inspection, (current) => ({
        ...current,
        nativeApplyPending: false,
        nativeApplyResult: result,
      }));
      const current = useAnnotationReviewStore.getState().sessions[operationId];
      if (
        result.status === 'saved' &&
        current?.nativeInspection === inspection &&
        current.nativeApplyResult === result
      ) {
        useAnnotationReviewStore.getState().setOperationDisposition(operationId, 'applied');
      }
      return result;
    })
    .finally(() => {
      if (applying.get(operationId)?.promise === promise) applying.delete(operationId);
    });
  applying.set(operationId, { key, promise });
  return promise;
}

async function apply(
  selection: AnnotationDocumentSelection
): Promise<NativeAnnotationReviewResult> {
  try {
    const receipt = await managedOperations.applyAnnotationDocument(selection);
    const outcome = receipt.outcome;
    if (outcome.status === 'saved') return { status: 'saved', actionId: receipt.actionId, receipt };
    return {
      status: outcome.status,
      actionId: receipt.actionId,
      reason: userMessage(
        outcome.status === 'blocked'
          ? 'annotation.applyBlocked'
          : outcome.status === 'save-failed'
            ? 'annotation.saveFailed'
            : 'annotation.outcomeUnresolved'
      ),
      receipt,
    };
  } catch (error) {
    if (error instanceof ManagedDocumentReceiptFromPreviousRuntimeError) {
      return {
        status: 'previous-runtime',
        actionId: error.receipt.actionId,
        receipt: error.receipt,
        reason: userMessage(
          error.receipt.outcome.status === 'saved'
            ? 'annotation.previousSessionSaved'
            : 'annotation.previousSessionCompleted'
        ),
      };
    }
    const status =
      typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
    const body =
      typeof error === 'object' && error !== null && 'body' in error ? error.body : undefined;
    const detail =
      typeof body === 'object' && body !== null && 'detail' in body ? body.detail : undefined;
    const code =
      typeof detail === 'object' && detail !== null && 'code' in detail ? detail.code : undefined;
    if (
      (typeof status === 'number' && [400, 401, 403, 404, 409, 413, 422, 429].includes(status)) ||
      (status === 503 && code === 'NATIVE_DOCUMENT_CONNECTION_UNAVAILABLE')
    ) {
      return { status: 'blocked', reason: failureMessage(error) };
    }
    return {
      status: 'outcome-unresolved',
      reason: userMessage('annotation.outcomeUnresolved'),
    };
  }
}

const INSPECTION_FAILURE_REASONS = new Set([
  'dispatch_incomplete',
  'schema_invalid',
  'authority_changed',
  'identity_mismatch',
  'operation_version_mismatch',
  'result_mismatch',
  'input_revision_mismatch',
  'applicability_mismatch',
  'candidate_order_mismatch',
  'candidate_bounds_mismatch',
  'coordinate_mismatch',
  'candidate_identity_mismatch',
  'candidate_source_mismatch',
  'candidate_mapping_mismatch',
]);

function inspectionFailureReason(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('body' in error)) return 'unknown';
  const body = error.body;
  if (typeof body !== 'object' || body === null || !('detail' in body)) return 'unknown';
  const detail = body.detail;
  if (typeof detail !== 'object' || detail === null || !('reasonCode' in detail)) return 'unknown';
  return typeof detail.reasonCode === 'string' && INSPECTION_FAILURE_REASONS.has(detail.reasonCode)
    ? detail.reasonCode
    : 'unknown';
}

function observeAnnotationReview(input: {
  operationId: string;
  outcomeKind: 'inspection_ready' | 'inspection_blocked' | 'reopened_confirmed';
  errorClass?: string;
}): void {
  try {
    observeWorkflowAction({
      workflow: 'annotation',
      action: 'view',
      status: input.outcomeKind === 'inspection_blocked' ? 'blocked' : 'viewed',
      initiator: 'system',
      valueDelivered: false,
      usableResult: false,
      success: input.outcomeKind !== 'inspection_blocked',
      ...input,
    });
  } catch {}
}

export async function observeNativeAnnotationReopen(
  documentId: string,
  sequence: AnnotatedSequence,
  savedReviews: readonly ReviewSession[]
): Promise<void> {
  const revision = await annotationTargetDocumentRevision({ ...sequence, id: documentId });
  for (const review of savedReviews) {
    const result = review.nativeApplyResult;
    if (review.documentId !== documentId || !review.operationId || result?.status !== 'saved')
      continue;
    const saved = result.receipt.outcome;
    if (saved.status === 'saved' && saved.targetDocumentRevision === revision) {
      observeAnnotationReview({
        operationId: review.operationId,
        outcomeKind: 'reopened_confirmed',
      });
    }
  }
}
