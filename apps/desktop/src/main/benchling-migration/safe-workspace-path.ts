export function isSafeWorkspaceRelativePath(destinationPath: string): boolean {
  if (destinationPath.length === 0 || destinationPath.trim() !== destinationPath) return false;
  if (destinationPath.includes('\0')) return false;

  let decoded: string;
  try {
    decoded = decodeURIComponent(destinationPath);
  } catch {
    return false;
  }
  const portablePath = decoded.replaceAll('\\', '/');
  if (portablePath.startsWith('/') || /^[a-z]:/i.test(portablePath)) return false;

  const segments = portablePath.split('/');
  return segments.every(
    (segment) => segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes(':')
  );
}
