export interface WebMaintainerSessionClaims {
  readonly origin: string;
  readonly deploymentSha: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly nonce: string;
}

export function isWebMaintainerSessionAssertion(value: unknown): boolean;

export function mintWebMaintainerSessionAssertion(input: {
  readonly privateKey: string;
  readonly origin: string;
  readonly deploymentSha: string;
  readonly nowMs?: number;
  readonly lifetimeSeconds?: number;
  readonly nonce?: string;
}): string;

export function verifyWebMaintainerSessionAssertion(input: {
  readonly token: unknown;
  readonly publicKey: string;
  readonly origin: string;
  readonly deploymentSha: string;
  readonly nowMs?: number;
}): WebMaintainerSessionClaims | null;
