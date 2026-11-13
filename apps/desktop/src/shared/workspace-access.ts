export type WorkspaceAccess = 'writable' | 'reference';

export const DEFAULT_WORKSPACE_ACCESS: WorkspaceAccess = 'writable';

export interface WorkspaceOwnerDiscovery {
  name?: string;
  recordOpen?: boolean;
}

export function workspaceCanContributeRecentEdits(
  access: WorkspaceAccess | null | undefined
): boolean {
  return access == null || access === 'writable';
}

export function normalizeWorkspaceTimestamp(value: number | null | undefined): number | null {
  if (value == null) return null;
  return value >= 1_000_000_000 && value < 10_000_000_000 ? value * 1000 : value;
}
