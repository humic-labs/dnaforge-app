import { create } from 'zustand';
import type { AnnotationRequest } from '@waypoint/api-client';
import { beginWorkflowAction, type WorkflowOperation } from '../../lib/workflow-telemetry';
import { managedOperations } from '../../services/managed-operations';
import { useSequenceStore } from './store';

interface AnnotationSelection {
  operationId?: string;
  submissionKey: string;
  submitting: boolean;
  error?: string;
}

interface AnnotationOperationState {
  selectedByDocument: Record<string, AnnotationSelection>;
  submittedVersions: Record<string, number>;
  presentationRequests: Record<string, { operationId: string; requestId: string }>;
  select: (documentId: string, operationId: string) => void;
  presentReview: (documentId: string, operationId: string) => void;
  clear: (documentId: string) => void;
}

export const useAnnotationOperationState = create<AnnotationOperationState>((set) => ({
  selectedByDocument: {},
  submittedVersions: {},
  presentationRequests: {},
  presentReview: (documentId, operationId) =>
    set((state) => ({
      selectedByDocument: {
        ...state.selectedByDocument,
        [documentId]: {
          operationId,
          submissionKey: operationId,
          submitting: false,
        },
      },
      presentationRequests: {
        ...state.presentationRequests,
        [documentId]: { operationId, requestId: crypto.randomUUID() },
      },
    })),
  select: (documentId, operationId) =>
    set((state) => ({
      selectedByDocument: {
        ...state.selectedByDocument,
        [documentId]: {
          operationId,
          submissionKey: operationId,
          submitting: false,
        },
      },
    })),
  clear: (documentId) =>
    set((state) => {
      const { [documentId]: _selected, ...selectedByDocument } = state.selectedByDocument;
      return { selectedByDocument };
    }),
}));

export async function startAnnotationOperation(
  documentId: string,
  request: AnnotationRequest
): Promise<void> {
  const submissionKey = crypto.randomUUID();
  const activity = beginWorkflowAction({ workflow: 'plannotate', action: 'run' });
  const runVersion = useSequenceStore.getState().getVersion(documentId);
  const input = { ...request };
  useAnnotationOperationState.setState((state) => ({
    selectedByDocument: {
      ...state.selectedByDocument,
      [documentId]: { submissionKey, submitting: true },
    },
  }));
  try {
    const operation = await managedOperations.startAnnotation(documentId, input, submissionKey);
    observeRunActivity(operation.id, activity);
    useAnnotationOperationState.setState((state) => ({
      submittedVersions: { ...state.submittedVersions, [operation.id]: runVersion },
      ...(state.selectedByDocument[documentId]?.submissionKey === submissionKey
        ? {
            selectedByDocument: {
              ...state.selectedByDocument,
              [documentId]: {
                operationId: operation.id,
                submissionKey,
                submitting: false,
              },
            },
          }
        : {}),
    }));
  } catch (error) {
    activity.fail('submission_failed');
    useAnnotationOperationState.setState((state) => {
      if (state.selectedByDocument[documentId]?.submissionKey !== submissionKey) return state;
      return {
        selectedByDocument: {
          ...state.selectedByDocument,
          [documentId]: {
            submissionKey,
            submitting: false,
            error:
              error instanceof Error
                ? error.message
                : 'The runtime did not confirm the submission.',
          },
        },
      };
    });
  }
}

function observeRunActivity(operationId: string, activity: WorkflowOperation): void {
  const subscription: { release?: () => void } = {};
  const settle = (): void => {
    const record = managedOperations
      .getSnapshot()
      .records.find((candidate) => candidate.snapshot.id === operationId);
    if (!record || record.observation.freshness !== 'current') return;
    const state = record.snapshot.state;
    let settled = false;
    if (state === 'succeeded') {
      activity.complete({ status: 'success', operationId });
      settled = true;
    } else if (state === 'canceled') {
      activity.cancel({ status: 'cancelled', operationId });
      settled = true;
    } else if (state === 'failed' || state === 'interrupted') {
      activity.fail(state, { status: 'failed', operationId });
      settled = true;
    }
    if (settled) subscription.release?.();
  };
  subscription.release = managedOperations.subscribe(settle);
  settle();
  if (activity.consumed) subscription.release();
}
