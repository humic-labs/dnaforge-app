import {
  parseWorkspaceSyncStoragePolicy,
  type WorkspaceSyncStoragePolicy,
} from './workspace-sync-storage-policy';

export type WorkspaceFileSelectionVersion = 0 | 1;

export interface WorkspaceSyncPublicationPolicy {
  schema: 'dnaforge.workspace-sync-publication-policy/v1';
  policy: WorkspaceSyncStoragePolicy;
  fileSelection: { supportedVersion: 1; requiredVersion: WorkspaceFileSelectionVersion };
}

export function parseWorkspaceFileSelectionVersion(value: unknown): WorkspaceFileSelectionVersion {
  if (value === undefined) return 0;
  if (value === 0 || value === 1) return value;
  throw new Error('Workspace file selection version must be 0 or 1.');
}

export function parseWorkspaceSyncPublicationPolicy(
  value: unknown
): WorkspaceSyncPublicationPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'fileSelection,policy,schema' ||
    record.schema !== 'dnaforge.workspace-sync-publication-policy/v1'
  )
    invalid();
  if (
    !record.fileSelection ||
    typeof record.fileSelection !== 'object' ||
    Array.isArray(record.fileSelection)
  )
    invalid();
  const selection = record.fileSelection as Record<string, unknown>;
  if (
    Object.keys(selection).sort().join(',') !== 'requiredVersion,supportedVersion' ||
    selection.supportedVersion !== 1 ||
    (selection.requiredVersion !== 0 && selection.requiredVersion !== 1)
  )
    invalid();
  return {
    schema: 'dnaforge.workspace-sync-publication-policy/v1',
    policy: parseWorkspaceSyncStoragePolicy(record.policy),
    fileSelection: { supportedVersion: 1, requiredVersion: selection.requiredVersion },
  };
}

function invalid(): never {
  throw new Error('The service does not support this project file selection policy.');
}
