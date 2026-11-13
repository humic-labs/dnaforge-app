import { HOSTED_RESOURCE_BINDINGS_PATH } from '../shared/hosted-resource-bindings';
import { MANAGED_WORKSPACE_MARKER } from '../shared/workspace-git-types';

export const WORKSPACE_SYNC_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'dist-electron',
  'build',
  'coverage',
  'tmp',
  'temp',
  '.tmp',
  '.cache',
  'vendor',
]);
export const WORKSPACE_SYNC_SKIP_FILES = new Set(['.DS_Store', MANAGED_WORKSPACE_MARKER]);
export const WORKSPACE_SYNC_SKIP_RELATIVE_DIRS = new Set(['.waypoint/lims', '.dnaforge/migration']);
export const WORKSPACE_SYNC_SKIP_RELATIVE_FILES = new Set([HOSTED_RESOURCE_BINDINGS_PATH]);
export const WORKSPACE_SYNC_PACKAGE_TRANSACTION_DIRECTORY =
  /^\..+\.(?:staging|previous|recovery)-\d+-[a-z0-9]+$/u;
export const WORKSPACE_SYNC_MIGRATION_TRANSACTION_FILE =
  /^\..+\.[a-z0-9-]+\.dnaforge-migration\.tmp$/iu;

export function isWorkspaceSyncOperationalPath(path: string, isDirectory = false): boolean {
  const parts = path.split('/');
  const name = parts[parts.length - 1];
  const directories = isDirectory ? parts : parts.slice(0, -1);
  return (
    WORKSPACE_SYNC_SKIP_FILES.has(name) ||
    WORKSPACE_SYNC_SKIP_RELATIVE_FILES.has(path) ||
    WORKSPACE_SYNC_MIGRATION_TRANSACTION_FILE.test(name) ||
    directories.some(
      (part) =>
        WORKSPACE_SYNC_SKIP_DIRS.has(part) ||
        WORKSPACE_SYNC_PACKAGE_TRANSACTION_DIRECTORY.test(part)
    ) ||
    [...WORKSPACE_SYNC_SKIP_RELATIVE_DIRS].some(
      (dir) => (isDirectory && path === dir) || path.startsWith(`${dir}/`)
    )
  );
}
