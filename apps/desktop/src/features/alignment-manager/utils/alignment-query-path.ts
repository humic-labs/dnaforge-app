export function isAbsoluteFilesystemPath(filePath: string): boolean {
  if (filePath.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(filePath)) return true;
  if (filePath.startsWith('\\\\')) return true;
  return false;
}

export function dirnameOfFilesystemPath(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (index < 0) return '';
  if (index === 0) return filePath[0] === '/' ? '/' : '';
  return filePath.slice(0, index);
}

export function joinFilesystemPath(directory: string, relativePath: string): string {
  const separator = directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
  const trimmedDir = directory.replace(/[\\/]+$/, '');
  const trimmedRel = relativePath.replace(/^[\\/]+/, '');
  if (!trimmedDir) return trimmedRel;
  return `${trimmedDir}${separator}${trimmedRel}`;
}

export function resolveAlignmentQueryPath(queryPath: string, referencePath: string): string {
  const query = queryPath.trim();
  if (!query) return query;
  if (isAbsoluteFilesystemPath(query)) return query;
  const directory = dirnameOfFilesystemPath(referencePath);
  if (!directory) return query;
  return joinFilesystemPath(directory, query);
}
