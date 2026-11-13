const BENCHLING_IMPORT_ROOT = 'Benchling Imports';

const BENCHLING_STABLE_ID =
  /^(?:aa|bfi|efl|ent|entity|entry|etr|file|fld|lib|mixture|obj|oligo|protocol|prt|prtn|reg|rna|scrfile|seq|src)_[A-Za-z0-9_-]+$/u;

const PRIMARY_PROJECTION_SUFFIXES = [
  '.dnaforge-protocol-run.json',
  '.dnaforge-protocol.json',
  '.wpnote.json',
  '.genbank',
  '.gbk',
  '.faa',
  '.gb',
  '.md',
] as const;

function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/u).filter(Boolean);
}

export function isManagedBenchlingImportPath(path: string): boolean {
  return pathSegments(path).includes(BENCHLING_IMPORT_ROOT);
}

export function isManagedBenchlingProvenanceSidecar(input: {
  parentPath: string;
  entryName: string;
}): boolean {
  return (
    isManagedBenchlingImportPath(input.parentPath) &&
    input.entryName.toLowerCase().endsWith('.benchling-provenance.json')
  );
}

function importedStem(name: string): string | null {
  const boundary = name.lastIndexOf('__');
  if (boundary <= 0) return null;
  const label = name.slice(0, boundary).trim();
  const stableId = name.slice(boundary + 2);
  return label && BENCHLING_STABLE_ID.test(stableId) ? label : null;
}

export function benchlingImportDisplayName(input: {
  parentPath: string;
  entryName: string;
  isDirectory: boolean;
}): string | undefined {
  if (!isManagedBenchlingImportPath(input.parentPath)) return undefined;

  if (input.isDirectory) return importedStem(input.entryName) ?? undefined;

  const segments = pathSegments(input.parentPath);
  const parentName = segments[segments.length - 1];
  if (!parentName) return undefined;
  const cleanParentName = importedStem(parentName);
  if (!cleanParentName) return undefined;

  const lowerEntryName = input.entryName.toLowerCase();
  const suffix = PRIMARY_PROJECTION_SUFFIXES.find(
    (candidate) => lowerEntryName === `${parentName.toLowerCase()}${candidate}`
  );
  return suffix ? cleanParentName : undefined;
}
