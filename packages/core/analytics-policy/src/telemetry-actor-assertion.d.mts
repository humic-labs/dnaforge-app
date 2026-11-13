export type AssertableTelemetryActor = 'maintainer' | 'ci';

export type TelemetryActorAssertionClaims =
  | {
      readonly actor: 'maintainer';
      readonly appVersion: string;
      readonly buildTag: string;
      readonly releaseChannel: 'closed_beta' | 'prod';
      readonly issuedAt: number;
      readonly expiresAt: number;
      readonly nonce: string;
    }
  | {
      readonly actor: 'ci';
      readonly appVersion: string;
      readonly buildTag: string;
      readonly releaseChannel: 'closed_beta' | 'prod';
      readonly ciRunId: string;
      readonly issuedAt: number;
      readonly expiresAt: number;
      readonly nonce: string;
    };

export interface MintTelemetryActorAssertionInput {
  readonly privateKey: string;
  readonly actor: AssertableTelemetryActor;
  readonly appVersion: string;
  readonly buildTag: string;
  readonly releaseChannel: 'closed_beta' | 'prod';
  readonly ciRunId?: string;
  readonly nowMs?: number;
  readonly lifetimeSeconds?: number;
  readonly nonce?: string;
}

export interface VerifyTelemetryActorAssertionInput {
  readonly token: unknown;
  readonly publicKey: string;
  readonly actor: AssertableTelemetryActor;
  readonly appVersion: string | null;
  readonly buildTag: string | null;
  readonly releaseChannel: string | null;
  readonly ciRunId?: string;
  readonly eventTimeMs?: number;
  readonly nowMs?: number;
  readonly allowHistoricalReceipt?: boolean;
}

export type VerifyTelemetryActorAssertionResult =
  | { readonly kind: 'accepted'; readonly claims: TelemetryActorAssertionClaims }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'invalid' };

export function mintTelemetryActorAssertion(input: MintTelemetryActorAssertionInput): string;

export function verifyTelemetryActorAssertion(
  input: VerifyTelemetryActorAssertionInput
): TelemetryActorAssertionClaims | null;

export function verifyTelemetryActorAssertionResult(
  input: VerifyTelemetryActorAssertionInput
): VerifyTelemetryActorAssertionResult;

export function deriveTelemetryActorAssertionPublicKey(privateKey: string): string;

export function isTelemetryActorAssertionToken(value: unknown): value is string;

export function sealTelemetryActorAssertionPublicKey(value: unknown): string;

export function telemetryActorAssertionPublicKeyFromStamp(value: unknown): string | null;

export interface PublicTelemetryActorResolution {
  readonly telemetryActor: 'user' | 'dev' | 'canary' | 'ci' | 'maintainer' | null;
  readonly ciRunId?: string;
  readonly assertionAccepted: boolean;
}

export interface PublicTelemetryActorInput {
  readonly requestedActor: unknown;
  readonly assertion: unknown;
  readonly publicKey: string;
  readonly appVersion: string | null;
  readonly buildTag: string | null;
  readonly releaseChannel: string | null;
  readonly ciRunId: unknown;
  readonly eventTimeMs?: number;
  readonly nowMs?: number;
  readonly allowHistoricalReceipt?: boolean;
}

export function resolvePublicTelemetryActor(
  input: PublicTelemetryActorInput
): PublicTelemetryActorResolution;

export interface TelemetryActorDimensions {
  readonly telemetry_actor: NonNullable<PublicTelemetryActorResolution['telemetryActor']>;
  readonly ci_run_id?: string;
}

export function canonicalTelemetryActorDimensions(value: unknown): TelemetryActorDimensions | null;
