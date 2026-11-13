import { useWorkspaceStore } from '../stores/workspaceStore';
import { resolveMultiRootPath } from '../features/workspace/path-resolve';

function isAbsolutePath(filePath: string): boolean {
  return filePath.startsWith('/') || /^[A-Za-z]:/.test(filePath);
}

export function resolveFilePath(filePath: string): string {
  if (isAbsolutePath(filePath)) {
    return filePath;
  }

  const { folders } = useWorkspaceStore.getState();
  const resolved = resolveMultiRootPath(folders, filePath);
  return resolved.absolutePath;
}

export function resolveFilePathWithFallback(filePath: string): string {
  if (isAbsolutePath(filePath)) {
    return filePath;
  }

  try {
    return resolveFilePath(filePath);
  } catch {}

  const { folders } = useWorkspaceStore.getState();
  for (const folder of folders) {
    try {
      return resolveFilePath(`${folder.name}/${filePath}`);
    } catch {
      continue;
    }
  }

  return filePath;
}

export function resolveFilePathWithPersistedWorkspace(
  filePath: string,
  persistedWorkspaceRoot: string | null
): string {
  if (isAbsolutePath(filePath)) {
    return filePath;
  }

  const resolved = resolveFilePathWithFallback(filePath);
  if (resolved !== filePath || !persistedWorkspaceRoot) {
    return resolved;
  }

  const normalizedRoot = persistedWorkspaceRoot.replace(/[\\/]+$/, '');
  const name = normalizedRoot.split(/[\\/]/).pop() || 'project';
  return resolveMultiRootPath([{ path: normalizedRoot, name, addedAt: 0 }], filePath).absolutePath;
}
