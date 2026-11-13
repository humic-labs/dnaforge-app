import type { WorkspaceFolder } from '../../stores/workspaceStore';
import { normalizeWorkspaceTimestamp, type WorkspaceLibraryEntry } from './workspace-library';
import type { WorkspaceAccess } from '../../shared/workspace-access';

export interface WorkspaceProject {
  entry: WorkspaceLibraryEntry | null;
  repoPath: string;
  name: string;
  lastOpenedAt: number | null;
  originPath: string | null;
  access: WorkspaceAccess;
}

export interface WorkspaceFolderNameCorrection {
  path: string;
  name: string;
}

export function reconcileManagedWorkspaceFolderNames({
  folders,
  activeLibraryEntries,
}: {
  folders: readonly WorkspaceFolder[];
  activeLibraryEntries: readonly WorkspaceLibraryEntry[];
}): WorkspaceFolderNameCorrection[] {
  const activeNameByPath = new Map<string, string>();
  for (const entry of activeLibraryEntries) {
    if (entry.archivedAt !== null || entry.trashedAt !== null) continue;
    const name = entry.name.trim();
    if (name) activeNameByPath.set(entry.repoPath, name);
  }

  const corrections: WorkspaceFolderNameCorrection[] = [];
  for (const folder of folders) {
    if (folder.pinned) continue;
    const canonicalName = activeNameByPath.get(folder.path);
    if (canonicalName && canonicalName !== folder.name) {
      corrections.push({ path: folder.path, name: canonicalName });
    }
  }
  return corrections;
}

export function deriveMountedWorkspaceProjects({
  folders,
  libraryEntries,
}: {
  folders: WorkspaceFolder[];
  libraryEntries: WorkspaceLibraryEntry[];
}): WorkspaceProject[] {
  return folders
    .map((folder) => deriveWorkspaceProjectForPath(folder.path, folders, libraryEntries))
    .filter((project): project is WorkspaceProject => project !== null);
}

export function deriveWorkspaceProjectForPath(
  repoPath: string | null | undefined,
  folders: WorkspaceFolder[],
  libraryEntries: WorkspaceLibraryEntry[]
): WorkspaceProject | null {
  if (!repoPath) return null;
  const entry = libraryEntries.find((workspace) => workspace.repoPath === repoPath) ?? null;
  const folder = folders.find((candidate) => candidate.path === repoPath);
  if (!entry && !folder) return null;
  return {
    entry,
    repoPath,
    name: entry?.name ?? folder?.name ?? basenameForDisplay(repoPath),
    lastOpenedAt: entry?.lastOpenedAt ?? null,
    originPath: entry?.originPath ?? null,
    access: folder?.pinned ? 'reference' : 'writable',
  };
}

export function formatWorkspaceRelativeTime(
  timestamp: number | null | undefined,
  now = Date.now()
): string {
  const normalizedTimestamp = normalizeWorkspaceTimestamp(timestamp);
  if (!normalizedTimestamp) return 'not opened yet';
  const diffMs = Math.max(0, now - normalizedTimestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return 'just now';
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  if (diffMs < 14 * day) return `${Math.floor(diffMs / day)}d ago`;
  return new Date(normalizedTimestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year:
      new Date(normalizedTimestamp).getFullYear() === new Date(now).getFullYear()
        ? undefined
        : 'numeric',
  });
}

export function basenameForDisplay(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function workspaceLocationDisplayName(
  path: string | null | undefined,
  fallbackName?: string | null
): string {
  if (!path) return fallbackName?.trim() || '';
  return basenameForDisplay(path) || fallbackName?.trim() || path;
}
