import { MIN_ZOOM, MAX_ZOOM } from './zoom-math';
export { MIN_ZOOM, MAX_ZOOM };

export const COMMIT_INTERVAL_MS = 100;

export const SETTLE_TIMEOUT_MS = 300;

export type WheelInput = {
  deltaY: number;
  deltaMode: number;
  clientX: number;
  clientY: number;
};

export type WheelContext = {
  now: number;
  anchorBpFromCursor: (clientX: number, clientY: number) => number | null;
  currentZoom: number;
};

export type GestureState =
  | { phase: 'idle' }
  | {
      phase: 'active';
      gestureScale: number;
      cursor: { x: number; y: number };
      anchor: { bp: number; cursorX: number; cursorY: number };
      lastWheelAt: number;
      lastCommitAt: number | null;
    };

export const INITIAL_STATE: GestureState = { phase: 'idle' };

export type TransformEffect = {
  kind: 'setTransform';
  scale: number;
  origin: { x: number; y: number };
};

export type CommitEffect = {
  kind: 'commit';
  scaleDelta: number;
  anchorBp: number;
  anchorCursorX: number;
  anchorCursorY: number;
};

export type ResetEffect = { kind: 'resetTransform' };

export type WheelResult = {
  state: GestureState;
  effects: TransformEffect[];
};

export type TickResult = {
  state: GestureState;
  effects: Array<CommitEffect | ResetEffect>;
};

export type SettleResult = {
  state: GestureState;
  effects: Array<CommitEffect | ResetEffect>;
};

function wheelToScaleFactor(deltaY: number, deltaMode: number): number {
  const LINE_PX = 16;
  const PAGE_PX = 320;
  const pixels = deltaMode === 1 ? deltaY * LINE_PX : deltaMode === 2 ? deltaY * PAGE_PX : deltaY;
  return Math.pow(1.001, -pixels);
}

function clampGestureScale(gestureScale: number, currentZoom: number): number {
  const safeZoom = currentZoom > 0 ? currentZoom : 1;
  const minScale = MIN_ZOOM / safeZoom;
  const maxScale = MAX_ZOOM / safeZoom;
  if (gestureScale < minScale) return minScale;
  if (gestureScale > maxScale) return maxScale;
  return gestureScale;
}

export function onWheel(state: GestureState, input: WheelInput, ctx: WheelContext): WheelResult {
  const tickFactor = wheelToScaleFactor(input.deltaY, input.deltaMode);

  if (state.phase === 'idle') {
    const anchorBp = ctx.anchorBpFromCursor(input.clientX, input.clientY);
    if (anchorBp === null) {
      return { state, effects: [] };
    }
    const scale = clampGestureScale(tickFactor, ctx.currentZoom);
    const newState: GestureState = {
      phase: 'active',
      gestureScale: scale,
      cursor: { x: input.clientX, y: input.clientY },
      anchor: { bp: anchorBp, cursorX: input.clientX, cursorY: input.clientY },
      lastWheelAt: ctx.now,
      lastCommitAt: null,
    };
    return {
      state: newState,
      effects: [
        {
          kind: 'setTransform',
          scale,
          origin: { x: input.clientX, y: input.clientY },
        },
      ],
    };
  }

  const rawScale = state.gestureScale * tickFactor;
  const scale = clampGestureScale(rawScale, ctx.currentZoom);
  const newState: GestureState = {
    ...state,
    gestureScale: scale,
    cursor: { x: input.clientX, y: input.clientY },
    lastWheelAt: ctx.now,
  };
  return {
    state: newState,
    effects: [
      {
        kind: 'setTransform',
        scale,
        origin: { x: input.clientX, y: input.clientY },
      },
    ],
  };
}

export function onTick(state: GestureState, now: number): TickResult {
  if (state.phase !== 'active') return { state, effects: [] };

  if (state.gestureScale === 1) return { state, effects: [] };

  if (state.lastCommitAt !== null && state.lastWheelAt <= state.lastCommitAt) {
    return { state, effects: [] };
  }

  if (state.lastCommitAt !== null && now - state.lastCommitAt < COMMIT_INTERVAL_MS) {
    return { state, effects: [] };
  }

  const commit: CommitEffect = {
    kind: 'commit',
    scaleDelta: state.gestureScale,
    anchorBp: state.anchor.bp,
    anchorCursorX: state.anchor.cursorX,
    anchorCursorY: state.anchor.cursorY,
  };
  const newState: GestureState = {
    ...state,
    gestureScale: 1,
    lastCommitAt: now,
  };
  return {
    state: newState,
    effects: [commit, { kind: 'resetTransform' }],
  };
}

export function onSettle(state: GestureState, _now: number): SettleResult {
  if (state.phase !== 'active') return { state, effects: [] };

  if (state.gestureScale === 1) {
    return { state: { phase: 'idle' }, effects: [] };
  }

  const commit: CommitEffect = {
    kind: 'commit',
    scaleDelta: state.gestureScale,
    anchorBp: state.anchor.bp,
    anchorCursorX: state.anchor.cursorX,
    anchorCursorY: state.anchor.cursorY,
  };
  return {
    state: { phase: 'idle' },
    effects: [commit, { kind: 'resetTransform' }],
  };
}

export function computeAnchoredScrollTop(
  anchorBp: number,
  anchorCursorY: number,
  rowTopForBp: (bp: number) => number | null
): number | null {
  const rowTop = rowTopForBp(anchorBp);
  if (rowTop === null) return null;
  return Math.max(0, rowTop - anchorCursorY);
}
