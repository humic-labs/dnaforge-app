import type { WorkspaceFolder } from '../../stores/workspaceStore';
import {
  normalizePathForBoundary,
  resolveContainingPathBoundary,
  type PathBoundaryResolution,
} from '../../shared/path-boundary';

export interface ResolveActiveImportRootInput {
  folders: WorkspaceFolder[];
  selectedPath?: string | null;
  focusedRootPath?: string | null;
  workspacePath?: string | null;
}

function uniqueExactRoot(
  roots: readonly WorkspaceFolder[],
  path: string
): PathBoundaryResolution<WorkspaceFolder> {
  const normalized = normalizePathForBoundary(path);
  const matches = roots.filter((root) => normalizePathForBoundary(root.path) === normalized);
  if (matches.length === 0) return { status: 'none' };
  return matches.length === 1 ? { status: 'unique', entry: matches[0] } : { status: 'ambiguous' };
}

export function resolveActiveImportRoot(input: ResolveActiveImportRootInput): string | null {
  const importable = input.folders.filter((folder) => !folder.pinned);
  if (importable.length === 0) return null;

  if (input.selectedPath) {
    const containing = resolveContainingPathBoundary(importable, input.selectedPath);
    if (containing.status === 'ambiguous') return null;
    if (containing.status === 'unique') return containing.entry.path;
  }

  if (input.focusedRootPath) {
    const focused = uniqueExactRoot(importable, input.focusedRootPath);
    if (focused.status === 'ambiguous') return null;
    if (focused.status === 'unique') return focused.entry.path;
  }

  if (importable.length === 1) return importable[0].path;

  if (input.workspacePath) {
    const legacy = uniqueExactRoot(importable, input.workspacePath);
    if (legacy.status === 'ambiguous') return null;
    if (legacy.status === 'unique') return legacy.entry.path;
  }

  return null;
}
