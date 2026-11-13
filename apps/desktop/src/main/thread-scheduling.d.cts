import type {
  ThreadSchedulingMinimum,
  ThreadSchedulingObservation,
} from '../shared/thread-scheduling';

export type { ThreadSchedulingObservation } from '../shared/thread-scheduling';

interface NativeThreadScheduling {
  getRequestedQos(): number;
  getNativeThreadId(): string;
  setRequestedQos(qos: number, relativePriority: number): number;
}

interface ThreadSchedulingRuntime {
  readonly platform?: string;
  readonly pid?: number;
  readonly loadNative?: () => NativeThreadScheduling;
}

export function readCurrentThreadScheduling(
  runtime?: ThreadSchedulingRuntime
): ThreadSchedulingObservation;

export function preferCurrentThread(
  minimum: ThreadSchedulingMinimum,
  runtime?: ThreadSchedulingRuntime
): ThreadSchedulingObservation;
