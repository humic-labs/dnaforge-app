import { soleReadableProjectRoot } from './project-root-selection';

export interface WorkspaceFolderRef {
  path: string;
  pinned?: boolean;
}

export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(p);
}

export function parseSequenceDbId(entityId: string): number | null {
  const match = /^seq_(\d+)$/.exec(entityId);
  return match ? Number(match[1]) : null;
}

export function looksLikeWorkspacePath(entityId: string): boolean {
  if (!entityId) return false;
  if (/[\\/]/.test(entityId)) return true;
  return /\.[A-Za-z0-9]{1,10}$/.test(entityId);
}

function canonical(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
}

function isContainedIn(child: string, root: string): boolean {
  const c = canonical(child);
  const r = canonical(root);
  return c === r || c.startsWith(`${r}/`);
}

export function resolveWorkspaceEntityPath(
  entityId: string,
  folders: readonly WorkspaceFolderRef[]
): string | null {
  if (!entityId) return null;
  if (!looksLikeWorkspacePath(entityId)) return null;
  if (entityId.split(/[\\/]/).some((seg) => seg === '..')) return null;
  const roots = folders.map((f) => f.path).filter(Boolean);

  if (isAbsolutePath(entityId)) {
    return roots.some((root) => isContainedIn(entityId, root)) ? entityId : null;
  }

  const rel = entityId.replace(/^[\\/]+/, '');
  const segments = rel.split(/[\\/]/);
  if (segments.some((seg) => seg === '.')) return null;

  const root = soleReadableProjectRoot(folders)?.path;
  if (!root) return null;
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const cleanRoot = root.replace(/[\\/]+$/, '');
  const resolved = `${cleanRoot}${sep}${segments.join(sep)}`;
  return isContainedIn(resolved, root) ? resolved : null;
}

export function workspacePathCandidates(
  relativePath: string,
  folders: readonly WorkspaceFolderRef[],
  preferredRoot?: string | null
): string[] {
  if (!relativePath || isAbsolutePath(relativePath)) return [];
  const segments = relativePath.replace(/^[\\/]+/, '').split(/[\\/]/);
  if (segments.some((seg) => seg === '..' || seg === '.' || seg === '')) return [];

  const roots = folders
    .filter((f) => !f.pinned)
    .map((f) => f.path)
    .filter(Boolean);
  const ordered = preferredRoot
    ? [preferredRoot, ...roots.filter((r) => canonical(r) !== canonical(preferredRoot))]
    : roots;

  const out: string[] = [];
  for (const root of ordered) {
    const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
    const cleanRoot = root.replace(/[\\/]+$/, '');
    const joined = `${cleanRoot}${sep}${segments.join(sep)}`;
    if (isContainedIn(joined, root) && !out.includes(joined)) out.push(joined);
  }
  return out;
}
