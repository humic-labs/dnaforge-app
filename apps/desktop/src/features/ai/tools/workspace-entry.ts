import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { platform } from '../../../platform';
import { resolveMultiRootPath } from './path-utils';
import { normalizePathForBoundary } from '../../../shared/path-boundary';
import { inspectFileLifecycle } from '../../workspace/public/file-lifecycle-commands';

export function resolveWorkspaceEntry(
  folders: readonly WorkspaceFolder[],
  input: string,
  write: boolean,
  allowRootInspection = false
) {
  const target = resolveMultiRootPath([...folders], input);
  if ((!target.relativePath || target.relativePath === '.') && !allowRootInspection)
    throw new Error('Use workspace_projects to manage a project root.');
  if (
    target.relativePath
      .split(/[\\/]/)
      .some((part) => ['.git', '.forge', '.waypoint', '.dnaforge'].includes(part))
  )
    throw new Error('Internal project metadata is managed by its document owner.');
  if (write && target.folder.pinned) throw new Error('The project is read-only.');
  return target;
}
export async function inspectWorkspaceEntry(target: ReturnType<typeof resolveWorkspaceEntry>) {
  const root = !target.relativePath || target.relativePath === '.';
  if (!root && !target.folder.pinned)
    return inspectFileLifecycle(target.folder.path, target.absolutePath);

  if (
    !root &&
    !(await platform().fs.validateWorkspacePath({
      workspaceRoot: target.folder.path,
      path: target.absolutePath,
      artifactNoun: 'workspace entry',
    }))
  )
    throw new Error('The path is outside the admitted workspace.');
  const stat = await platform().fs.stat(target.absolutePath);
  if (
    root &&
    (stat.isDirectory !== true ||
      typeof stat.canonicalPath !== 'string' ||
      normalizePathForBoundary(stat.canonicalPath) !== normalizePathForBoundary(target.folder.path))
  )
    throw new Error('The admitted project root has no matching native directory identity.');
  const hash = stat.isFile
    ? await platform().fs.contentHash({
        workspaceRoot: target.folder.path,
        workspaceRelativePath: target.relativePath,
      })
    : null;

  const revisionBytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify({
        workspaceRoot: target.folder.path,
        path: target.relativePath,
        stat,
        hash,
      })
    )
  );
  const revision = `workspace-entry-v1:${Array.from(new Uint8Array(revisionBytes), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`;
  return {
    path: root ? '.' : target.relativePath,
    type: stat.isDirectory ? 'directory' : 'file',
    size: stat.size,
    contentHash: hash,
    revision,
  };
}
