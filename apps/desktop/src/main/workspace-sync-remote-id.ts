const WORKSPACE_SYNC_REMOTE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isWorkspaceSyncRemoteUuid(value: unknown): value is string {
  return typeof value === 'string' && WORKSPACE_SYNC_REMOTE_UUID_RE.test(value);
}
