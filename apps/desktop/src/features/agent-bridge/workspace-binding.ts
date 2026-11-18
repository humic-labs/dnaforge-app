import type { WorkspaceFolder } from '../../stores/workspaceStore';
import { workspaceScopeFromState } from '../../stores/workspaceStore';
import { normalizePathForBoundary } from '../../shared/path-boundary';
import { legacyProjectScope, type AgentProjectScope } from '../../shared/agent-project-scope';

const FOLDER_BINDING_PREFIX = 'folder:';

type WorkspaceBindingResolution =
  | {
      ok: true;
      folders: WorkspaceFolder[];
      workspaceId: string | null;
      kind: 'current-workspace' | 'folder-root';
    }
  | {
      ok: false;
      folders: [];
      workspaceId: string | null;
    };

function parseFolderBinding(binding: string): string | null | undefined {
  if (!binding.startsWith(FOLDER_BINDING_PREFIX)) return undefined;
  try {
    const path = JSON.parse(binding.slice(FOLDER_BINDING_PREFIX.length));
    return typeof path === 'string' && path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

export function resolveWorkspaceBinding(input: {
  boundWorkspaceId?: string | null;
  currentWorkspaceId: string | null;
  folders: readonly WorkspaceFolder[];
  projectScope?: AgentProjectScope;
}): WorkspaceBindingResolution {
  if (
    input.projectScope ||
    input.boundWorkspaceId === undefined ||
    input.boundWorkspaceId === 'app-following'
  ) {
    const scope = input.projectScope ?? legacyProjectScope(input.boundWorkspaceId);
    const roots =
      scope.kind === 'project-roots'
        ? new Set(scope.roots.map((root) => normalizePathForBoundary(root)))
        : null;
    const folders = input.folders.filter(
      (folder) => !roots || roots.has(normalizePathForBoundary(folder.path))
    );
    if (roots && folders.length === 0)
      return { ok: false, folders: [], workspaceId: input.currentWorkspaceId };
    return {
      ok: true,
      folders,
      workspaceId: workspaceScopeFromState({ activeWorkspaceFile: null, folders }),
      kind: 'current-workspace',
    };
  }

  const boundFolderPath =
    input.boundWorkspaceId === null ? undefined : parseFolderBinding(input.boundWorkspaceId);
  if (boundFolderPath === undefined) {
    if (input.boundWorkspaceId?.startsWith('folders:')) {
      const scope = legacyProjectScope(input.boundWorkspaceId);
      if (scope.kind === 'project-roots' && scope.roots.length > 0) {
        const roots = new Set(scope.roots.map((root) => normalizePathForBoundary(root)));
        const folders = input.folders.filter((folder) =>
          roots.has(normalizePathForBoundary(folder.path))
        );
        if (folders.length === 0)
          return { ok: false, folders: [], workspaceId: input.currentWorkspaceId };
        return {
          ok: true,
          folders,
          workspaceId: workspaceScopeFromState({ activeWorkspaceFile: null, folders }),
          kind: 'current-workspace',
        };
      }
    }
    return input.boundWorkspaceId === input.currentWorkspaceId
      ? {
          ok: true,
          folders: [...input.folders],
          workspaceId: input.currentWorkspaceId,
          kind: 'current-workspace',
        }
      : { ok: false, folders: [], workspaceId: input.currentWorkspaceId };
  }
  if (boundFolderPath === null) {
    return { ok: false, folders: [], workspaceId: input.currentWorkspaceId };
  }

  const normalizedBoundPath = normalizePathForBoundary(boundFolderPath);
  const matches = input.folders.filter(
    (folder) => normalizePathForBoundary(folder.path) === normalizedBoundPath
  );
  if (matches.length !== 1) {
    return { ok: false, folders: [], workspaceId: input.currentWorkspaceId };
  }

  const folders = [matches[0]];
  return {
    ok: true,
    folders,
    workspaceId: workspaceScopeFromState({ activeWorkspaceFile: null, folders }),
    kind: 'folder-root',
  };
}
