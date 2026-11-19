import type Database from 'better-sqlite3';
import type { JSONContent } from '@tiptap/core';
import { normalizeNotebookReferences } from '../shared/notebook-reference-normalization';
import { mapNotebookReferenceNodes } from '../shared/notebook-reference-occurrences';
import { savedReferenceIdFromHref } from '../shared/saved-reference-url';

export function retainNotebookSavedReference(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO notebook_saved_reference_retention(reference_id,reason) VALUES(?,'notebook') ON CONFLICT(reference_id) DO NOTHING"
  ).run(id);
}

export function retainNotebookSavedReferencesInContent(
  db: Database.Database,
  content: JSONContent
): void {
  const ids = new Set<string>();
  mapNotebookReferenceNodes(normalizeNotebookReferences(content), (node) => {
    const href = node.attrs?.referenceUri;
    const id = typeof href === 'string' ? savedReferenceIdFromHref(href) : null;
    if (id) ids.add(id);
    return node;
  });
  for (const id of ids) retainNotebookSavedReference(db, id);
}

export function createNotebookSavedReferenceRetention(db: Database.Database): void {
  db.transaction(() => {
    const existing = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='notebook_saved_reference_retention'"
      )
      .get();
    if (!existing) {
      db.exec(`
        CREATE TABLE notebook_saved_reference_retention(
          reference_id TEXT PRIMARY KEY,
          reason TEXT NOT NULL CHECK(reason IN ('notebook','legacy-unknown'))
        ) WITHOUT ROWID;
        INSERT INTO notebook_saved_reference_retention(reference_id,reason)
          SELECT id,'legacy-unknown' FROM entity_references;
      `);
      const links = db
        .prepare(
          `
        SELECT DISTINCT node.atom AS href FROM pages,
          json_tree(CASE WHEN json_valid(pages.content) THEN pages.content END) AS node
        WHERE node.type='text' AND node.key IN ('href','referenceUri')
      `
        )
        .all() as Array<{ href: string }>;
      for (const { href } of links) {
        const id = savedReferenceIdFromHref(href);
        if (id) retainNotebookSavedReference(db, id);
      }
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS retain_saved_reference_for_notebook
      BEFORE DELETE ON entity_references
      WHEN EXISTS(SELECT 1 FROM notebook_saved_reference_retention WHERE reference_id=OLD.id)
      BEGIN SELECT RAISE(ABORT, 'Saved references used by notebooks or with untracked notebook history must be retained.'); END;`);
  })();
}
