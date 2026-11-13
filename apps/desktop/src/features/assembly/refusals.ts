import type { AssemblyState } from '../design/public/types';

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type DesignChangeSummary = {
  designId: string;
  version: number;
  changedFields: readonly string[];
};

export type RefusalReason =
  | {
      kind: 'bad_input';
      message: string;
      field?: string;
      acceptableValues?: readonly string[];
    }
  | {
      kind: 'state_conflict';
      message: string;
      currentState: AssemblyState;
      conflictWith?: { entityId: string; reason: string };
    }
  | {
      kind: 'sidecar_failure';
      message: string;
      upstreamCode?: string;
      retryable: boolean;
    }
  | {
      kind: 'stale_state';
      message: string;
      expectedVersion: number;
      actualVersion: number;
    };

export type ProgressEvent =
  | { phase: 'queued' }
  | { phase: 'sidecar'; step?: string; pct?: number }
  | { phase: 'finalizing' };

export type DispatchResult<T> = {
  result: Promise<Result<T, RefusalReason>>;
  progress: AsyncIterable<ProgressEvent>;
  abort: () => void;
};

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function badInput(
  message: string,
  field?: string,
  acceptableValues?: readonly string[]
): RefusalReason {
  return { kind: 'bad_input', message, field, acceptableValues };
}
