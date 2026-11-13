export const WORKSPACE_SCOPE_SEP = '::';

export function workspaceScopeKey(
  repoUuid: string | null | undefined,
  workspaceId: number | null | undefined
): string | null {
  if (repoUuid && repoUuid.length > 0) return repoUuid;
  if (workspaceId != null) return `ws${workspaceId}`;
  return null;
}

export function stripWorkspaceScope(embeddedId: string): string {
  const idx = embeddedId.lastIndexOf(WORKSPACE_SCOPE_SEP);
  return idx === -1 ? embeddedId : embeddedId.slice(idx + WORKSPACE_SCOPE_SEP.length);
}

export function scopedProjectionId(scope: string | null | undefined, embeddedId: string): string {
  const raw = stripWorkspaceScope(embeddedId);
  return scope ? `${scope}${WORKSPACE_SCOPE_SEP}${raw}` : raw;
}

export function hasWorkspaceScope(id: string): boolean {
  return id.includes(WORKSPACE_SCOPE_SEP);
}
