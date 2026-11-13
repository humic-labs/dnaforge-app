import {
  findContainingPathBoundary,
  isAbsolutePathLike,
  isPathInsideBoundary,
  pathRelativeToBoundary,
} from './path-boundary';
import type { NamedProjectRootRef } from './project-root-selection';

export function normalizePath(path: string): string {
  const input = path.replace(/\\/g, '/');
  const resolved: string[] = [];
  for (const part of input.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') resolved.pop();
    else resolved.push(part);
  }
  return (input.startsWith('/') ? '/' : '') + resolved.join('/');
}

export function normalizeAbsolutePath(path: string): string {
  const normalized = normalizePath(path);
  return /^(?:\\\\|\/\/)/.test(path) ? `//${normalized.replace(/^\/+/, '')}` : normalized;
}

export function resolveWorkspacePath(root: string, relative: string): string {
  if (isAbsolutePathLike(relative))
    throw new Error('Absolute paths are not allowed. Use a path relative to the project.');
  const path = normalizePath(`${normalizePath(root)}/${relative}`);
  if (!isPathInsideBoundary(path, normalizePath(root)))
    throw new Error('Path escapes project boundary.');
  return path;
}

export function resolveProjectFilePath<T extends NamedProjectRootRef>(
  folders: readonly T[],
  inputPath: string
): { folder: T; absolutePath: string; relativePath: string } {
  if (folders.length === 0) throw new Error('No admitted project is available for this file.');
  if (isAbsolutePathLike(inputPath)) {
    const absolutePath = normalizeAbsolutePath(inputPath),
      folder = findContainingPathBoundary(folders, absolutePath);
    if (!folder) throw new Error('Absolute path is outside every open project.');
    return {
      folder,
      absolutePath,
      relativePath: pathRelativeToBoundary(absolutePath, folder.path) ?? '',
    };
  }
  const segments = inputPath.replace(/\\/g, '/').split('/').filter(Boolean);
  const matches = folders.filter(
    (folder) => folder.name.toLocaleLowerCase() === (segments[0] ?? '').toLocaleLowerCase()
  );
  if (matches.length > 1)
    throw new Error(
      'AMBIGUOUS_PROJECT: Could not determine which project owns this path because the name is not unique. Use its exact admitted root.'
    );
  if (matches.length === 1) {
    const folder = matches[0],
      relativePath = segments.slice(1).join('/');
    return {
      folder,
      absolutePath: relativePath ? resolveWorkspacePath(folder.path, relativePath) : folder.path,
      relativePath,
    };
  }
  const writable = folders.filter((folder) => !folder.pinned);
  if (writable.length === 1) {
    const folder = writable[0];
    return {
      folder,
      absolutePath:
        !inputPath || inputPath === '.'
          ? folder.path
          : resolveWorkspacePath(folder.path, inputPath),
      relativePath: !inputPath || inputPath === '.' ? '' : inputPath,
    };
  }
  throw new Error(
    `Could not determine which folder "${inputPath}" belongs to. Prefix the path with a folder name. Available folders: ${(writable.length ? writable : folders).map((folder) => `"${folder.name}"`).join(', ')}`
  );
}
