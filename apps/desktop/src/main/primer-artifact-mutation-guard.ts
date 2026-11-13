import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { isSafeWorkspaceRelativePath, pathIsAtOrUnder } from '../shared/path-boundary';
import { primerArtifactRelocationWouldChange } from './relocate-primer-artifacts';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';

const REFUSAL =
  'This primer is registered with an organization. Keep its saved file in place and use Archive or Restore.';
const UNRESOLVED =
  'A registered primer has an unresolved saved-file location. Restore its owning project and file before changing these files.';

interface EnrolledPrimerLocation {
  entityId: string;
  workspacePath: string | null;
  paths: string[];
  sourcePaths: string[];
  unresolved: boolean;
}

export function assertEnrolledPrimerPhysicalMutationAllowed(
  db: Database.Database,
  entityIds: readonly string[]
): void {
  const statement = db.prepare(`SELECT 1 FROM org_registry_local_records r
    LEFT JOIN lims_entity e ON e.id=r.entity_id
    WHERE r.entity_id=? AND (r.authority_kind='primer_artifact' OR
      json_extract(e.fields,'$.artifact.schema')='dnaforge.primer') LIMIT 1`);
  for (const entityId of new Set(entityIds)) {
    if (statement.get(entityId)) throw new Error(REFUSAL);
  }
}

export function assertEnrolledPrimerPathMutationAllowed(
  db: Database.Database,
  mutationPaths: readonly string[]
): void {
  if (mutationPaths.length === 0) return;
  for (const location of readEnrolledPrimerLocations(db)) {
    if (location.paths.some((path) => mutationPaths.some((changed) => pathsOverlap(path, changed))))
      throw new Error(REFUSAL);
    if (
      location.unresolved &&
      (!location.workspacePath ||
        mutationPaths.some((changed) => pathsOverlap(location.workspacePath!, changed)))
    )
      throw new Error(UNRESOLVED);
  }
}

export function assertEnrolledPrimerRelocationAllowed(
  db: Database.Database,
  input: { workspaceRoot?: string | null; oldPath: string; newPath: string }
): void {
  if (input.oldPath === input.newPath) return;
  assertEnrolledPrimerPathMutationAllowed(db, [input.oldPath, input.newPath]);
  if (!input.workspaceRoot) return;
  const root = workspaceMutationRootIdentity(input.workspaceRoot);
  for (const location of readEnrolledPrimerLocations(db)) {
    if (location.workspacePath && workspaceMutationRootIdentity(location.workspacePath) !== root)
      continue;
    if (location.unresolved || !location.workspacePath || location.sourcePaths.length === 0)
      throw new Error(UNRESOLVED);
    for (const path of location.sourcePaths) {
      let source: string;
      try {
        source = readFileSync(path, 'utf8');

        const value: unknown = JSON.parse(source);
        if (!record(value) || value.id !== location.entityId) throw new Error(UNRESOLVED);
        if (
          primerArtifactRelocationWouldChange(source, {
            workspaceRoot: input.workspaceRoot,
            oldAbs: input.oldPath,
            newAbs: input.newPath,
          })
        )
          throw new Error(REFUSAL);
      } catch (error) {
        if (error instanceof Error && error.message === REFUSAL) throw error;
        throw new Error(UNRESOLVED);
      }
    }
  }
}

function readEnrolledPrimerLocations(db: Database.Database): EnrolledPrimerLocation[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT r.entity_id AS entityId,
    r.workspace_id AS workspaceId, w.path AS workspacePath, e.fields
    FROM org_registry_local_records r LEFT JOIN lims_entity e ON e.id=r.entity_id
    LEFT JOIN workspaces w ON w.id=r.workspace_id
    WHERE r.authority_kind='primer_artifact' OR
      json_extract(e.fields,'$.artifact.schema')='dnaforge.primer'`
    )
    .all() as Array<{
    entityId: string;
    workspaceId: number;
    workspacePath: string | null;
    fields: string | null;
  }>;
  return rows.map((row) => {
    const paths = new Set<string>();
    const sourcePaths = new Set<string>();
    let unresolved = !row.workspacePath;
    const files = db
      .prepare(
        `SELECT path,workspace_id AS workspaceId,status
      FROM catalog_entity_files WHERE entity_id=? AND status IN ('current','missing')`
      )
      .all(row.entityId) as Array<{ path: string; workspaceId: number; status: string }>;
    for (const file of files) {
      if (!isAbsolute(file.path) || file.path.includes('\0')) {
        unresolved = true;
        continue;
      }
      paths.add(file.path);
      if (file.status === 'current') sourcePaths.add(file.path);
      if (
        file.workspaceId !== row.workspaceId ||
        !row.workspacePath ||
        !pathIsAtOrUnder(resolve(file.path), resolve(row.workspacePath))
      )
        unresolved = true;
    }
    try {
      const fields: unknown = row.fields ? JSON.parse(row.fields) : null;
      const artifact = record(fields) && record(fields.artifact) ? fields.artifact : null;
      if (
        row.workspacePath &&
        artifact?.schema === 'dnaforge.primer' &&
        typeof artifact.relativePath === 'string' &&
        isSafeWorkspaceRelativePath(artifact.relativePath)
      ) {
        const path = resolve(row.workspacePath, artifact.relativePath);
        paths.add(path);
        sourcePaths.add(path);
      } else if (sourcePaths.size === 0) {
        unresolved = true;
      }
    } catch {
      unresolved = true;
    }
    if (paths.size === 0) unresolved = true;
    return { ...row, paths: [...paths], sourcePaths: [...sourcePaths], unresolved };
  });
}

function pathsOverlap(left: string, right: string): boolean {
  const leftPaths = new Set([resolve(left), workspaceMutationRootIdentity(left)]);
  const rightPaths = new Set([resolve(right), workspaceMutationRootIdentity(right)]);
  for (const a of leftPaths)
    for (const b of rightPaths) if (pathIsAtOrUnder(a, b) || pathIsAtOrUnder(b, a)) return true;
  return false;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
