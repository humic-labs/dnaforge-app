import type Database from 'better-sqlite3';
import type { NativeNotebookScope } from './notebook-document-owner';
import type { NotebookDocumentOperation } from '../shared/notebook-document';
import type { ChatEntityReferenceIpcRow } from '../shared/chat-turn-ipc';
import { canonicalJson } from '../shared/canonical-json';
import { workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { notebookReferenceFromHref } from '../shared/notebook-reference-normalization';
import { savedReferenceHref } from '../shared/saved-reference-url';
import {
  molecularDocumentCatalogId,
  molecularDocumentReferenceHref,
  molecularDocumentRevision,
  molecularDocumentRevisionDigest,
} from '../shared/molecular-document-reference';
import { molecularReferenceSnapshotIndex } from '../shared/molecular-reference';
import { molViewSpecColorGroups } from '../shared/molecular-color-groups';
import { MolecularDocumentLibrary } from './molecular-document-library';
import { assertEntityReferenceTargetInDb } from './entity-reference-commands';

export async function prepareNotebookReferenceInsertion(
  db: Database.Database,
  scope: NativeNotebookScope,
  operation: Extract<NotebookDocumentOperation, { kind: 'insert-reference' }>
) {
  if (Boolean(operation.referenceId) === Boolean(operation.documentReference))
    throw new Error('Supply exactly one returned documentReference or referenceId.');
  scope.assertCurrent();
  const reference = operation.referenceId
    ? (db.prepare('SELECT * FROM entity_references WHERE id=?').get(operation.referenceId) as
        | ChatEntityReferenceIpcRow
        | undefined)
    : undefined;
  let href: string, label: string;
  if (operation.documentReference) {
    const target = operation.documentReference;
    const workspace = db
      .prepare(
        'SELECT id,path,repo_uuid FROM workspaces WHERE path=? AND archived_at IS NULL AND trashed_at IS NULL'
      )
      .get(scope.workspaceRoot) as
      | { id: number; path: string; repo_uuid: string | null }
      | undefined;
    if (!workspace || workspaceScopeKey(workspace.repo_uuid, workspace.id) !== target.projectId)
      throw new Error('The molecular document belongs to another project.');
    const files = db
      .prepare(
        "SELECT f.path FROM catalog_entity_files f JOIN catalog_entities e ON e.id=f.entity_id WHERE f.entity_id=? AND f.workspace_id=? AND f.status='current' AND e.type='molecular-document' AND e.status='active'"
      )
      .all(molecularDocumentCatalogId(target), workspace.id) as Array<{ path: string }>;
    if (files.length !== 1)
      throw new Error('The molecular document has missing or ambiguous ownership.');
    const saved = await new MolecularDocumentLibrary().read({
      path: files[0].path,
      workspaceRoot: scope.workspaceRoot,
    });
    if (saved.document.id !== target.documentId)
      throw new Error('The molecular document contains a different identity.');
    const snapshot = molecularDocumentRevision(saved.document, target.revisionId);
    if ((await molecularDocumentRevisionDigest(snapshot)) !== target.revisionSha256)
      throw new Error('The molecular document revision differs from the exact referenced content.');
    if (target.viewId) molecularReferenceSnapshotIndex(snapshot, { viewId: target.viewId });
    if (
      target.groupId &&
      (!target.viewId ||
        !molViewSpecColorGroups(
          snapshot.scene,
          molecularReferenceSnapshotIndex(snapshot, { viewId: target.viewId })
        ).some((group) => group.id === target.groupId && group.selectable))
    )
      throw new Error('The referenced molecular group is unavailable.');
    href = molecularDocumentReferenceHref(target);
    label = operation.label ?? snapshot.title;
  } else {
    if (!reference) throw new Error('The saved result does not exist.');
    assertEntityReferenceTargetInDb(db, reference);
    href = savedReferenceHref(reference.id);
    label = operation.label ?? reference.display_label;
  }
  scope.assertCurrent();
  return {
    block: { type: 'paragraph', content: [notebookReferenceFromHref(href, label)!] },
    verify: async () => {
      scope.assertCurrent();
      if (reference) {
        const current = db
          .prepare('SELECT * FROM entity_references WHERE id=?')
          .get(reference.id) as ChatEntityReferenceIpcRow | undefined;
        if (!current || canonicalJson(current) !== canonicalJson(reference))
          throw new Error('The saved reference changed during insertion.');
        assertEntityReferenceTargetInDb(db, current);
      }
    },
  };
}
