import type { RemotePileupConnectionState } from './pileup-source';

export type AlignedReadTrackReadyKind = 'coverage' | 'reads' | 'empty';

export type AlignedReadTrackStatus =
  | { phase: 'loading' }
  | { phase: 'refreshing'; hasLastGood: true }
  | { phase: 'stalled'; hasLastGood: boolean; elapsedMs: number }
  | { phase: 'recovering'; attempt: number; hasLastGood: boolean }
  | { phase: 'waiting-for-authentication'; hasLastGood: boolean }
  | {
      phase: 'blocked';
      message: string;
      action: 'retry' | 'repair';
      hasLastGood: boolean;
    }
  | { phase: 'ready'; kind: AlignedReadTrackReadyKind };

export type AlignedReadTrackStatusSnapshot = Readonly<Record<string, AlignedReadTrackStatus>>;

export type AlignedReadTrackStatusTone = 'neutral' | 'loading' | 'recovering' | 'blocked';

export type AlignedReadTrackStatusView = {
  tone: AlignedReadTrackStatusTone;
  gutterLabel: string;
  actionLabel: string | null;
};

export function alignedReadStatusWithRemoteConnection(
  tileStatus: AlignedReadTrackStatus,
  connection: RemotePileupConnectionState | undefined
): AlignedReadTrackStatus {
  if (!connection || connection.state === 'online') return tileStatus;
  const hasLastGood = connection.transportGeneration > 0;
  if (connection.state === 'needs-authentication') {
    return { phase: 'waiting-for-authentication', hasLastGood };
  }
  if (connection.state === 'blocked') {
    return {
      phase: 'blocked',
      message: connection.lastFailure?.message ?? 'The remote source needs attention.',
      action: 'repair',
      hasLastGood,
    };
  }
  if (connection.state === 'retrying' || hasLastGood) {
    return { phase: 'recovering', attempt: Math.max(1, connection.attempt), hasLastGood };
  }
  return { phase: 'loading' };
}

export interface AlignedReadTrackLifecycleSignal {
  getSnapshot: () => AlignedReadTrackStatusSnapshot;
  subscribe: (listener: () => void) => () => void;
}

export interface ReferenceInterval {
  readonly startBp: number;
  readonly endBp: number;
  readonly state: 'pending' | 'empty';
}

export type ReferenceIntervalSnapshot = Readonly<Record<string, readonly ReferenceInterval[]>>;

export interface MutableAlignedReadTrackLifecycleSignal extends AlignedReadTrackLifecycleSignal {
  getIntervalSnapshot: () => ReferenceIntervalSnapshot;
  set: (trackId: string, status: AlignedReadTrackStatus) => void;
  setIntervals: (trackId: string, intervals: readonly ReferenceInterval[]) => void;
  remove: (trackId: string) => void;
  retain: (trackIds: ReadonlySet<string>) => void;
  clear: () => void;
}

const EMPTY_SNAPSHOT: AlignedReadTrackStatusSnapshot = Object.freeze({});
const EMPTY_INTERVALS: ReferenceIntervalSnapshot = Object.freeze({});

function referenceIntervalsEqual(
  left: readonly ReferenceInterval[],
  right: readonly ReferenceInterval[]
): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (interval, index) =>
      interval.state === right[index]?.state &&
      interval.startBp === right[index]?.startBp &&
      interval.endBp === right[index]?.endBp
  );
}

