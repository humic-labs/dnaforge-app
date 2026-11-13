import type { ShareBundleLimits } from './shared';
import { WORKSPACE_SYNC_MANIFEST_MAX_FILES } from './workspace-sync-limits';

export interface WorkspaceSyncStoragePolicy {
  schemaVersion: 1;
  policyKey: string;
  revision: number;
  maxFileBytes: number;
  maxProjectBytes: number;
  maxFiles: number;
  storageQuotaBytes: number;
}

const KEYS = new Set([
  'schemaVersion',
  'policyKey',
  'revision',
  'maxFileBytes',
  'maxProjectBytes',
  'maxFiles',
  'storageQuotaBytes',
]);

export function parseWorkspaceSyncStoragePolicy(value: unknown): WorkspaceSyncStoragePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const policy = value as Record<string, unknown>;
  if (Object.keys(policy).length !== KEYS.size || Object.keys(policy).some((key) => !KEYS.has(key)))
    invalid();
  if (
    policy.schemaVersion !== 1 ||
    typeof policy.policyKey !== 'string' ||
    !/^[a-z][a-z0-9_-]{0,63}$/u.test(policy.policyKey)
  )
    invalid();
  for (const key of [
    'revision',
    'maxFileBytes',
    'maxProjectBytes',
    'maxFiles',
    'storageQuotaBytes',
  ]) {
    if (!Number.isSafeInteger(policy[key]) || (policy[key] as number) <= 0) invalid();
  }
  if (
    (policy.maxFileBytes as number) > (policy.maxProjectBytes as number) ||
    (policy.maxProjectBytes as number) > (policy.storageQuotaBytes as number) ||
    (policy.maxFiles as number) > WORKSPACE_SYNC_MANIFEST_MAX_FILES
  )
    invalid();
  return { ...policy } as unknown as WorkspaceSyncStoragePolicy;
}

export function workspaceSyncStoragePolicyLimits(
  policy: WorkspaceSyncStoragePolicy
): ShareBundleLimits {
  const validated = parseWorkspaceSyncStoragePolicy(policy);
  return {
    maxFileBytes: validated.maxFileBytes,
    maxBundleBytes: validated.maxProjectBytes,
    maxFiles: validated.maxFiles,
  };
}

function invalid(): never {
  throw new Error('Workspace storage policy is missing or invalid.');
}
