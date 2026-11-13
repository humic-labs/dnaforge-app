export type PathBoundaryPlatform = 'posix' | 'win32';

export interface PathBoundaryOptions {
  platform?: PathBoundaryPlatform | string;
}

export type PathBoundaryResolution<T> =
  | { status: 'none' }
  | { status: 'unique'; entry: T }
  | { status: 'ambiguous' };

export function isAbsolutePathLike(input: string): boolean {
  return input.startsWith('/') || input.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(input);
}

export function normalizePathForBoundary(input: string, options: PathBoundaryOptions = {}): string {
  const platform = normalizePlatform(options.platform ?? inferPathPlatform(input));
  const normalized = normalizePathSeparators(input, platform);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function isPathInsideBoundary(
  candidatePath: string,
  rootPath: string,
  options: PathBoundaryOptions = {}
): boolean {
  const platform = normalizePlatform(
    options.platform ?? inferPathPlatform(candidatePath, rootPath)
  );
  const candidate = normalizePathForBoundary(candidatePath, { platform });
  const root = normalizePathForBoundary(rootPath, { platform });
  const rootPrefix = root.endsWith('/') ? root : `${root}/`;
  return candidate === root || candidate.startsWith(rootPrefix);
}

export function pathRelativeToBoundary(
  candidatePath: string,
  rootPath: string,
  options: PathBoundaryOptions = {}
): string | null {
  const platform = normalizePlatform(
    options.platform ?? inferPathPlatform(candidatePath, rootPath)
  );
  if (!isPathInsideBoundary(candidatePath, rootPath, { platform })) return null;

  const candidate = normalizePathSeparators(candidatePath, platform);
  const root = normalizePathSeparators(rootPath, platform);
  if (
    normalizePathForBoundary(candidate, { platform }) ===
    normalizePathForBoundary(root, { platform })
  ) {
    return '';
  }

  const rootPrefix = root.endsWith('/') ? root : `${root}/`;
  return candidate.slice(rootPrefix.length);
}

export function isPathInsideAnyBoundary(
  candidatePath: string,
  rootPaths: readonly string[],
  options: PathBoundaryOptions = {}
): boolean {
  return rootPaths.some((rootPath) => isPathInsideBoundary(candidatePath, rootPath, options));
}

export function pathIsAtOrUnder(path: string, root: string): boolean {
  return isPathInsideBoundary(path, root);
}

export function rebasePath(path: string, oldRoot: string, newRoot: string): string {
  if (path === oldRoot) return newRoot;
  return `${newRoot}${path.slice(oldRoot.length)}`;
}

export function stripTrailingSep(path: string): string {
  if (path === '/') return path;
  return path.replace(/[\\/]+$/, '') || path;
}

export function findContainingPathBoundary<T extends { path: string }>(
  entries: readonly T[],
  candidatePath: string,
  options: PathBoundaryOptions = {}
): T | undefined {
  const resolution = resolveContainingPathBoundary(entries, candidatePath, options);
  return resolution.status === 'unique' ? resolution.entry : undefined;
}

export function resolveContainingPathBoundary<T extends { path: string }>(
  entries: readonly T[],
  candidatePath: string,
  options: PathBoundaryOptions = {}
): PathBoundaryResolution<T> {
  const matches = entries
    .filter((entry) => isPathInsideBoundary(candidatePath, entry.path, options))
    .sort(
      (a, b) =>
        normalizePathForBoundary(b.path, options).length -
        normalizePathForBoundary(a.path, options).length
    );
  const deepest = matches[0];
  if (!deepest) return { status: 'none' };
  const deepestPath = normalizePathForBoundary(deepest.path, options);
  const equallySpecific = matches.filter(
    (entry) => normalizePathForBoundary(entry.path, options).length === deepestPath.length
  );
  return equallySpecific.length === 1
    ? { status: 'unique', entry: deepest }
    : { status: 'ambiguous' };
}

export function isSafeWorkspaceRelativePath(path: string): boolean {
  if (!path || isAbsolutePathLike(path)) return false;
  const parts = path.replace(/\\/g, '/').split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function inferPathPlatform(...paths: string[]): PathBoundaryPlatform {
  if (paths.some((value) => /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/.test(value) || value.includes('\\'))) {
    return 'win32';
  }
  if (paths.some((value) => value.startsWith('/'))) {
    return 'posix';
  }
  return typeof process !== 'undefined' && process.platform === 'win32' ? 'win32' : 'posix';
}

function normalizePlatform(platform: PathBoundaryPlatform | string): PathBoundaryPlatform {
  return platform === 'win32' ? 'win32' : 'posix';
}

function stripTrailingBoundarySlashes(input: string, platform: PathBoundaryPlatform): string {
  if (input === '/') return input;
  if (platform === 'win32' && /^[A-Za-z]:\/$/.test(input)) return input;
  return input.replace(/\/+$/, '');
}

function normalizePathSeparators(input: string, platform: PathBoundaryPlatform): string {
  return stripTrailingBoundarySlashes(input.replace(/\\/g, '/'), platform);
}