export function createAlignedReadTrackLifecycleSignal(): MutableAlignedReadTrackLifecycleSignal {
  let snapshot = EMPTY_SNAPSHOT;
  let intervals = EMPTY_INTERVALS;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const publish = (next: AlignedReadTrackStatusSnapshot): void => {
    if (next === snapshot) return;
    snapshot = next;
    notify();
  };

  const publishIntervals = (next: ReferenceIntervalSnapshot): void => {
    if (next === intervals) return;
    intervals = next;
    notify();
  };

  return {
    getSnapshot: () => snapshot,
    getIntervalSnapshot: () => intervals,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (trackId, status) => {
      const current = snapshot[trackId];
      if (current && alignedReadTrackStatusesEqual(current, status)) return;
      publish(Object.freeze({ ...snapshot, [trackId]: Object.freeze(status) }));
    },
    setIntervals: (trackId, nextIntervals) => {
      const current = intervals[trackId] ?? [];
      if (referenceIntervalsEqual(current, nextIntervals)) return;
      if (nextIntervals.length === 0) {
        if (!(trackId in intervals)) return;
        const next = { ...intervals };
        delete next[trackId];
        publishIntervals(Object.keys(next).length === 0 ? EMPTY_INTERVALS : Object.freeze(next));
        return;
      }
      publishIntervals(Object.freeze({ ...intervals, [trackId]: Object.freeze(nextIntervals) }));
    },
    remove: (trackId) => {
      const hadIntervals = trackId in intervals;
      if (hadIntervals) {
        const nextIntervals = { ...intervals };
        delete nextIntervals[trackId];
        intervals =
          Object.keys(nextIntervals).length === 0 ? EMPTY_INTERVALS : Object.freeze(nextIntervals);
      }
      if (!(trackId in snapshot)) {
        if (hadIntervals) notify();
        return;
      }
      const next = { ...snapshot };
      delete next[trackId];
      publish(Object.keys(next).length === 0 ? EMPTY_SNAPSHOT : Object.freeze(next));
    },
    retain: (trackIds) => {
      const nextIntervalEntries = Object.entries(intervals).filter(([trackId]) =>
        trackIds.has(trackId)
      );
      const intervalsChanged = nextIntervalEntries.length !== Object.keys(intervals).length;
      if (intervalsChanged) {
        intervals =
          nextIntervalEntries.length === 0
            ? EMPTY_INTERVALS
            : Object.freeze(Object.fromEntries(nextIntervalEntries));
      }
      const nextEntries = Object.entries(snapshot).filter(([trackId]) => trackIds.has(trackId));
      if (nextEntries.length === Object.keys(snapshot).length) {
        if (intervalsChanged) notify();
        return;
      }
      publish(
        nextEntries.length === 0
          ? EMPTY_SNAPSHOT
          : Object.freeze(Object.fromEntries(nextEntries) as Record<string, AlignedReadTrackStatus>)
      );
    },
    clear: () => {
      intervals = EMPTY_INTERVALS;
      publish(EMPTY_SNAPSHOT);
    },
  };
}

export type AlignedReadTileFailureClass = 'transient' | 'timeout' | 'permanent';

export function classifyAlignedReadTileFailure(reason: string): AlignedReadTileFailureClass {
  if (reason === 'timeout') return 'timeout';
  if (
    reason === 'stalled' ||
    reason === 'queue-full' ||
    reason === 'fetch-failed' ||
    reason === 'http-0'
  ) {
    return 'transient';
  }
  if (/^http-5\d\d$/.test(reason) || reason === 'http-408' || reason === 'http-429') {
    return 'transient';
  }
  return 'permanent';
}

export const ALIGNED_READ_TRANSIENT_RETRY_DELAYS_MS = [
  500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000,
] as const;
export const ALIGNED_READ_TIMEOUT_RETRY_DELAYS_MS = [
  500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000,
] as const;

export function alignedReadRetryDelayMs(reason: string, completedAttempts: number): number | null {
  const failureClass = classifyAlignedReadTileFailure(reason);
  const delays =
    failureClass === 'transient'
      ? ALIGNED_READ_TRANSIENT_RETRY_DELAYS_MS
      : failureClass === 'timeout'
        ? ALIGNED_READ_TIMEOUT_RETRY_DELAYS_MS
        : [];
  if (delays.length === 0) return null;
  return delays[Math.min(Math.max(0, completedAttempts), delays.length - 1)]!;
}

