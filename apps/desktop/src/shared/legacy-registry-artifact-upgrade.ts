export interface LegacyRegistryArtifactUpgradeInput {
  workspaceId: number;
  workspaceRoot: string;
  path: string;
  entityId: string;
  expectedContentHash: string;
}

export interface LegacyRegistryArtifactUpgradeResult {
  published: boolean;
}

export function parseLegacyRegistryArtifactUpgradeInput(
  value: unknown
): LegacyRegistryArtifactUpgradeInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Registry format upgrade requires checked source identity.');
  if (
    !('workspaceId' in value) ||
    typeof value.workspaceId !== 'number' ||
    !Number.isSafeInteger(value.workspaceId) ||
    value.workspaceId <= 0 ||
    !('workspaceRoot' in value) ||
    typeof value.workspaceRoot !== 'string' ||
    value.workspaceRoot.length === 0 ||
    value.workspaceRoot.length > 4096 ||
    !('path' in value) ||
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    value.path.length > 4096 ||
    !('entityId' in value) ||
    typeof value.entityId !== 'string' ||
    value.entityId.length === 0 ||
    value.entityId.length > 512 ||
    !('expectedContentHash' in value) ||
    typeof value.expectedContentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.expectedContentHash) ||
    Object.keys(value).some(
      (key) =>
        !['workspaceId', 'workspaceRoot', 'path', 'entityId', 'expectedContentHash'].includes(key)
    )
  )
    throw new Error('Registry format upgrade requires bounded source identity and SHA-256.');
  return {
    workspaceId: value.workspaceId,
    workspaceRoot: value.workspaceRoot,
    path: value.path,
    entityId: value.entityId,
    expectedContentHash: value.expectedContentHash,
  };
}
