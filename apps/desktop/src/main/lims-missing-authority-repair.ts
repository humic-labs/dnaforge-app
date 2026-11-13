import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import type Database from 'better-sqlite3';

import { parseSequencePackageDocument, sequencePackageMetaPaths } from '../db/sequence-package';
import { LIMS_ENTITY_STATE_EVENT_TYPES } from '../shared/lims';
import { MANAGED_SEQUENCE_DOCUMENT_FIELD } from '../shared/managed-sequence-document';
import { restoreVerifiedLimsEntitiesInDb } from './lims';

const DEFECT_ARCHIVE_ACTOR = 'workspace-reconcile-missing-authority';
const REPAIR_ACTOR = 'workspace-reconcile-missing-authority-repair';
const MAX_PACKAGE_METADATA_BYTES = 4 * 1024 * 1024;

interface ArchivedProjectionRow {
  id: string;
  fields: string;
  workspace_path: string | null;
}

export interface MissingAuthorityArchiveRepairResult {
  candidates: number;
  restored: number;
  skippedMissingAuthority: number;
  skippedIdentityMismatch: number;
  skippedInvalidPackage: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readManagedPackageRoot(row: ArchivedProjectionRow): string | null {
  let fields: unknown;
  try {
    fields = JSON.parse(row.fields) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(fields)) return null;
  const managed = fields[MANAGED_SEQUENCE_DOCUMENT_FIELD];
  if (!isRecord(managed) || managed.kind !== 'managed-sequence') return null;
  if (managed.packageId !== row.id || typeof managed.packageRoot !== 'string') return null;
  return managed.packageRoot;
}

function readVerifiedPackageIdentity(
  row: ArchivedProjectionRow
): 'verified' | 'missing' | 'mismatch' | 'invalid' {
  const packageRoot = readManagedPackageRoot(row);
  if (!packageRoot || !row.workspace_path) return 'mismatch';

  try {
    const workspaceStat = lstatSync(row.workspace_path);
    const packageStat = lstatSync(packageRoot);
    if (
      workspaceStat.isSymbolicLink() ||
      !workspaceStat.isDirectory() ||
      packageStat.isSymbolicLink() ||
      !packageStat.isDirectory()
    ) {
      return 'invalid';
    }
    const packageWithinWorkspace = relative(
      realpathSync(row.workspace_path),
      realpathSync(packageRoot)
    );
    if (
      !packageWithinWorkspace ||
      packageWithinWorkspace === '..' ||
      packageWithinWorkspace.startsWith(`..${sep}`) ||
      isAbsolute(packageWithinWorkspace)
    ) {
      return 'mismatch';
    }
  } catch {
    return 'missing';
  }

  for (const metaPath of sequencePackageMetaPaths(packageRoot)) {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(metaPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) return 'invalid';
    if (stat.size > MAX_PACKAGE_METADATA_BYTES) return 'invalid';

    let document: ReturnType<typeof parseSequencePackageDocument>;
    try {
      document = parseSequencePackageDocument(readFileSync(metaPath, 'utf8'));
    } catch {
      return 'invalid';
    }
    if (document.id !== row.id) return 'mismatch';

    try {
      const productStat = lstatSync(join(packageRoot, document.product.file));
      if (productStat.isSymbolicLink() || !productStat.isFile()) return 'missing';
    } catch {
      return 'missing';
    }
    return 'verified';
  }
  return 'missing';
}

export function repairMissingAuthoritySequenceArchives(
  db: Database.Database
): MissingAuthorityArchiveRepairResult {
  const stateEvents = LIMS_ENTITY_STATE_EVENT_TYPES.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT e.id, e.fields, w.path AS workspace_path
       FROM lims_entity e
       LEFT JOIN workspaces w ON w.id = e.workspace_id
       JOIN lims_audit latest ON latest.id = (
         SELECT a.id
         FROM lims_audit a
         WHERE a.subject_table = 'lims_entity'
           AND a.subject_id = e.id
           AND a.event_type IN (${stateEvents})
         ORDER BY a.event_seq DESC
         LIMIT 1
       )
       WHERE e.tombstone = 1
         AND latest.event_type = 'entity_archived'
         AND latest.actor = ?
       ORDER BY e.id`
    )
    .all(...LIMS_ENTITY_STATE_EVENT_TYPES, DEFECT_ARCHIVE_ACTOR) as ArchivedProjectionRow[];

  const result: MissingAuthorityArchiveRepairResult = {
    candidates: rows.length,
    restored: 0,
    skippedMissingAuthority: 0,
    skippedIdentityMismatch: 0,
    skippedInvalidPackage: 0,
  };
  const verifiedIds: string[] = [];
  for (const row of rows) {
    const verification = readVerifiedPackageIdentity(row);
    if (verification === 'verified') verifiedIds.push(row.id);
    else if (verification === 'missing') result.skippedMissingAuthority++;
    else if (verification === 'mismatch') result.skippedIdentityMismatch++;
    else result.skippedInvalidPackage++;
  }

  result.restored = restoreVerifiedLimsEntitiesInDb(db, {
    ids: verifiedIds,
    actor: REPAIR_ACTOR,
  }).restoredIds.length;
  return result;
}
