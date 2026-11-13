export const HOSTED_FS_ROOT = '/hosted';

const WORKSPACE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isHostedWorkspaceId(value: string | null | undefined): value is string {
  return typeof value === 'string' && WORKSPACE_ID_RE.test(value);
}

export function hostedWorkspaceRoot(workspaceId: string): string {
  if (!isHostedWorkspaceId(workspaceId)) {
    throw new Error('Hosted workspace roots are UUID folders under /hosted.');
  }
  return `${HOSTED_FS_ROOT}/${workspaceId}`;
}

export function hostedWorkspaceIdFromInput(value: string | null | undefined): string | null {
  if (!value) return null;
  return parseHostedFsPath(value)?.workspaceId ?? (isHostedWorkspaceId(value) ? value : null);
}

export function hostedAbsolutePath(workspaceId: string, relativePath = ''): string {
  const trimmed = relativePath.replace(/^\/+/u, '').replace(/\/+$/u, '');
  return trimmed
    ? `${hostedWorkspaceRoot(workspaceId)}/${trimmed}`
    : hostedWorkspaceRoot(workspaceId);
}

export function parseHostedFsPath(
  path: string
): { workspaceId: string | null; relativePath: string } | null {
  const normalized = path.replace(/\\/gu, '/').replace(/\/+$/u, '') || '/';
  if (normalized === HOSTED_FS_ROOT) return { workspaceId: null, relativePath: '' };
  if (!normalized.startsWith(`${HOSTED_FS_ROOT}/`)) return null;
  const rest = normalized.slice(HOSTED_FS_ROOT.length + 1);
  const slash = rest.indexOf('/');
  const workspaceId = slash < 0 ? rest : rest.slice(0, slash);
  if (!WORKSPACE_ID_RE.test(workspaceId)) return null;
  return {
    workspaceId,
    relativePath: slash < 0 ? '' : rest.slice(slash + 1),
  };
}
