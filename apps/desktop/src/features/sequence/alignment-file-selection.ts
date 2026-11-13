import {
  ALIGNMENT_QUERY_EXTENSIONS,
  isAlignmentQueryPath,
} from '../../shared/alignment-query-extensions';

export type PendingAlignmentFile = { path: string; name: string };

export { ALIGNMENT_QUERY_EXTENSIONS, isAlignmentQueryPath };

export const ALIGNMENT_QUERY_FILE_FILTERS = [
  {
    name: 'Sequencing and sequence files',
    extensions: [...ALIGNMENT_QUERY_EXTENSIONS],
  },
];

export function collectAlignmentQueryPathsFromFiles(
  files: Iterable<File>,
  getPathForFile: (file: File) => string
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const nativePath = getPathForFile(file) || (file as File & { path?: string }).path || '';
    if (!nativePath || seen.has(nativePath) || !isAlignmentQueryPath(nativePath)) continue;
    seen.add(nativePath);
    paths.push(nativePath);
  }
  return paths;
}

export function pendingAlignmentFilesFromSelection(
  selected: string | string[] | null,
  existing: PendingAlignmentFile[] = []
): PendingAlignmentFile[] {
  if (!selected) return existing;

  const selectedPaths = Array.isArray(selected) ? selected : [selected];
  const seen = new Set(existing.map((file) => file.path));
  const additions: PendingAlignmentFile[] = [];

  for (const path of selectedPaths) {
    if (typeof path !== 'string' || path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    additions.push({
      path,
      name: path.split(/[\\/]/).pop() || path,
    });
  }

  return additions.length > 0 ? [...existing, ...additions] : existing;
}
