import type { UserMessageKey } from '@waypoint/user-messages';

const keys: Readonly<Record<string, UserMessageKey>> = {
  VARIANT_SOURCE_CHANGED: 'variant.sourceChanged',
  VARIANT_SOURCE_ASSEMBLY_MISMATCH: 'variant.assemblyMismatch',
};

export function variantMessageKey(
  code: string,
  fallback: UserMessageKey = 'variant.queryFailed'
): UserMessageKey {
  return Object.hasOwn(keys, code) ? keys[code]! : fallback;
}
