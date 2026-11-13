import type Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { notebookPackageRootForMetaPath } from '../db/notebook-package';
import { workspaceScopeKey } from '../shared/workspace-scoped-identity';
import {
  notebookProjectionFingerprint,
  type NotebookPageRow,
  type NotebookProjectionFromFileInput,
} from '../shared/notebook-projection';
import type { NotebookPublicationState } from '../shared/notebook-publication';
import { replaceNotebookProjectionFromFileInMain } from './notebook-projection-authority';
import { queryLimsEntitiesInDb } from './lims-registry-projection';
import { settleNotebookPresentationInDb } from './notebook-presentation';

export { settleNotebookPresentationInDb } from './notebook-presentation';

export function settleNotebookPublicationInMain(
  db: Database.Database,
  input: NotebookProjectionFromFileInput
): Promise<NotebookPageRow> {
  const workspace = db
    .prepare('SELECT id FROM workspaces WHERE path=?')
    .get(input.workspaceRoot) as { id: number } | undefined;
  if (!workspace) throw new Error('The notebook publication has no owning project.');
  return replaceNotebookProjectionFromFileInMain(
    db,
    input,
    (work) => work(),
    (row) => {
      settleNotebookPresentationInDb(db, {
        pageId: input.pageId,
        title: row.title,
        packageRoot: notebookPackageRootForMetaPath(input.sourcePath) ?? input.sourcePath,
        workspaceId: workspace.id,
      });
    }
  );
}

export function readNotebookPublicationInDb(
  db: Database.Database,
  input: {
    documentId: string;
    workspaceRoot: string;
    path: string;
    title: string;
    content: unknown;
    canonicalFingerprint: string;
  }
): NotebookPublicationState {
  const owners = db
    .prepare(
      "SELECT w.id,w.repo_uuid,w.path AS root,f.path,e.name FROM catalog_entity_files f JOIN workspaces w ON w.id=f.workspace_id JOIN catalog_entities e ON e.id=f.entity_id WHERE f.entity_id=? AND f.status='current'"
    )
    .all(input.documentId) as Array<{
    id: number;
    repo_uuid: string | null;
    root: string;
    path: string;
    name: string;
  }>;
  const workspace = owners.length === 1 ? owners[0] : undefined;
  const page = db.prepare('SELECT title,content FROM pages WHERE id=?').get(input.documentId) as
    | { title: string; content: string }
    | undefined;
  const fingerprint = notebookProjectionFingerprint(input.title, input.content);
  const relativePath = workspace
    ? `${workspace.path.slice(workspace.root.replace(/[\\/]+$/, '').length + 1)}/.forge/notebook.json`.replace(
        /\\/g,
        '/'
      )
    : '';
  const receipt = workspace
    ? (db
        .prepare(
          "SELECT synchronized_fingerprint FROM entity_projection_sources WHERE adapter_kind='notebook' AND entity_id=? AND workspace_key=? AND relative_path=? AND projection_version=1"
        )
        .get(
          input.documentId,
          `scope:${workspaceScopeKey(workspace.repo_uuid, workspace.id)}`,
          relativePath
        ) as { synchronized_fingerprint: string } | undefined)
    : undefined;
  const registry = queryLimsEntitiesInDb(db, {
    id: input.documentId,
    includeArchived: true,
    limit: 1,
  })[0];
  const settled =
    workspace &&
    resolve(workspace.root) === resolve(input.workspaceRoot) &&
    resolve(workspace.path) === resolve(input.path) &&
    page &&
    notebookProjectionFingerprint(page.title, page.content) === fingerprint &&
    receipt?.synchronized_fingerprint === fingerprint &&
    registry?.kind === 'notebook' &&
    registry.name === input.title &&
    registry.workspaceId === workspace.id &&
    registry.fields.packagePath === workspace.path &&
    workspace.name === input.title;
  if (
    page &&
    notebookProjectionFingerprint(page.title, page.content) !== fingerprint &&
    receipt?.synchronized_fingerprint !== notebookProjectionFingerprint(page.title, page.content)
  )
    return {
      status: 'conflict',
      canonicalFingerprint: input.canonicalFingerprint,
      reason: 'Compare both notebook versions before saving.',
    };
  return settled
    ? {
        status: 'settled',
        canonicalFingerprint: input.canonicalFingerprint,
        projectionFingerprint: fingerprint,
      }
    : {
        status: 'pending',
        canonicalFingerprint: input.canonicalFingerprint,
        reason: 'The saved notebook requires project publication settlement.',
      };
}
