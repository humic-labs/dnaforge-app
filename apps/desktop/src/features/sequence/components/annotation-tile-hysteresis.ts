export const DEFAULT_HYSTERESIS_BP_PER_MS = 50_000;

export interface HysteresisSample {
  visibleBp: number;
  timestampMs: number;
}

export interface HysteresisInput {
  previous: HysteresisSample | null;
  current: HysteresisSample;
  maxBpPerMs?: number;
}

export type HysteresisDecision =
  | { kind: 'fire'; reason: 'no-prior-sample' | 'below-threshold' }
  | {
      kind: 'wait';
      reason: 'above-threshold';
      velocityBpPerMs: number;
      maxBpPerMs: number;
    };

export function decideHysteresis(input: HysteresisInput): HysteresisDecision {
  const max = input.maxBpPerMs ?? DEFAULT_HYSTERESIS_BP_PER_MS;
  if (!Number.isFinite(max) || max <= 0) {
    return { kind: 'fire', reason: 'below-threshold' };
  }
  if (input.previous === null) {
    return { kind: 'fire', reason: 'no-prior-sample' };
  }
  const dtMs = input.current.timestampMs - input.previous.timestampMs;
  if (!Number.isFinite(dtMs) || dtMs <= 0) {
    return { kind: 'fire', reason: 'below-threshold' };
  }
  const dBp = Math.abs(input.current.visibleBp - input.previous.visibleBp);
  const velocity = dBp / dtMs;
  if (velocity > max) {
    return {
      kind: 'wait',
      reason: 'above-threshold',
      velocityBpPerMs: velocity,
      maxBpPerMs: max,
    };
  }
  return { kind: 'fire', reason: 'below-threshold' };
}
