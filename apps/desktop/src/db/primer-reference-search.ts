import {
  resolvePortablePrimerReferencePath as resolvePortablePath,
  readOriginDetails,
} from '../shared/primer-reference-path';
import { platform } from '../platform';
import { stripTrailingSep } from '../shared/path-boundary';
import type { SqliteIpcValue } from '../shared/sqlite-ipc';

export interface PrimerReferenceCandidate {
  primerId: string;
  name: string;
  sequence: string;
  length: number;
  catalogNumber: string | null;

  workspaceRelativePath: string | null;

  localOnly: boolean;
}

interface SearchInput {
  query: string;
  primerId?: string;

  workspaceRoot: string | null;
  limit?: number;
}

interface PrimerReferenceRow {
  id: string;
  name: string;
  sequence: string;
  length: number;
  catalog_number: string | null;
  origin_details: string | null;
  workspace_path: string | null;
}

interface PrimerOriginRow {
  origin_details: string | null;
}

export async function findPrimerLibraryIdsForRegistryEntityId(entityId: string): Promise<string[]> {
  if (!entityId) return [];
  const rows = await platform().db.select<Array<{ id: string }>>(
    `SELECT id FROM primers
      WHERE json_extract(CASE WHEN json_valid(origin_details) THEN origin_details ELSE '{}' END,
                         '$.limsEntityId') = ?
      ORDER BY id`,
    [entityId]
  );
  return rows.map((row) => row.id);
}

export async function searchPrimerReferencesByName({
  query,
  primerId,
  workspaceRoot,
  limit = 20,
}: SearchInput): Promise<PrimerReferenceCandidate[]> {
  const trimmed = query.trim();
  const params: SqliteIpcValue[] = [];

  let sql = `
    SELECT p.id AS id,
           p.name AS name,
           p.sequence AS sequence,
           p.length AS length,
           p.catalog_number AS catalog_number,
           p.origin_details AS origin_details,
           w.path AS workspace_path
    FROM primers p
    LEFT JOIN workspaces w ON w.id = p.workspace_id`;

  const conditions: string[] = [];
  if (primerId) {
    conditions.push('p.id = ?');
    params.push(primerId);
  }
  if (trimmed) {
    const like = `%${escapeLikeWildcards(trimmed)}%`;
    conditions.push(`(p.name LIKE ? ESCAPE '\\'
              OR p.sequence LIKE ? ESCAPE '\\'
              OR p.catalog_number LIKE ? ESCAPE '\\')`);
    params.push(like, like, like);
  }
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;

  sql += ` ORDER BY p.created_at DESC LIMIT ?`;
  params.push(limit);

  const rows = await platform().db.select<PrimerReferenceRow[]>(sql, params);
  const owningRoot = workspaceRoot ? stripTrailingSep(workspaceRoot) : null;

  return rows.map((row) => {
    const portablePath = resolvePortablePath(row, owningRoot);
    return {
      primerId: row.id,
      name: row.name,
      sequence: row.sequence,
      length: row.length,
      catalogNumber: row.catalog_number,
      workspaceRelativePath: portablePath,
      localOnly: portablePath === null,
    };
  });
}

export async function findPrimerRegistryEntityId(primerId: string): Promise<string | null> {
  if (!primerId) return null;
  const rows = await platform().db.select<PrimerOriginRow[]>(
    'SELECT origin_details FROM primers WHERE id = ? LIMIT 1',
    [primerId]
  );
  const origin = readOriginDetails(rows[0]?.origin_details ?? null);
  return typeof origin?.limsEntityId === 'string' && origin.limsEntityId
    ? origin.limsEntityId
    : null;
}

function escapeLikeWildcards(input: string): string {
  return input.replace(/[\\%_]/g, (match) => `\\${match}`);
}
