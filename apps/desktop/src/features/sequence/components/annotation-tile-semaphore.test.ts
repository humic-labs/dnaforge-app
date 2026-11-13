// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  type AnnotationTileRequestDescriptor,
  createAnnotationTileSemaphoreState,
  decideDispatch,
  inFlightCount,
  recordActiveCleared,
  recordActiveStarted,
  recordQueuedSupersede,
} from './annotation-tile-semaphore';

function req(
  token: number,
  range: { start: number; end: number } = { start: 0, end: 1000 }
): AnnotationTileRequestDescriptor {
  return {
    requestId: `annotation-tile-${token}`,
    token,
    startBp: range.start,
    endBp: range.end,
  };
}

describe('annotation-tile semaphore (Phase 3 Slice 2a)', () => {
  describe('decideDispatch / recordActiveStarted', () => {
    it('dispatches immediately when no request is active', () => {
      const state = createAnnotationTileSemaphoreState();
      const decision = decideDispatch(state, req(1));
      expect(decision.kind).toBe('dispatch');
      if (decision.kind !== 'dispatch') throw new Error('narrowing');
      expect(decision.request.requestId).toBe('annotation-tile-1');
    });

    it('marks the active slot after recordActiveStarted', () => {
      let state = createAnnotationTileSemaphoreState();
      state = recordActiveStarted(state, req(1));
      expect(state.active?.requestId).toBe('annotation-tile-1');
      expect(state.queued).toBeNull();
      expect(inFlightCount(state)).toBe(1);
    });
  });

  describe('decideDispatch / recordQueuedSupersede when a request is already active', () => {
    it('returns queued + cancelRequestId pointing at the active request', () => {
      let state = createAnnotationTileSemaphoreState();
      state = recordActiveStarted(state, req(1));
      const decision = decideDispatch(state, req(2));
      expect(decision.kind).toBe('queued');
      if (decision.kind !== 'queued') throw new Error('narrowing');
      expect(decision.cancelRequestId).toBe('annotation-tile-1');
      expect(decision.queuedRequest.requestId).toBe('annotation-tile-2');
      expect(decision.droppedQueuedRequestId).toBeNull();
    });

    it('a second supersede drops the prior queued entry', () => {
      let state = createAnnotationTileSemaphoreState();
      state = recordActiveStarted(state, req(1));
      state = recordQueuedSupersede(state, req(2));

      const decision = decideDispatch(state, req(3));
      expect(decision.kind).toBe('queued');
      if (decision.kind !== 'queued') throw new Error('narrowing');
      expect(decision.cancelRequestId).toBe('annotation-tile-1');
      expect(decision.queuedRequest.requestId).toBe('annotation-tile-3');
      expect(decision.droppedQueuedRequestId).toBe('annotation-tile-2');
    });

    it('inFlightCount stays bounded ≤ 2 across many supersedes', () => {
      let state = createAnnotationTileSemaphoreState();
      state = recordActiveStarted(state, req(1));
      for (let token = 2; token <= 100; token += 1) {
        state = recordQueuedSupersede(state, req(token));
        expect(inFlightCount(state)).toBeLessThanOrEqual(2);
      }
      expect(state.active?.token).toBe(1);
      expect(state.queued?.token).toBe(100);
    });
  });

  describe('recordActiveCleared', () => {
    it('returns idle when nothing was queued', () => {
      let state = createAnnotationTileSemaphoreState();
      state = recordActiveStarted(state, req(1));
      const { state: nextState, decision } = recordActiveCleared(state, 'annotation-tile-1');
      expect(decision).toEqual({ kind: 'idle' });
      expect(nextState.active).toBeNull();
      expect(nextState.queued).toBeNull();
    });

    it('promotes the queued request when the active clears', () => {
      let state = createAnnotationTileSemaphoreState();
      state = recordActiveStarted(state, req(1));
      state = recordQueuedSupersede(state, req(2));

      const { state: nextState, decision } = recordActiveCleared(state, 'annotation-tile-1');
      expect(decision.kind).toBe('dispatch-queued');
      if (decision.kind !== 'dispatch-queued') throw new Error('narrowing');
      expect(decision.request.requestId).toBe('annotation-tile-2');
      expect(nextState.active?.requestId).toBe('annotation-tile-2');
      expect(nextState.queued).toBeNull();
    });

    it('is idempotent against unrelated requestIds (late-arriving cleanup)', () => {
      let state = createAnnotationTileSemaphoreState();
      state = recordActiveStarted(state, req(5));

      const { state: unchanged, decision } = recordActiveCleared(state, 'annotation-tile-99');
      expect(decision).toEqual({ kind: 'idle' });
      expect(unchanged.active?.requestId).toBe('annotation-tile-5');
    });

    it('handles cleared-on-empty without panicking', () => {
      const state = createAnnotationTileSemaphoreState();
      const { state: unchanged, decision } = recordActiveCleared(state, 'annotation-tile-1');
      expect(decision).toEqual({ kind: 'idle' });
      expect(unchanged.active).toBeNull();
      expect(unchanged.queued).toBeNull();
    });
  });

  describe('end-to-end supersede sequence', () => {
    it('30 rapid camera-changes hold no more than 2 in-flight at any moment', () => {
      let state = createAnnotationTileSemaphoreState();
      let workerStartedCount = 0;
      let workerCancelledCount = 0;
      let workerCompletedCount = 0;

      const fireCameraChange = (token: number) => {
        const request = req(token);
        const decision = decideDispatch(state, request);
        if (decision.kind === 'dispatch') {
          state = recordActiveStarted(state, decision.request);
          workerStartedCount += 1;
        } else {
          workerCancelledCount += 1;
          state = recordQueuedSupersede(state, decision.queuedRequest);
        }
      };

      const drainActive = () => {
        if (!state.active) return;
        const cleared = state.active.requestId;
        workerCompletedCount += 1;
        const next = recordActiveCleared(state, cleared);
        state = next.state;
        if (next.decision.kind === 'dispatch-queued') {
          state = recordActiveStarted(state, next.decision.request);
          workerStartedCount += 1;
        }
      };

      for (let token = 1; token <= 30; token += 1) {
        fireCameraChange(token);
        expect(inFlightCount(state)).toBeLessThanOrEqual(2);
      }
      expect(workerStartedCount).toBe(1);
      expect(workerCancelledCount).toBe(29);

      drainActive();
      expect(workerStartedCount).toBe(2);
      expect(inFlightCount(state)).toBe(1);
      drainActive();
      expect(inFlightCount(state)).toBe(0);
      expect(workerCompletedCount).toBe(2);
    });
  });
});
