import type Database from 'better-sqlite3';
import type { JSONContent } from '@tiptap/core';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileTestDb } from './__tests__/test-db';
import { CURRENT_SCHEMA_VERSION, ensureSchema } from './schema';
import { publishNotebookPackageV2InMain } from './__tests__/publish-notebook-fixture';
import { replaceNotebookProjectionFromFileInMain } from './notebook-projection-authority';
import { replaceNotebookReferenceProjectionInDb } from './notebook-reference-projection';
import {
  createEntityReferenceInDb,
  deleteEntityReferenceInDb,
  recordEntityReferenceRevisionInDb,
} from './entity-reference-commands';
import { prepareNotebookReferenceInsertion } from './notebook-reference-insertion';
import { prepareEntityReferenceRow } from '../shared/entity-reference-ipc';
import { normalizeNotebookReferenceOccurrences } from '../shared/notebook-reference-occurrences';
import { savedReferenceHref } from '../shared/saved-reference-url';
import { notebookPackagePaths } from '../db/notebook-package';
import { notebookProjectionFingerprint } from '../shared/notebook-projection';
import { withRendererEntitySql } from './renderer-entity-sql';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

let fixture: ReturnType<typeof createFileTestDb>;
let db: Database.Database;
let root: string;
let packageRoot: string;
const documentId = 'project-uuid::notebook';
const title = 'Saved references';
const mention = (occurrenceId?: string, entityId = 'target-absent-from-catalog'): JSONContent => ({
  type: 'mention',
  attrs: {
    id: entityId,
    entityId,
    entityType: 'sequence',
    label: 'Saved target',
    ...(occurrenceId ? { occurrenceId } : {}),
  },
});
const content = (...children: JSONContent[]): JSONContent => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: children }],
});
const initial = content(
  mention('10000000-0000-4000-8000-000000000001'),
  mention('10000000-0000-4000-8000-000000000002')
);

beforeEach(async () => {
  fixture = createFileTestDb('notebook-occurrence-publication');
  db = fixture.db;
  ensureSchema(db, fixture.dbPath);
  root = await mkdtemp(join(tmpdir(), 'notebook-occurrence-'));
  packageRoot = join(root, 'Saved references');
  await mkdir(packageRoot);
  await publishNotebookPackageV2InMain({
    packageRoot,
    workspaceRoot: root,
    id: 'notebook',
    title,
    content: initial,
    sourceShape: 'new-package',
  });
  db.prepare('INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(1,?,?,?,1)').run(
    'Project',
    root,
    'project-uuid'
  );
  db.prepare(
    "INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at) VALUES(?,'notebook',?,?,'file',1,1,1)"
  ).run(documentId, title, `entity://page/${documentId}`);
  db.prepare(
    "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at) VALUES('binding',?,1,?,'waypoint-notebook','current',1,1)"
  ).run(documentId, packageRoot);
});
afterEach(async () => {
  fixture.cleanup();
  await rm(root, { recursive: true, force: true });
});

function project(doc: JSONContent, expected: string | null = null) {
  return replaceNotebookProjectionFromFileInMain(db, {
    pageId: documentId,
    workspaceRoot: root,
    sourcePath: notebookPackagePaths(packageRoot).metaPath,
    sourceFingerprint: notebookProjectionFingerprint(title, doc),
    expectedProjectionFingerprint: expected,
  });
}
async function publish(doc: JSONContent) {
  await publishNotebookPackageV2InMain({
    packageRoot,
    workspaceRoot: root,
    id: 'notebook',
    title,
    content: doc,
    sourceShape: 'v2-package',
    existingMetadataRaw: await readFile(notebookPackagePaths(packageRoot).metaPath, 'utf8'),
  });
}
function snapshot() {
  return {
    pages: db.prepare('SELECT * FROM pages').all(),
    links: db.prepare('SELECT * FROM notebook_reference_occurrences ORDER BY occurrence_id').all(),
    coverage: db.prepare('SELECT * FROM notebook_reference_projections').all(),
    receipt: db.prepare('SELECT * FROM entity_projection_sources').all(),
  };
}

