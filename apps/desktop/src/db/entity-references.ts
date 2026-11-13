import {
  prepareEntityReferenceRow,
  type CreateEntityReferenceParams,
  type EntityReferenceUpdates,
  type EntityReferenceRevisionInput,
  type EntityReferenceRevisionRow,
} from '../shared/entity-reference-ipc';
export { prepareEntityReferenceRow } from '../shared/entity-reference-ipc';
export type { CreateEntityReferenceParams } from '../shared/entity-reference-ipc';
import { getConnection } from './index';
import type { ChatEntityReferenceIpcRow } from '../shared/chat-turn-ipc';

export interface DBEntityReference extends ChatEntityReferenceIpcRow {}

export async function createEntityReference(
  params: CreateEntityReferenceParams,
  options: { id?: string; now?: number } = {}
): Promise<DBEntityReference> {
  return (await getConnection()).createEntityReference(prepareEntityReferenceRow(params, options));
}

export async function setEntityReferenceWorkspaceRootPathIfMissing(
  id: string,
  workspaceRootPath: string
): Promise<string | null> {
  return (await getConnection()).setEntityReferenceWorkspaceRootPathIfMissing(
    id,
    workspaceRootPath
  );
}

export async function getEntityReference(id: string): Promise<DBEntityReference | null> {
  const sqlite = await getConnection();
  const result = await sqlite.select<DBEntityReference[]>(
    `SELECT * FROM entity_references WHERE id = ?`,
    [id]
  );
  return result.length > 0 ? result[0] : null;
}

export async function getEntityReferenceByLocator(
  locator: string
): Promise<DBEntityReference | null> {
  const sqlite = await getConnection();
  const rows = await sqlite.select<DBEntityReference[]>(
    `SELECT * FROM entity_references
     WHERE locator = ? AND entity_type = 'structure'
       AND CASE WHEN json_valid(data) THEN json_extract(data, '$.kind') END = 'molecular-view'
     ORDER BY created_at DESC LIMIT 1`,
    [locator]
  );
  return rows[0] ?? null;
}

export async function getEntityReferencesByIds(ids: string[]): Promise<DBEntityReference[]> {
  if (ids.length === 0) return [];
  const sqlite = await getConnection();

  const CHUNK_SIZE = 100;
  if (ids.length <= CHUNK_SIZE) {
    const placeholders = ids.map(() => '?').join(',');
    return sqlite.select<DBEntityReference[]>(
      `SELECT * FROM entity_references WHERE id IN (${placeholders})`,
      ids
    );
  }

  const results: DBEntityReference[] = [];
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await sqlite.select<DBEntityReference[]>(
      `SELECT * FROM entity_references WHERE id IN (${placeholders})`,
      chunk
    );
    results.push(...rows);
  }
  return results;
}

export async function updateEntityReference(
  id: string,
  updates: EntityReferenceUpdates
): Promise<void> {
  if (!Object.values(updates).some((value) => value !== undefined)) return;
  await (await getConnection()).updateEntityReference(id, updates);
}

export async function deleteEntityReference(id: string): Promise<void> {
  await (await getConnection()).deleteEntityReference(id);
}

export async function linkReferenceToMessage(
  messageId: string,
  referenceId: string,
  position: number
): Promise<void> {
  const sqlite = await getConnection();
  const existing = await sqlite.select<{ message_id: string }[]>(
    `SELECT message_id FROM message_references WHERE message_id = ? AND reference_id = ?`,
    [messageId, referenceId]
  );
  if (existing.length > 0) return;
  await sqlite.execute(
    `INSERT INTO message_references (message_id, reference_id, position) VALUES (?, ?, ?)`,
    [messageId, referenceId, position]
  );
}

export interface DBRevision extends EntityReferenceRevisionRow {}

export async function recordRevision(params: EntityReferenceRevisionInput): Promise<DBRevision> {
  return (await getConnection()).recordEntityReferenceRevision(params);
}

export async function getRevisions(referenceId: string): Promise<DBRevision[]> {
  const sqlite = await getConnection();
  return sqlite.select<DBRevision[]>(
    `SELECT * FROM entity_reference_revisions WHERE reference_id = ? ORDER BY revision_number ASC`,
    [referenceId]
  );
}

export async function getReferencesForMessage(messageId: string): Promise<DBEntityReference[]> {
  const sqlite = await getConnection();
  return sqlite.select<DBEntityReference[]>(
    `SELECT er.* FROM entity_references er
     JOIN message_references mr ON er.id = mr.reference_id
     WHERE mr.message_id = ?
     ORDER BY mr.position ASC`,
    [messageId]
  );
}

export async function listSavedMolecularViews(
  workspaceScope: string | null
): Promise<Array<Pick<DBEntityReference, 'id' | 'display_label' | 'created_at'>>> {
  const sqlite = await getConnection();
  return sqlite.select(
    `SELECT id, display_label, created_at FROM entity_references
    WHERE entity_type = 'structure' AND workspace_scope IS ? AND json_valid(data)
      AND json_extract(data, '$.kind') = 'molecular-view'
    ORDER BY created_at DESC, id DESC LIMIT 50`,
    [workspaceScope]
  );
}
