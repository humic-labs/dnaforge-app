export type AnnotationTileRequestDescriptor = {
  requestId: string;
  token: number;
  startBp: number;
  endBp: number;
};

export interface AnnotationTileSemaphoreState {
  active: AnnotationTileRequestDescriptor | null;
  queued: AnnotationTileRequestDescriptor | null;
}

export type AnnotationTileSemaphoreDispatchDecision =
  | { kind: 'dispatch'; request: AnnotationTileRequestDescriptor }
  | {
      kind: 'queued';
      cancelRequestId: string;
      queuedRequest: AnnotationTileRequestDescriptor;
      droppedQueuedRequestId: string | null;
    };

export type AnnotationTileSemaphoreClearedDecision =
  | { kind: 'idle' }
  | { kind: 'dispatch-queued'; request: AnnotationTileRequestDescriptor };

export function createAnnotationTileSemaphoreState(): AnnotationTileSemaphoreState {
  return { active: null, queued: null };
}

export function decideDispatch(
  state: AnnotationTileSemaphoreState,
  request: AnnotationTileRequestDescriptor
): AnnotationTileSemaphoreDispatchDecision {
  if (state.active === null) {
    return { kind: 'dispatch', request };
  }
  const droppedQueuedRequestId = state.queued?.requestId ?? null;
  return {
    kind: 'queued',
    cancelRequestId: state.active.requestId,
    queuedRequest: request,
    droppedQueuedRequestId,
  };
}

export function recordActiveStarted(
  state: AnnotationTileSemaphoreState,
  request: AnnotationTileRequestDescriptor
): AnnotationTileSemaphoreState {
  return { active: request, queued: state.queued };
}

export function recordQueuedSupersede(
  state: AnnotationTileSemaphoreState,
  request: AnnotationTileRequestDescriptor
): AnnotationTileSemaphoreState {
  return { active: state.active, queued: request };
}

export function recordActiveCleared(
  state: AnnotationTileSemaphoreState,
  clearedRequestId: string
): { state: AnnotationTileSemaphoreState; decision: AnnotationTileSemaphoreClearedDecision } {
  if (state.active === null || state.active.requestId !== clearedRequestId) {
    return { state, decision: { kind: 'idle' } };
  }
  if (state.queued === null) {
    return { state: { active: null, queued: null }, decision: { kind: 'idle' } };
  }
  const queued = state.queued;
  return {
    state: { active: queued, queued: null },
    decision: { kind: 'dispatch-queued', request: queued },
  };
}

export function inFlightCount(state: AnnotationTileSemaphoreState): number {
  return (state.active ? 1 : 0) + (state.queued ? 1 : 0);
}