function makeSavedReference(id?: string) {
  return createEntityReferenceInDb(
    db,
    prepareEntityReferenceRow(
      {
        entityType: 'notebook',
        displayLabel: title,
        locator: `entity://page/${documentId}`,
        data: { documentId },
        deepLinkParams: null,
        source: 'user',
        workspaceScope: null,
        workspaceRootPath: root,
      },
      { id }
    )
  );
}

describe('file-authoritative notebook link publication', () => {
  it('retains the precise saved reference and its revisions when a notebook uses it without a chat message', async () => {
    const saved = makeSavedReference();
    const transient = makeSavedReference();
    const revision = recordEntityReferenceRevisionInDb(db, {
      referenceId: saved.id,
      changedBy: 'user',
      changeType: 'note',
      previousState: null,
      newState: { note: 'Notebook evidence' },
    });
    const inserted = await prepareNotebookReferenceInsertion(
      db,
      { documentId, path: packageRoot, workspaceRoot: root, readOnly: false, assertCurrent() {} },
      { kind: 'insert-reference', index: 0, referenceId: saved.id }
    );
    await inserted.verify();
    expect(() => deleteEntityReferenceInDb(db, saved.id)).toThrow(/notebook/iu);
    const linked = normalizeNotebookReferenceOccurrences(
      { type: 'doc', content: [inserted.block] },
      { documentId }
    );
    await publish(linked);
    await project(linked);
    const href = savedReferenceHref(saved.id);
    expect(await readFile(notebookPackagePaths(packageRoot).markdownPath, 'utf8')).toContain(href);
    expect(
      db.prepare('SELECT occurrence_id,target_reference FROM notebook_reference_occurrences').get()
    ).toEqual({
      occurrence_id: linked.content![0].content![0].attrs!.occurrenceId,
      target_reference: href,
    });
    expect(
      db.prepare('SELECT 1 FROM message_references WHERE reference_id=?').get(saved.id)
    ).toBeUndefined();
    expect(() => deleteEntityReferenceInDb(db, saved.id)).toThrow(/notebook/iu);
    expect(db.prepare('SELECT id FROM entity_references WHERE id=?').get(saved.id)).toEqual({
      id: saved.id,
    });
    expect(
      db.prepare('SELECT id FROM entity_reference_revisions WHERE reference_id=?').get(saved.id)
    ).toEqual({ id: revision.id });
    deleteEntityReferenceInDb(db, transient.id);
    expect(
      db.prepare('SELECT 1 FROM entity_references WHERE id=?').get(transient.id)
    ).toBeUndefined();
    const unlinked = content({ type: 'text', text: 'Keep these notes.' });
    await publish(unlinked);
    await project(unlinked, notebookProjectionFingerprint(title, linked));
    expect(db.prepare('SELECT 1 FROM notebook_reference_occurrences').get()).toBeUndefined();
    expect(await readFile(notebookPackagePaths(packageRoot).markdownPath, 'utf8')).toContain(
      'Keep these notes.'
    );
    expect(db.prepare('SELECT id FROM catalog_entities WHERE id=?').get(documentId)).toEqual({
      id: documentId,
    });
    expect(() => deleteEntityReferenceInDb(db, saved.id)).toThrow(/notebook/iu);
  });

  it('retains a saved ID found by legacy notebook import even if its record arrives later', async () => {
    const id = crypto.randomUUID();
    const unused = makeSavedReference();
    const href = savedReferenceHref(id);
    const legacy = content(
      {
        type: 'mention',
        attrs: { entityType: 'reference', referenceUri: href, label: 'Saved result' },
      },
      { type: 'text', text: savedReferenceHref(unused.id) }
    );
    await publish(legacy);
    await project(legacy);
    expect(db.prepare('SELECT coverage_status FROM notebook_reference_projections').get()).toEqual({
      coverage_status: 'legacy',
    });
    expect(db.prepare('SELECT 1 FROM notebook_reference_occurrences').get()).toBeUndefined();
    const restored = makeSavedReference(id);
    expect(() => deleteEntityReferenceInDb(db, restored.id)).toThrow(/notebook/iu);
    const tamper = 'DELETE FROM notebook_saved_reference_retention WHERE reference_id=?';
    expect(() => withRendererEntitySql(db, tamper, () => db.prepare(tamper).run(id))).toThrow(
      'ENTITY_IDENTITY_REQUIRES_NATIVE_COMMAND'
    );
    deleteEntityReferenceInDb(db, unused.id);
  });

  it('retains references with unknown v48 history and legacy links whose rows are restored after upgrade', async () => {
    const saved = makeSavedReference();
    const id = crypto.randomUUID();
    const legacy = content({
      type: 'mention',
      attrs: { entityType: 'reference', referenceUri: savedReferenceHref(id), label: 'Link' },
    });
    await publish(legacy);
    await project(legacy);
    db.exec(
      'DROP TRIGGER retain_saved_reference_for_notebook; DROP TABLE notebook_saved_reference_retention; PRAGMA user_version=48'
    );
    ensureSchema(db, fixture.dbPath);
    expect(
      db
        .prepare('SELECT reason FROM notebook_saved_reference_retention WHERE reference_id=?')
        .get(saved.id)
    ).toEqual({ reason: 'legacy-unknown' });
    expect(() => deleteEntityReferenceInDb(db, saved.id)).toThrow(/notebook/iu);
    expect(() => deleteEntityReferenceInDb(db, makeSavedReference(id).id)).toThrow(/notebook/iu);
    const fresh = makeSavedReference();
    ensureSchema(db, fixture.dbPath);
    deleteEntityReferenceInDb(db, fresh.id);
    expect(db.prepare('SELECT 1 FROM entity_references WHERE id=?').get(fresh.id)).toBeUndefined();
  });

  it('projects every repeated occurrence from real saved files with the same source fingerprint', async () => {
    await project(initial);
    const rows = db
      .prepare(
        'SELECT occurrence_id,target_entity_id,source_fingerprint FROM notebook_reference_occurrences ORDER BY occurrence_id'
      )
      .all();
    expect(rows).toEqual(
      ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'].map(
        (occurrence_id) => ({
          occurrence_id,
          target_entity_id: 'target-absent-from-catalog',
          source_fingerprint: notebookProjectionFingerprint(title, initial),
        })
      )
    );
    expect(
      db
        .prepare(
          'SELECT coverage_status,missing_occurrence_count FROM notebook_reference_projections'
        )
        .get()
    ).toEqual({ coverage_status: 'complete', missing_occurrence_count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM catalog_entities').get()).toEqual({ n: 1 });
  });

  it('keeps unknown or unavailable existing targets on unrelated edits and removes only deleted occurrences', async () => {
    await project(initial);
    const edited = content(
      { type: 'text', text: 'Unrelated prose. ' },
      mention('10000000-0000-4000-8000-000000000002')
    );
    await publish(edited);
    await project(edited, notebookProjectionFingerprint(title, initial));
    expect(
      db.prepare('SELECT occurrence_id,target_entity_id FROM notebook_reference_occurrences').all()
    ).toEqual([
      {
        occurrence_id: '10000000-0000-4000-8000-000000000002',
        target_entity_id: 'target-absent-from-catalog',
      },
    ]);
  });

  it('keeps legacy file bytes intact and states incomplete occurrence coverage explicitly', async () => {
    const legacy = content(mention(), mention());
    await publish(legacy);
    const path = notebookPackagePaths(packageRoot).markdownPath;
    const before = await readFile(path, 'utf8');
    const row = await project(legacy);
    expect(JSON.parse(row.content)).toEqual(legacy);
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(
      db
        .prepare(
          'SELECT coverage_status,missing_occurrence_count,source_fingerprint FROM notebook_reference_projections'
        )
        .get()
    ).toEqual({
      coverage_status: 'legacy',
      missing_occurrence_count: 2,
      source_fingerprint: notebookProjectionFingerprint(title, legacy),
    });
  });

  it('rolls back page, references and source receipt together if a link row cannot be written', async () => {
    await project(initial);
    const before = snapshot();
    const edited = content(mention('10000000-0000-4000-8000-000000000003', 'new-target'));
    await publish(edited);
    const path = notebookPackagePaths(packageRoot).markdownPath;
    const saved = await readFile(path, 'utf8');
    db.exec(
      "CREATE TEMP TRIGGER reject_link_projection BEFORE INSERT ON notebook_reference_occurrences BEGIN SELECT RAISE(ABORT,'injected link projection failure'); END"
    );
    await expect(project(edited, notebookProjectionFingerprint(title, initial))).rejects.toThrow(
      'injected link projection failure'
    );
    expect(snapshot()).toEqual(before);
    expect(await readFile(path, 'utf8')).toBe(saved);
    db.exec('DROP TRIGGER reject_link_projection');
    await project(edited, notebookProjectionFingerprint(title, initial));
    await project(edited, notebookProjectionFingerprint(title, edited));
    expect(
      db.prepare('SELECT occurrence_id,target_entity_id FROM notebook_reference_occurrences').all()
    ).toEqual([
      { occurrence_id: '10000000-0000-4000-8000-000000000003', target_entity_id: 'new-target' },
    ]);
  });

  it('refuses forged content or a forged generation rather than publishing an independent link list', async () => {
    await project(initial);
    const before = snapshot();
    for (const input of [
      { documentId, sourceFingerprint: 'wrong', content: initial },
      {
        documentId,
        sourceFingerprint: notebookProjectionFingerprint(title, initial),
        content: content(mention('10000000-0000-4000-8000-000000000004', 'forged')),
      },
    ])
      expect(() => replaceNotebookReferenceProjectionInDb(db, input)).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it('rejects duplicate explicit occurrence IDs without partially replacing a prior projection', async () => {
    await project(initial);
    const before = snapshot();
    const duplicate = content(
      mention('10000000-0000-4000-8000-000000000004', 'one'),
      mention('10000000-0000-4000-8000-000000000004', 'two')
    );
    await publish(duplicate);
    await expect(
      project(duplicate, notebookProjectionFingerprint(title, initial))
    ).rejects.toThrow();
    expect(snapshot()).toEqual(before);
  });

  it('prevents raw renderer SQL from independently editing the derived relationship list', async () => {
    await project(initial);
    const before = snapshot();
    for (const statement of [
      'DELETE FROM notebook_reference_occurrences',
      "UPDATE notebook_reference_occurrences SET target_entity_id='forged'",
      "UPDATE notebook_reference_projections SET source_fingerprint='forged'",
    ])
      expect(() => withRendererEntitySql(db, statement, () => db.prepare(statement).run())).toThrow(
        'ENTITY_IDENTITY_REQUIRES_NATIVE_COMMAND'
      );
    expect(snapshot()).toEqual(before);
  });

  it('upgrades a v47 database additively without changing notebook or catalog contents', async () => {
    await project(initial);
    const before = snapshot();
    db.exec(
      'DROP TABLE notebook_reference_occurrences; DROP TABLE notebook_reference_projections; PRAGMA user_version=47'
    );
    ensureSchema(db, fixture.dbPath);
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.prepare('SELECT * FROM pages').all()).toEqual(before.pages);
    expect(db.prepare('SELECT * FROM entity_projection_sources').all()).toEqual(before.receipt);
    expect(db.prepare('SELECT * FROM notebook_reference_occurrences').all()).toEqual([]);
    await project(initial, notebookProjectionFingerprint(title, initial));
    expect(snapshot()).toEqual(before);
  });

  it('projects a canonical native table cell reference after the real package round trip', async () => {
    const table: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'embed',
          attrs: {
            type: 'table',
            refId: 'inline-table',
            data: {
              cells: [
                [
                  {
                    value: 'Saved entity',
                    type: 'text',
                    reference: {
                      kind: 'native-entity',
                      entityId: 'repo-b::target',
                      occurrenceId: '10000000-0000-4000-8000-000000000009',
                    },
                  },
                ],
              ],
            },
          },
        },
      ],
    };
    await publish(table);
    await project(table);
    expect(
      db
        .prepare(
          'SELECT occurrence_id,target_entity_id,source_fingerprint FROM notebook_reference_occurrences'
        )
        .all()
    ).toEqual([
      {
        occurrence_id: '10000000-0000-4000-8000-000000000009',
        target_entity_id: 'repo-b::target',
        source_fingerprint: notebookProjectionFingerprint(title, table),
      },
    ]);
  });
});
