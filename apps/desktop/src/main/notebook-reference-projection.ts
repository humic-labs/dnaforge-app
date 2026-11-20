import type Database from 'better-sqlite3';
import type { JSONContent } from '@tiptap/core';
import {
  inspectNotebookReferenceOccurrences,
  NOTEBOOK_REFERENCE_EXTRACTOR_VERSION,
} from '../shared/notebook-reference-occurrences';
import { retainNotebookSavedReferencesInContent } from './notebook-saved-reference-retention';
import { notebookProjectionFingerprint } from '../shared/notebook-projection';

export function createNotebookReferenceProjectionTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notebook_reference_projections (
      document_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
      source_fingerprint TEXT NOT NULL,
      extractor_version INTEGER NOT NULL CHECK(extractor_version >= 1),
      coverage_status TEXT NOT NULL CHECK(coverage_status IN ('complete','legacy')),
      missing_occurrence_count INTEGER NOT NULL CHECK(missing_occurrence_count >= 0),
      UNIQUE(document_id,source_fingerprint),
      CHECK((coverage_status='complete' AND missing_occurrence_count=0) OR
        (coverage_status='legacy' AND missing_occurrence_count>0))
    );
    CREATE TABLE IF NOT EXISTS notebook_reference_occurrences (
      document_id TEXT NOT NULL REFERENCES notebook_reference_projections(document_id) ON DELETE CASCADE,
      occurrence_id TEXT NOT NULL CHECK(length(occurrence_id)>0),
      target_entity_id TEXT,
      target_kind TEXT NOT NULL CHECK(target_kind IN ('entity','saved-reference','resource','unresolved')),
      target_reference TEXT,
      entity_type TEXT,
      representation_id TEXT,
      version_id TEXT,
      source_fingerprint TEXT NOT NULL,
      PRIMARY KEY(document_id,occurrence_id),
      FOREIGN KEY(document_id,source_fingerprint)
        REFERENCES notebook_reference_projections(document_id,source_fingerprint) ON DELETE CASCADE,
      CHECK(target_kind<>'entity' OR target_entity_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_notebook_reference_target
      ON notebook_reference_occurrences(target_entity_id) WHERE target_entity_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_notebook_reference_uri
      ON notebook_reference_occurrences(target_reference) WHERE target_reference IS NOT NULL;
  `);
}

export function replaceNotebookReferenceProjectionInDb(
  db: Database.Database,
  input: { documentId: string; sourceFingerprint: string; content: JSONContent }
): void {
  const extracted = inspectNotebookReferenceOccurrences(input.content);
  db.transaction(() => {
    const page = db.prepare('SELECT title,content FROM pages WHERE id=?').get(input.documentId) as
      | { title: string; content: string }
      | undefined;
    if (
      !page ||
      page.content !== JSON.stringify(input.content) ||
      notebookProjectionFingerprint(page.title, page.content) !== input.sourceFingerprint
    )
      throw new Error('Notebook reference projection must match its exact saved document.');
    retainNotebookSavedReferencesInContent(db, input.content);
    db.prepare('DELETE FROM notebook_reference_occurrences WHERE document_id=?').run(
      input.documentId
    );
    db.prepare(
      `INSERT INTO notebook_reference_projections(document_id,source_fingerprint,extractor_version,coverage_status,missing_occurrence_count)
       VALUES(?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET
       source_fingerprint=excluded.source_fingerprint,extractor_version=excluded.extractor_version,
       coverage_status=excluded.coverage_status,missing_occurrence_count=excluded.missing_occurrence_count`
    ).run(
      input.documentId,
      input.sourceFingerprint,
      NOTEBOOK_REFERENCE_EXTRACTOR_VERSION,
      extracted.missingOccurrenceCount ? 'legacy' : 'complete',
      extracted.missingOccurrenceCount
    );
    const insert = db.prepare(
      `INSERT INTO notebook_reference_occurrences(document_id,occurrence_id,target_entity_id,target_kind,target_reference,entity_type,representation_id,version_id,source_fingerprint)
       VALUES(?,?,?,?,?,?,?,?,?)`
    );
    for (const occurrence of extracted.occurrences)
      insert.run(
        input.documentId,
        occurrence.occurrenceId,
        occurrence.targetEntityId,
        occurrence.targetKind,
        occurrence.targetReference,
        occurrence.entityType,
        occurrence.representationId,
        occurrence.versionId,
        input.sourceFingerprint
      );
  })();
}
