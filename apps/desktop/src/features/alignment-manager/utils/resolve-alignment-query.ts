import { platform } from '../../../platform';
import { isSequencePackageFileKind } from '../../../db/sequence-package-contract';
import { pathIsAtOrUnder } from '../../../shared/path-boundary';
import { fingerprintSequenceBytes } from '../../../shared/sequence-bytes-fingerprint';
import { resolveSequencePackageProductPath } from '../../sequence/public/sequence-package-product';
import { resolveAlignmentQueryPath } from './alignment-query-path';

export interface AlignmentQueryInput {
  queryPath: string;
  queryFingerprint?: string;
}

interface CatalogFileRow {
  path: string;
  file_kind: string;
}

export class AlignmentQueryMissingError extends Error {
  readonly code = 'ALIGNMENT_QUERY_MISSING';

  constructor(readonly queryPath: string) {
    super(
      `The read "${queryPath.split(/[\\/]/).pop()}" was moved or deleted, and no file in this project has the same bases.`
    );
    this.name = 'AlignmentQueryMissingError';
  }
}

export async function fingerprintAlignmentQuery(path: string): Promise<string | null> {
  try {
    return await fingerprintSequenceBytes(await platform().fs.readFile(path), path);
  } catch {
    return null;
  }
}

async function projectRootFor(path: string): Promise<string | null> {
  const roots = await platform().db.select<Array<{ path: string }>>(
    'SELECT path FROM workspaces WHERE archived_at IS NULL AND trashed_at IS NULL'
  );
  return (
    roots
      .map((row) => row.path)
      .filter((root) => pathIsAtOrUnder(path, root))
      .sort((a, b) => b.length - a.length)[0] ?? null
  );
}

async function sequenceSourcePath(row: CatalogFileRow): Promise<string | null> {
  try {
    const path = isSequencePackageFileKind(row.file_kind)
      ? await resolveSequencePackageProductPath(row.path)
      : row.path;
    return (await platform().fs.exists(path)) ? path : null;
  } catch {
    return null;
  }
}

async function firstReadable(rows: readonly CatalogFileRow[]): Promise<string | null> {
  for (const row of [...rows].sort((a, b) => a.path.localeCompare(b.path))) {
    const path = await sequenceSourcePath(row);
    if (path) return path;
  }
  return null;
}

async function findByFingerprint(fingerprint: string, root: string): Promise<string | null> {
  const rows = await platform().db.select<CatalogFileRow[]>(
    `SELECT path, file_kind FROM catalog_entity_files
      WHERE sequence_fingerprint = ? AND status = 'current'`,
    [fingerprint]
  );
  return firstReadable(rows.filter((row) => pathIsAtOrUnder(row.path, root)));
}

async function findByFormerIdentity(formerPath: string, root: string): Promise<string | null> {
  const former = await platform().db.select<Array<{ entity_id: string }>>(
    'SELECT DISTINCT entity_id FROM catalog_entity_files WHERE path = ?',
    [formerPath]
  );
  if (former.length !== 1) return null;
  const rows = await platform().db.select<CatalogFileRow[]>(
    `SELECT path, file_kind FROM catalog_entity_files
      WHERE entity_id = ? AND status = 'current'`,
    [former[0].entity_id]
  );
  const current = rows.filter((row) => pathIsAtOrUnder(row.path, root));
  return current.length === 1 ? firstReadable(current) : null;
}

export async function resolveAlignmentQuery(
  input: AlignmentQueryInput,
  referencePath: string
): Promise<string> {
  const recordedPath = resolveAlignmentQueryPath(input.queryPath, referencePath);
  if (await platform().fs.exists(recordedPath)) return recordedPath;
  const root = await projectRootFor(referencePath);
  if (root) {
    const found =
      (input.queryFingerprint ? await findByFingerprint(input.queryFingerprint, root) : null) ??
      (await findByFormerIdentity(recordedPath, root));
    if (found) return found;
  }
  throw new AlignmentQueryMissingError(recordedPath);
}
