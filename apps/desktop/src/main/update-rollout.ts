import { createHash } from 'node:crypto';

export const EXACT_CI_ROLLOUT_FIELD = 'dnaforgeCiRolloutIdSha256';
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export type ExactCiRolloutDecision =
  | { kind: 'delegate' }
  | { kind: 'admit' }
  | { kind: 'reject'; reason: 'malformed-manifest-field' | 'profile-mismatch' };

export function resolveExactCiRolloutDecision(input: {
  updateInfo: object & Partial<Record<typeof EXACT_CI_ROLLOUT_FIELD, unknown>>;
  rolloutId: string;
}): ExactCiRolloutDecision {
  if (!Object.hasOwn(input.updateInfo, EXACT_CI_ROLLOUT_FIELD)) {
    return { kind: 'delegate' };
  }
  const expectedDigest = input.updateInfo[EXACT_CI_ROLLOUT_FIELD];
  if (typeof expectedDigest !== 'string' || !SHA256_HEX_RE.test(expectedDigest)) {
    return { kind: 'reject', reason: 'malformed-manifest-field' };
  }
  const actualDigest = createHash('sha256').update(input.rolloutId, 'utf8').digest('hex');
  return actualDigest === expectedDigest
    ? { kind: 'admit' }
    : { kind: 'reject', reason: 'profile-mismatch' };
}
