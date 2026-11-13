export type TelemetrySuppressionReason =
  | 'packaged_update_test'
  | 'packaged_validation_test'
  | 'invalid_internal_assertion';

export type TelemetrySuppressionFenceResolution =
  | { readonly kind: 'absent' }
  | { readonly kind: 'expired'; readonly path: string }
  | {
      readonly kind: 'active';
      readonly path: string;
      readonly reason: TelemetrySuppressionReason | 'invalid_fence';
      readonly leaseId?: string;
      readonly expiresAtMs?: number;
    };

export interface WriteTelemetrySuppressionFenceInput {
  readonly userDataPath: string;
  readonly reason: Exclude<TelemetrySuppressionReason, 'invalid_internal_assertion'>;
  readonly expiresAtMs: number;
  readonly nowMs?: number;
}

export function telemetrySuppressionFencePath(userDataPath: string): string;

export function resolveTelemetrySuppressionFence(input: {
  readonly userDataPath: string;
  readonly nowMs?: number;
}): TelemetrySuppressionFenceResolution;

export function writeTelemetrySuppressionFence(input: WriteTelemetrySuppressionFenceInput): {
  readonly path: string;
  readonly leaseId: string;
};

export function clearTelemetrySuppressionFence(input: {
  readonly userDataPath: string;
  readonly leaseId: string;
}): boolean;
