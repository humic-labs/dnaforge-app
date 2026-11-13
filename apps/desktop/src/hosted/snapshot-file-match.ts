export function hostedFileNameParts(path: string): { base: string; stem: string } {
  const base = path.split(/[\\/]/u).filter(Boolean).pop() ?? path;
  const lastDot = base.lastIndexOf('.');
  return { base, stem: lastDot > 0 ? base.slice(0, lastDot) : base };
}

export function hostedSnapshotFileMatchesHint(
  file: { path: string },
  hint: string | undefined
): boolean {
  if (!hint) return false;
  const { base, stem } = hostedFileNameParts(file.path);
  return file.path === hint || file.path.endsWith(`/${hint}`) || base === hint || stem === hint;
}
