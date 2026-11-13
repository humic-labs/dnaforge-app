import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { setDirtyState } from '../dirty-state-cache';
import { ensureSchema } from '../schema';
import {
  getWorkspaceScopedDirtyState,
  hasUnsavedWorkspaceBuffers,
} from '../workspace-sync-dirty-state';
import { createTestDb } from './test-db';

describe('workspace-scoped dirty state', () => {
  let db: Database.Database;
  const rootA = join(tmpdir(), 'dnaforge-sync-dirty-a');
  const rootB = join(tmpdir(), 'dnaforge-sync-dirty-b');

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    seedWorkspace(db, 1, 'workspace-a', rootA);
    seedWorkspace(db, 2, 'workspace-b', rootB);
    seedPageBinding(db, 'page-a', 1, join(rootA, 'notes', 'page-a.waypoint-notebook'));
    setDirtyState({ hasDirtyWork: false, details: '' });
  });

  it('maps dirty page and sequence document IDs only to their owning managed workspace', () => {
    seedSequenceBinding(db, 'sequence-document-b', 2, join(rootB, 'designs', 'edited.gb'));
    setDirtyState({
      hasDirtyWork: true,
      details: '2 pages and 3 sequences',
      dirtyPageIds: ['page-a', 'unbound-page'],
      dirtySequenceDocumentIds: ['sequence-document-b', 'unbound-sequence-document'],
    });

    expect(getWorkspaceScopedDirtyState(db)).toEqual({
      'workspace-a': { dirtyPageIds: ['page-a'] },
      'workspace-b': { dirtySequenceDocumentIds: ['sequence-document-b'] },
    });
  });

  it('maps unsaved text and script files to the project folder that contains them', () => {
    const script = join(rootB, 'analyses', 'align', 'run.py');
    setDirtyState({
      hasDirtyWork: true,
      details: '1 file',
      dirtyFilePaths: [script, join(tmpdir(), 'elsewhere', 'notes.txt')],
    });

    const scoped = getWorkspaceScopedDirtyState(db);
    expect(scoped).toEqual({ 'workspace-b': { dirtyFilePaths: [script] } });
    expect(hasUnsavedWorkspaceBuffers(scoped['workspace-b'])).toBe(true);
    expect(hasUnsavedWorkspaceBuffers(scoped['workspace-a'])).toBe(false);
  });
});

function seedWorkspace(
  db: Database.Database,
  id: number,
  workspaceUuid: string,
  path: string
): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, 1, 1)`
  ).run(id, workspaceUuid, path, workspaceUuid);
}

function seedSequenceBinding(
  db: Database.Database,
  documentId: string,
  workspaceId: number,
  path: string
): void {
  db.prepare(
    `INSERT INTO catalog_entities (
       id, type, name, locator, storage_type, status, workspace_id, created_at, updated_at
     ) VALUES (?, 'dna_sequence', ?, ?, 'file', 'active', ?, 1, 1)`
  ).run(documentId, documentId, `sequence:${documentId}`, workspaceId);
  db.prepare(
    `INSERT INTO catalog_entity_files (
       id, entity_id, workspace_id, path, relative_path, file_kind, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'genbank', 'current', 1, 1)`
  ).run(`file-${documentId}`, documentId, workspaceId, path, `designs/${documentId}.gb`);
}

function seedPageBinding(
  db: Database.Database,
  pageId: string,
  workspaceId: number,
  path: string
): void {
  db.prepare(
    `INSERT INTO catalog_entities (
       id, type, name, locator, storage_type, status, workspace_id, created_at, updated_at
     ) VALUES (?, 'notebook', ?, ?, 'database', 'active', ?, 1, 1)`
  ).run(pageId, pageId, `page:${pageId}`, workspaceId);
  db.prepare(
    `INSERT INTO catalog_entity_files (
       id, entity_id, workspace_id, path, relative_path, file_kind, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'waypoint-notebook', 'current', 1, 1)`
  ).run(`file-${pageId}`, pageId, workspaceId, path, `notes/${pageId}.waypoint-notebook`);
}