export function alignedReadBlockedStatus(
  reason: string,
  hasLastGood: boolean
): Extract<AlignedReadTrackStatus, { phase: 'blocked' }> {
  const retryable = classifyAlignedReadTileFailure(reason) !== 'permanent';
  return {
    phase: 'blocked',
    message:
      reason === 'http-409'
        ? 'The aligned-read source changed on disk.'
        : retryable
          ? 'Aligned reads could not reconnect.'
          : 'The aligned-read source needs attention.',
    action: retryable ? 'retry' : 'repair',
    hasLastGood,
  };
}

export function alignedReadTrackStatusView(
  status: AlignedReadTrackStatus,
  options: { readonly remote?: boolean; readonly remoteEndpointLabel?: string } = {}
): AlignedReadTrackStatusView {
  const remote = options.remote === true;
  const remoteEndpointLabel = options.remoteEndpointLabel?.trim() || 'Remote source';
  switch (status.phase) {
    case 'loading':
      return {
        tone: 'loading',
        gutterLabel: remote ? `Opening ${remoteEndpointLabel}…` : 'Loading',
        actionLabel: null,
      };
    case 'refreshing':
      return {
        tone: 'loading',
        gutterLabel: remote ? `Streaming from ${remoteEndpointLabel}…` : 'Loading new region…',
        actionLabel: null,
      };
    case 'stalled':
      return {
        tone: 'recovering',
        gutterLabel: remote ? `${remoteEndpointLabel} slow — still waiting` : 'Still waiting',
        actionLabel: 'Retry',
      };
    case 'recovering':
      return {
        tone: 'recovering',
        gutterLabel: remote ? `Reconnecting ${remoteEndpointLabel}…` : 'Reconnecting…',
        actionLabel: remote ? 'Retry' : null,
      };
    case 'waiting-for-authentication':
      return {
        tone: 'recovering',
        gutterLabel: remote
          ? `Sign in to ${remoteEndpointLabel} in Terminal, then click Retry`
          : 'Sign in to the remote source in Terminal, then click Retry',
        actionLabel: 'Retry',
      };
    case 'blocked':
      return {
        tone: 'blocked',
        gutterLabel: status.message,
        actionLabel: status.action === 'repair' ? 'Repair' : 'Retry',
      };
    case 'ready':
      if (status.kind === 'empty') {
        return {
          tone: 'neutral',
          gutterLabel: remote ? `${remoteEndpointLabel} live • no reads here` : 'No reads here',
          actionLabel: null,
        };
      }
      if (status.kind === 'coverage') {
        return {
          tone: 'neutral',
          gutterLabel: remote ? `${remoteEndpointLabel} live • zoom in for reads` : 'Coverage',
          actionLabel: null,
        };
      }
      return {
        tone: 'neutral',
        gutterLabel: remote ? `${remoteEndpointLabel} live • reads` : 'Reads',
        actionLabel: null,
      };
  }
}

function alignedReadTrackStatusesEqual(
  left: AlignedReadTrackStatus,
  right: AlignedReadTrackStatus
): boolean {
  if (left.phase !== right.phase) return false;
  if (left.phase === 'loading' && right.phase === 'loading') return true;
  if (left.phase === 'refreshing' && right.phase === 'refreshing') {
    return left.hasLastGood === right.hasLastGood;
  }
  if (left.phase === 'stalled' && right.phase === 'stalled') {
    return left.hasLastGood === right.hasLastGood && left.elapsedMs === right.elapsedMs;
  }
  if (left.phase === 'ready' && right.phase === 'ready') return left.kind === right.kind;
  if (left.phase === 'recovering' && right.phase === 'recovering') {
    return left.attempt === right.attempt && left.hasLastGood === right.hasLastGood;
  }
  if (left.phase === 'waiting-for-authentication' && right.phase === 'waiting-for-authentication') {
    return left.hasLastGood === right.hasLastGood;
  }
  if (left.phase === 'blocked' && right.phase === 'blocked') {
    return (
      left.message === right.message &&
      left.action === right.action &&
      left.hasLastGood === right.hasLastGood
    );
  }
  return false;
}
