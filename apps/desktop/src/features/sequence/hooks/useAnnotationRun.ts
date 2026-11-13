import {
  toUserMessage,
  toOptionalUserMessage,
  userMessage,
  type UserMessage,
} from '@waypoint/user-messages';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { AnnotationRequest, AnnotationResult } from '@waypoint/api-client';
import { managedOperations } from '../../../services/managed-operations';
import { hasAnnotationResultShape } from '../annotation-result';
import {
  startAnnotationOperation,
  useAnnotationOperationState,
} from '../annotation-operation-state';

export type AnnotationRunStatus = 'idle' | 'loading' | 'success' | 'error';

export interface AnnotationRun {
  status: AnnotationRunStatus;
  data: AnnotationResult | null;
  error: UserMessage | null;
  operationId?: string;
  inputRevision?: string;
  unavailableReason?: UserMessage;
  execute: (request: AnnotationRequest) => Promise<void>;
  reset: () => void;
}

export function useAnnotationRun(documentId: string): AnnotationRun {
  const selected = useAnnotationOperationState((state) => state.selectedByDocument[documentId]);
  const runtime = useSyncExternalStore(managedOperations.subscribe, managedOperations.getSnapshot);
  const operationId = selected?.operationId;
  const record = runtime.records.find((item) => item.snapshot.id === operationId);
  const operation = record?.snapshot;
  const [loaded, setLoaded] = useState<{
    id: string;
    data: AnnotationResult | null;
    error: UserMessage | null;
  }>();

  useEffect(() => {
    if (!operationId || operation?.state !== 'succeeded') return;
    let observing = true;
    void managedOperations.getResult(operationId).then(
      (result) => {
        if (!observing) return;
        const annotationResult =
          result.kind === 'annotation' && hasAnnotationResultShape(result.result)
            ? result.result
            : null;
        const error =
          result?.operation_id !== operationId
            ? userMessage('annotation.resultMismatch')
            : result.status !== 'available'
              ? userMessage('annotation.resultUnavailable')
              : annotationResult === null
                ? userMessage('annotation.invalidResult')
                : toOptionalUserMessage(
                    annotationResult.error || null,
                    'failure.annotation-failed'
                  );
        setLoaded({
          id: operationId,
          data: error ? null : annotationResult,
          error,
        });
      },
      (error: unknown) => {
        if (observing)
          setLoaded({
            id: operationId,
            data: null,
            error: toUserMessage(error, 'annotation.invalidResult'),
          });
      }
    );
    return () => {
      observing = false;
    };
  }, [operationId, operation?.state, operation?.result_status]);

  const execute = useCallback(
    (request: AnnotationRequest) => startAnnotationOperation(documentId, request),
    [documentId]
  );
  const reset = useCallback(
    () => useAnnotationOperationState.getState().clear(documentId),
    [documentId]
  );
  const result = loaded?.id === operationId ? loaded : undefined;
  let status: AnnotationRunStatus = 'idle';
  let error: UserMessage | null =
    toOptionalUserMessage(selected?.error, 'failure.annotation-failed') ?? null;
  if (selected?.submitting) status = 'loading';
  else if (error) status = 'error';
  else if (operation) {
    if (operation.state === 'succeeded') {
      status = result ? (result.error ? 'error' : 'success') : 'loading';
      error = result?.error ?? null;
    } else if (['failed', 'canceled', 'interrupted'].includes(operation.state)) {
      status = 'error';
      error = toUserMessage(
        operation.error,
        operation.state === 'canceled'
          ? 'annotation.canceled'
          : operation.state === 'interrupted'
            ? 'annotation.interrupted'
            : 'failure.annotation-failed'
      );
    } else if (record?.observation.freshness === 'stale') {
      status = 'error';
      error = userMessage('jobs.statusStale');
    } else status = 'loading';
  } else if (operationId) {
    status = runtime.status === 'connected' ? 'error' : 'loading';
    error = status === 'error' ? userMessage('annotation.historyUnavailable') : null;
  }
  return {
    status,
    unavailableReason:
      runtime.status === 'connecting'
        ? userMessage('annotation.connecting')
        : runtime.status !== 'connected'
          ? userMessage('annotation.unavailable')
          : !runtime.supportedActionsByKind.annotation?.includes('start')
            ? userMessage('annotation.unsupported')
            : undefined,
    data: status === 'success' ? (result?.data ?? null) : null,
    error,
    operationId,
    inputRevision: operation?.subject.input_revision,
    execute,
    reset,
  };
}
