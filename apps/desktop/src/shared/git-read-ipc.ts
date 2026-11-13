export const GIT_READ_UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type GitReadCancelReason = 'caller' | 'sender-destroyed' | 'timeout' | 'shutdown';

export interface GitReadTabCloseAbortReason {
  readonly kind: 'tab-close';
  readonly closeGestureToken: string;
}

export interface GitReadPhysicalCancellationEvent {
  readonly sequence: number;
  readonly requestId: string;
  readonly reason: GitReadCancelReason;
  readonly closeGestureToken: string | null;
}

export function isGitReadUuid(value: unknown): value is string {
  return typeof value === 'string' && GIT_READ_UUID_V4_PATTERN.test(value);
}

export function isGitReadTabCloseAbortReason(value: unknown): value is GitReadTabCloseAbortReason {
  if (typeof value !== 'object' || value === null) return false;
  if (!('kind' in value) || !('closeGestureToken' in value)) return false;
  return value.kind === 'tab-close' && isGitReadUuid(value.closeGestureToken);
}

export interface GitReadLifecycleSnapshot {
  readonly active: number;
  readonly queued: number;
  readonly physicalChildren: number;
  readonly uncancelledPhysicalChildren: number;
  readonly activeUncancelledPhysicalRequestIds: readonly string[];
  readonly started: number;
  readonly settled: number;
  readonly cancelled: number;
  readonly cancelledWithPhysicalChild: number;
  readonly callerCancelledWithPhysicalChild: number;
  readonly senderDestroyedWithPhysicalChild: number;
  readonly timedOutWithPhysicalChild: number;
  readonly shutdownWithPhysicalChild: number;
  readonly timedOut: number;
  readonly peakActive: number;
  readonly peakQueued: number;
  readonly maxActive: number;
  readonly maxQueued: number;
  readonly physicalCancellationEventSequence: number;
  readonly recentPhysicalCancellations: readonly GitReadPhysicalCancellationEvent[];
  readonly maxRecentPhysicalCancellations: number;
}
