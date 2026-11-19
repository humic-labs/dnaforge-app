import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  PRIMER_SAVED_SOURCE_EVENT,
  PRIMER_RELOCATION_SOURCE_EVENT,
} from '../shared/primer-artifacts/primer-source-history';

export function retainPrimerSourceInDb(
  db: Database.Database,
  entityId: string,
  relativePath: string,
  content: string,
  event: typeof PRIMER_SAVED_SOURCE_EVENT | typeof PRIMER_RELOCATION_SOURCE_EVENT
): void {
  const sha256 = createHash('sha256').update(content).digest('hex');
  const existing = db
    .prepare(
      "SELECT json_extract(payload,'$.content') AS content FROM catalog_entity_events WHERE entity_id=? AND event_type=? AND json_extract(payload,'$.sha256')=? AND json_extract(payload,'$.relativePath')=?"
    )
    .get(entityId, event, sha256, relativePath) as { content: string } | undefined;
  if (existing) {
    if (existing.content !== content)
      throw new Error('The retained primer source disagrees with its checksum.');
    return;
  }
  db.prepare(
    'INSERT INTO catalog_entity_events(id,entity_id,event_type,actor,summary,payload,created_at) VALUES(?,?,?,?,?,?,?)'
  ).run(
    randomUUID(),
    entityId,
    event,
    event === PRIMER_SAVED_SOURCE_EVENT ? 'system' : 'user',
    event === PRIMER_SAVED_SOURCE_EVENT
      ? 'Saved primer document'
      : 'Saved primer source before relocation',
    JSON.stringify({ relativePath, sha256, content }),
    Date.now()
  );
}
