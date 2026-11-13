import type { TileTransport } from '@waypoint/genome-renderer';

interface RemoteTileSessionDrainState {
  activeRequests: number;
  release: (() => void) | null;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

const states = new Map<string, RemoteTileSessionDrainState>();

function stateFor(sessionId: string): RemoteTileSessionDrainState {
  const existing = states.get(sessionId);
  if (existing) return existing;
  const created: RemoteTileSessionDrainState = {
    activeRequests: 0,
    release: null,
    releaseTimer: null,
  };
  states.set(sessionId, created);
  return created;
}

function scheduleReleaseIfDrained(sessionId: string, state: RemoteTileSessionDrainState): void {
  if (state.activeRequests !== 0 || !state.release || state.releaseTimer) return;
  state.releaseTimer = globalThis.setTimeout(() => {
    state.releaseTimer = null;
    if (state.activeRequests !== 0 || !state.release) return;
    const release = state.release;
    states.delete(sessionId);
    release();
  }, 0);
}

export function trackRemoteTileSessionTransport(
  sessionId: string,
  transport: TileTransport
): TileTransport {
  return async (request, signal) => {
    if (signal.aborted) {
      throw new DOMException('The remote tile was cancelled before it started.', 'AbortError');
    }
    const state = stateFor(sessionId);
    if (state.releaseTimer) {
      globalThis.clearTimeout(state.releaseTimer);
      state.releaseTimer = null;
    }
    state.activeRequests += 1;
    try {
      return await transport(
        request,
        request.kind === 'alignment' ? signal : new AbortController().signal
      );
    } finally {
      state.activeRequests -= 1;
      scheduleReleaseIfDrained(sessionId, state);
    }
  };
}

export function releaseRemoteTileSessionWhenDrained(sessionId: string, release: () => void): void {
  const state = stateFor(sessionId);
  state.release ??= release;
  scheduleReleaseIfDrained(sessionId, state);
}
