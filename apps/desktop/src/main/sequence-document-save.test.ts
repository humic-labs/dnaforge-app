import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./ipc/database', () => ({ getDb: () => db }));

import {
  listManagedGenBankAnnotations,
  serializeSequenceForInPlaceSave,
  type AnnotatedSequence,
} from '@waypoint/sequence-utils';
import {
  buildSequencePackageDocument,
  fromPackageRelative,
  parseSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
} from '../db/sequence-package';
import {
  SEQUENCE_EDIT_TRANSITION_EVENT_TYPE,
  type SequenceDocumentSaveInput,
} from '../shared/sequence-edit-lineage';
import { prepareSequencePackageRevision } from '../db/sequence-package-versioning';
import { parseSequenceEditTransition } from './sequence-edit-lineage';
import { saveSequenceDocumentWithLineage } from './sequence-document-save';
import {
  applySequenceRestoreInMain,
  previewSequenceRestoreInMain,
  publishAcceptedAssemblyRevisionInMain,
  publishSequencePackageRevisionInMain,
  publishSequenceMetadataRevisionInMain,
  recoverSequencePackageRevisionPublicationInMain,
} from './sequence-package-revision-publication';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { ensureWorkspaceOwnerInDb } from './catalog-projection-commands';
import { registerCatalogEntityInDb } from './catalog-entity-registration';
import { assertNativeSequenceContentWritable } from './native-sequence-content-access';
import { acquireWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';

const DOCUMENT_ID = 'sequence-save-lineage-document';
const LINEAGE_ID = 'draft-lineage-one';

let root = '';
let sourcePath = '';
let db: Database.Database;

function sequence(bases: string): AnnotatedSequence {
  return {
    id: DOCUMENT_ID,
    name: 'lineage-test',
    sequence: bases,
    length: bases.length,
    circular: false,
    annotations: [],
  };
}

function request(
  baseline: string,
  draft: string,
  ranges: SequenceDocumentSaveInput['capture']['insertedRanges'],
  lineageId = LINEAGE_ID
): SequenceDocumentSaveInput {
  return {
    documentId: DOCUMENT_ID,
    sourcePath,
    capture: {
      sequence: sequence(draft),
      draftBaseline: { sequence: baseline, length: baseline.length, circular: false },
      draftSequence: draft,
      insertedRanges: ranges,
      deletedRanges: [],
      substitutedRanges: [],
      draftLineageId: lineageId,
    },
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    db,
    resolve: async () => ({ documentId: DOCUMENT_ID, workspaceRoot: root, sourcePath }),
    runDatabase: <T>(operation: () => T): T => operation(),
    createEventId: (() => {
      let value = 0;
      return () => `event-${++value}`;
    })(),
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sequence-save-lineage-'));
  sourcePath = join(root, 'sequence.gb');
  db = createTestDb();
  ensureSchema(db, ':memory:');
  ensureWorkspaceOwnerInDb(db, root);
  db.prepare("UPDATE workspaces SET id=7, repo_uuid='sequence-project' WHERE path=?").run(root);
  registerCatalogEntityInDb(db, {
    id: DOCUMENT_ID,
    type: 'sequence',
    name: 'lineage-test',
    locator: `entity://sequence/${DOCUMENT_ID}`,
    storageType: 'file',
    workspaceRoot: root,
  });
  db.prepare(
    "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at) VALUES ('lineage-source',?,7,?,'genbank','current',1,1)"
  ).run(DOCUMENT_ID, sourcePath);
  db.exec('DELETE FROM catalog_entity_events');
  await writeFile(sourcePath, serializeSequenceForInPlaceSave(sequence('AACC'), sourcePath));
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe('main-owned sequence document save', () => {
  it('retains resource and viewer refusals for committed reads by the exact database fence owner', async () => {
    const release = await acquireWorkspaceSyncDatabaseFence(db);
    try {
      expect(() => assertNativeSequenceContentWritable(db, DOCUMENT_ID, root)).toThrow(
        'WORKSPACE_SYNC_DATABASE_BUSY'
      );
      expect(() =>
        assertNativeSequenceContentWritable(db, DOCUMENT_ID, root, release)
      ).not.toThrow();
      db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
      expect(() => assertNativeSequenceContentWritable(db, DOCUMENT_ID, root, release)).toThrow(
        'unique current owning project'
      );
      db.prepare("UPDATE workspaces SET access_mode='writable' WHERE id=7").run();
      bindRole('viewer');
      expect(() => assertNativeSequenceContentWritable(db, DOCUMENT_ID, root, release)).toThrow(
        'view only'
      );
      db.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
      expect(() =>
        assertNativeSequenceContentWritable(db, DOCUMENT_ID, root, release)
      ).not.toThrow();
      expect(() =>
        assertNativeSequenceContentWritable(db, DOCUMENT_ID, root + '-other', release)
      ).toThrow('owner changed');
      db.exec('BEGIN');
      expect(() => assertNativeSequenceContentWritable(db, DOCUMENT_ID, root, release)).toThrow(
        'DATABASE_UNCOMMITTED_AUTHORITY_READ'
      );
      db.exec('ROLLBACK');
    } finally {
      if (db.inTransaction) db.exec('ROLLBACK');
      release();
    }
    expect(() => assertNativeSequenceContentWritable(db, DOCUMENT_ID, root, release)).toThrow(
      'WORKSPACE_DATABASE_FENCE_INVALID'
    );
  });
  it('refuses a different valid payload path without writing either file or recording lineage', async () => {
    const other = join(root, 'another.gb');
    await writeFile(other, serializeSequenceForInPlaceSave(sequence('AACC'), other));
    const boundBefore = await readFile(sourcePath, 'utf8');
    const otherBefore = await readFile(other, 'utf8');
    const boundModified = (await stat(sourcePath, { bigint: true })).mtimeNs;
    const otherModified = (await stat(other, { bigint: true })).mtimeNs;

    await expect(
      saveSequenceDocumentWithLineage(
        { ...request('AACC', 'AATTCC', [{ start: 2, end: 4 }]), sourcePath: other },
        dependencies()
      )
    ).rejects.toThrow(/native document binding/i);

    expect(await readFile(sourcePath, 'utf8')).toBe(boundBefore);
    expect(await readFile(other, 'utf8')).toBe(otherBefore);
    expect((await stat(sourcePath, { bigint: true })).mtimeNs).toBe(boundModified);
    expect((await stat(other, { bigint: true })).mtimeNs).toBe(otherModified);
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_entity_events').get()).toEqual({
      count: 0,
    });
  });

  async function managedSource(name: string) {
    const paths = sequencePackagePaths(join(root, name), { productFile: 'sequence.gb' });
    await mkdir(paths.metaDir, { recursive: true });
    sourcePath = paths.productPath;
    await writeFile(sourcePath, serializeSequenceForInPlaceSave(sequence('AACC'), sourcePath));
    await writeFile(
      paths.metaPath,
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: DOCUMENT_ID,
          name: 'lineage-test',
          product: { file: 'sequence.gb', topology: 'linear' },
        })
      )
    );
    return paths;
  }

  it.each([false, true])(
    'recognizes an exact published retry with the original native source hash (managed=%s)',
    async (managed) => {
      const paths = managed ? await managedSource('native-retry') : undefined;
      const original = await readFile(sourcePath, 'utf8');
      const captured = request('AACC', 'AATTCC', [{ start: 2, end: 4 }]);
      captured.capture.sequence.annotations = [
        {
          name: 'New feature',
          type: 'misc_feature',
          start: 1,
          end: 3,
          direction: 1,
        },
      ];
      const onPublished = vi.fn();
      const deps = dependencies({
        expectedFileSha256: `sha256:${createHash('sha256').update(original).digest('hex')}`,
        onPublished,
      });
      const first = await saveSequenceDocumentWithLineage(captured, deps);
      const published = await readFile(sourcePath, 'utf8');
      const marker = paths ? await readFile(paths.metaPath, 'utf8') : undefined;
      expect(await saveSequenceDocumentWithLineage(captured, deps)).toEqual(first);
      expect(await readFile(sourcePath, 'utf8')).toBe(published);
      if (paths) expect(await readFile(paths.metaPath, 'utf8')).toBe(marker);
      expect(onPublished).toHaveBeenCalledTimes(2);
      expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_entity_events').get()).toEqual({
        count: 1,
      });
    }
  );

  it.each([false, true])(
    'refuses external annotation-only changes with the native source hash (managed=%s)',
    async (managed) => {
      const paths = managed ? await managedSource('native-external') : undefined;
      const original = await readFile(sourcePath, 'utf8');
      const external = sequence('AACC');
      external.annotations = [
        { name: 'External feature', type: 'misc_feature', start: 1, end: 2, direction: 1 },
      ];
      const replacement = serializeSequenceForInPlaceSave(external, sourcePath);
      await writeFile(sourcePath, replacement);
      const marker = paths ? await readFile(paths.metaPath, 'utf8') : undefined;
      const onPublished = vi.fn();
      await expect(
        saveSequenceDocumentWithLineage(
          request('AACC', 'AATTCC', [{ start: 2, end: 4 }]),
          dependencies({
            expectedFileSha256: `sha256:${createHash('sha256').update(original).digest('hex')}`,
            onPublished,
          })
        )
      ).rejects.toMatchObject({ code: 'FILE_CHANGED', stateChanged: false });
      expect(await readFile(sourcePath, 'utf8')).toBe(replacement);
      if (paths) expect(await readFile(paths.metaPath, 'utf8')).toBe(marker);
      expect(onPublished).not.toHaveBeenCalled();
      expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_entity_events').get()).toEqual({
        count: 0,
      });
    }
  );
  it.each(["access_mode='reference'", 'archived_at=1', 'trashed_at=1'])(
    'refuses an inactive or reference owner with %s',
    async (change) => {
      db.exec(`UPDATE workspaces SET ${change} WHERE id=7`);
      const bytes = await readFile(sourcePath, 'utf8');
      await expect(
        saveSequenceDocumentWithLineage(
          request('AACC', 'AATTCC', [{ start: 2, end: 4 }]),
          dependencies()
        )
      ).rejects.toThrow(/owning project/i);
      expect(await readFile(sourcePath, 'utf8')).toBe(bytes);
      expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_entity_events').get()).toEqual({
        count: 0,
      });
    }
  );

  it('refuses a save when current role state cannot be read', async () => {
    db.exec('DROP TABLE workspace_sync_bindings');
    const bytes = await readFile(sourcePath, 'utf8');
    await expect(
      saveSequenceDocumentWithLineage(
        request('AACC', 'AATTCC', [{ start: 2, end: 4 }]),
        dependencies()
      )
    ).rejects.toThrow(/workspace_sync_bindings/);
    expect(await readFile(sourcePath, 'utf8')).toBe(bytes);
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_entity_events').get()).toEqual({
      count: 0,
    });
  });
  function bindRole(role: 'viewer' | 'editor' | 'manager' | 'owner', enabled = 1) {
    db.prepare(
      "INSERT INTO workspace_sync_bindings(workspace_id, workspace_uuid, access_role, enabled, owner_account_id, created_at, updated_at) VALUES (7,?,?,?,'test-account',1,1)"
    ).run('sequence-project', role, enabled);
  }

  it.each([0, 1])(
    'refuses a shared viewer save with sync=%s before file or lineage mutation',
    async (enabled) => {
      bindRole('viewer', enabled);
      const bytes = await readFile(sourcePath, 'utf8');
      await expect(
        saveSequenceDocumentWithLineage(
          request('AACC', 'AATTCC', [{ start: 2, end: 4 }]),
          dependencies()
        )
      ).rejects.toThrow(/shared project is view only/i);
      expect(await readFile(sourcePath, 'utf8')).toBe(bytes);
      expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_entity_events').get()).toEqual({
        count: 0,
      });
    }
  );

  it('checks the current role again after reading the document', async () => {
    bindRole('editor');
    const bytes = await readFile(sourcePath, 'utf8');
    await expect(
      saveSequenceDocumentWithLineage(
        request('AACC', 'AATTCC', [{ start: 2, end: 4 }]),
        dependencies({
          readText: async (path: string) => {
            const value = await readFile(path, 'utf8');
            db.prepare("UPDATE workspace_sync_bindings SET access_role='viewer'").run();
            return value;
          },
        })
      )
    ).rejects.toThrow(/shared project is view only/i);
    expect(await readFile(sourcePath, 'utf8')).toBe(bytes);
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_entity_events').get()).toEqual({
      count: 0,
    });
  });

  it('uses a promoted editor role for a later offline save', async () => {
    bindRole('viewer', 0);
    const input = request('AACC', 'AATTCC', [{ start: 2, end: 4 }]);
    await expect(saveSequenceDocumentWithLineage(input, dependencies())).rejects.toThrow(
      /view only/i
    );
    db.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    expect(await saveSequenceDocumentWithLineage(input, dependencies())).toMatchObject({
      status: 'saved',
    });
    expect(await readFile(sourcePath, 'utf8')).toContain('AATTCC');
  });

  it.each(['editor', 'manager', 'owner'] as const)(
    'allows an offline shared %s save',
    async (role) => {
      bindRole(role, 0);
      expect(
        await saveSequenceDocumentWithLineage(
          request('AACC', 'AATTCC', [{ start: 2, end: 4 }]),
          dependencies()
        )
      ).toMatchObject({ status: 'saved' });
    }
  );

  it('keeps the stored owner identity when the workspace root is aliased', async () => {
    bindRole('viewer');
    const alias = join(root, 'project-alias');
    await symlink(root, alias);
    db.prepare('UPDATE workspaces SET path=? WHERE id=7').run(alias);
    await expect(
      saveSequenceDocumentWithLineage(
        request('AACC', 'AATTCC', [{ start: 2, end: 4 }]),
        dependencies()
      )
    ).rejects.toThrow(/view only/i);
  });

  it('does not apply an obsolete viewer binding to a replacement project', async () => {
    bindRole('viewer');
    db.prepare("UPDATE workspaces SET repo_uuid='replacement' WHERE id=7").run();
    expect(
      await saveSequenceDocumentWithLineage(
        request('AACC', 'AATTCC', [{ start: 2, end: 4 }]),
        dependencies()
      )
    ).toMatchObject({ status: 'saved' });
  });

  it.each(['missing', 'ambiguous'] as const)(
    'refuses a save with a %s catalog owner',
    async (kind) => {
      if (kind === 'missing') db.prepare('DELETE FROM catalog_entity_files').run();
      else {
        db.exec('DROP INDEX idx_catalog_entity_files_one_current');
        db.prepare(
          "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at) VALUES ('ambiguous-source',?,7,?,'genbank','current',1,1)"
        ).run(DOCUMENT_ID, join(root, 'ambiguous.gb'));
      }
      const bytes = await readFile(sourcePath, 'utf8');
      await expect(
        saveSequenceDocumentWithLineage(
          request('AACC', 'AATTCC', [{ start: 2, end: 4 }]),
          dependencies()
        )
      ).rejects.toThrow(/unique current owning project/i);
      expect(await readFile(sourcePath, 'utf8')).toBe(bytes);
      expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_entity_events').get()).toEqual({
        count: 0,
      });
    }
  );

  it('refuses an owner that changed during preparation', async () => {
    const other = join(root, 'different-owner');
    await mkdir(other);
    db.prepare('UPDATE workspaces SET path=? WHERE id=7').run(other);
    const bytes = await readFile(sourcePath, 'utf8');
    await expect(
      saveSequenceDocumentWithLineage(
        request('AACC', 'AATTCC', [{ start: 2, end: 4 }]),
        dependencies()
      )
    ).rejects.toThrow(/owner changed/i);
    expect(await readFile(sourcePath, 'utf8')).toBe(bytes);
  });

  it('keeps managed product bytes and version history unchanged for a viewer', async () => {
    const packageRoot = join(root, 'viewer-managed-package');
    const paths = sequencePackagePaths(packageRoot, { productFile: 'sequence.gb' });
    await mkdir(paths.metaDir, { recursive: true });
    sourcePath = paths.productPath;
    await writeFile(sourcePath, serializeSequenceForInPlaceSave(sequence('AACC'), sourcePath));
    await writeFile(
      paths.metaPath,
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: DOCUMENT_ID,
          name: 'lineage-test',
          product: { file: 'sequence.gb', topology: 'linear' },
        })
      )
    );
    bindRole('viewer', 0);
    const product = await readFile(sourcePath, 'utf8');
    const metadata = await readFile(paths.metaPath, 'utf8');
    await expect(
      saveSequenceDocumentWithLineage(
        request('AACC', 'AATTCC', [{ start: 2, end: 4 }]),
        dependencies()
      )
    ).rejects.toThrow(/view only/i);
    expect(await readFile(sourcePath, 'utf8')).toBe(product);
    expect(await readFile(paths.metaPath, 'utf8')).toBe(metadata);
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_entity_events').get()).toEqual({
      count: 0,
    });
  });

  it('publishes an atomic edit and records coordinate-only lineage', async () => {
    const result = await saveSequenceDocumentWithLineage(
      request('AACC', 'AATTCC', [{ start: 2, end: 4 }]),
      dependencies()
    );

    expect(result).toEqual({
      status: 'saved',
      fileSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      eventId: 'event-1',
      lineage: 'recorded',
    });
    const row = db.prepare('SELECT payload FROM catalog_entity_events').get() as {
      payload: string;
    };
    expect(row.payload).not.toContain('AACC');
    expect(row.payload).not.toContain('AATTCC');
    expect(parseSequenceEditTransition(row.payload)).toMatchObject({
      parentEventId: null,
      draftLineageId: LINEAGE_ID,
      transition: {
        beforeLength: 4,
        afterLength: 6,
        operations: [{ kind: 'insert', at: 2, length: 2 }],
      },
    });
  });

  it('replaces a racing sibling from the same immutable draft baseline', async () => {
    await saveSequenceDocumentWithLineage(
      request('AACC', 'AATTCC', [{ start: 2, end: 4 }]),
      dependencies()
    );
    const first = parseSequenceEditTransition(
      (
        db.prepare("SELECT payload FROM catalog_entity_events WHERE id='event-1'").get() as {
          payload: string;
        }
      ).payload
    );

    const result = await saveSequenceDocumentWithLineage(
      request('AACC', 'AAGGCC', [{ start: 2, end: 4 }]),
      dependencies({ createEventId: () => 'event-2' })
    );
    const second = parseSequenceEditTransition(
      (
        db.prepare("SELECT payload FROM catalog_entity_events WHERE id='event-2'").get() as {
          payload: string;
        }
      ).payload
    );

    expect(result).toEqual({
      status: 'saved',
      fileSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      eventId: 'event-2',
      lineage: 'recorded',
    });
    expect(second.parentEventId).toBe(first.parentEventId);
    expect(second.beforeFileSha256).toBe(first.beforeFileSha256);
    expect(second.afterFileSha256).not.toBe(first.afterFileSha256);
  });

  it('refuses a stale draft after an unowned external replacement', async () => {
    await saveSequenceDocumentWithLineage(
      request('AACC', 'AATTCC', [{ start: 2, end: 4 }]),
      dependencies()
    );
    await writeFile(sourcePath, serializeSequenceForInPlaceSave(sequence('CCAA'), sourcePath));

    await expect(
      saveSequenceDocumentWithLineage(
        request('AACC', 'AAGGCC', [{ start: 2, end: 4 }]),
        dependencies({ createEventId: () => 'event-2' })
      )
    ).rejects.toThrow(/baseline|sibling/);
  });

  it('does not publish when marker evidence cannot replay the baseline', async () => {
    const before = await readFile(sourcePath, 'utf8');
    await expect(
      saveSequenceDocumentWithLineage(
        request('AACC', 'AATTCC', [{ start: 1, end: 3 }]),
        dependencies()
      )
    ).rejects.toThrow(/mismatch/);
    expect(await readFile(sourcePath, 'utf8')).toBe(before);
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM catalog_entity_events WHERE event_type=?')
        .get(SEQUENCE_EDIT_TRANSITION_EVENT_TYPE)
    ).toEqual({
      count: 0,
    });
  });

  it('reports lineage unavailable without repeating a successful file publication', async () => {
    db.exec(
      `CREATE TEMP TRIGGER fail_lineage_projection BEFORE INSERT ON catalog_entity_events WHEN NEW.event_type='${SEQUENCE_EDIT_TRANSITION_EVENT_TYPE}' BEGIN SELECT RAISE(ABORT,'event ledger unavailable'); END`
    );
    const result = await saveSequenceDocumentWithLineage(
      request('AACC', 'AATTCC', [{ start: 2, end: 4 }]),
      dependencies()
    );

    expect(result).toEqual({
      status: 'saved',
      fileSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      eventId: null,
      lineage: 'unavailable',
    });
    const saved = await readFile(sourcePath, 'utf8');
    expect(`sha256:${createHash('sha256').update(saved).digest('hex')}`).toMatch(
      /^sha256:[a-f0-9]{64}$/
    );
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM catalog_entity_events WHERE event_type=?')
        .get(SEQUENCE_EDIT_TRANSITION_EVENT_TYPE)
    ).toEqual({
      count: 0,
    });
  });

  it('keeps both packaged product versions when the SQLite projection fails', async () => {
    const packageRoot = join(root, 'managed-package');
    const paths = sequencePackagePaths(packageRoot, { productFile: 'sequence.gb' });
    await mkdir(paths.metaDir, { recursive: true });
    sourcePath = paths.productPath;
    await writeFile(sourcePath, serializeSequenceForInPlaceSave(sequence('AACC'), sourcePath));
    await writeFile(
      paths.metaPath,
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: DOCUMENT_ID,
          name: 'lineage-test',
          product: { file: 'sequence.gb', topology: 'linear' },
        })
      )
    );
    db.exec(
      `CREATE TEMP TRIGGER fail_lineage_projection BEFORE INSERT ON catalog_entity_events WHEN NEW.event_type='${SEQUENCE_EDIT_TRANSITION_EVENT_TYPE}' BEGIN SELECT RAISE(ABORT,'SQLite projection unavailable'); END`
    );
    const capturedSave = request('AACC', 'AATTCC', [{ start: 2, end: 4 }]);
    const result = await saveSequenceDocumentWithLineage(capturedSave, dependencies());
    expect(result).toMatchObject({
      status: 'saved',
      fileSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      lineage: 'recorded',
    });
    expect(await saveSequenceDocumentWithLineage(capturedSave, dependencies())).toEqual(result);
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM catalog_entity_events WHERE event_type=?')
        .get(SEQUENCE_EDIT_TRANSITION_EVENT_TYPE)
    ).toEqual({
      count: 0,
    });
    const copyRoot = join(root, 'copied-without-database');
    await cp(packageRoot, copyRoot, { recursive: true });
    const copied = parseSequencePackageDocument(
      await readFile(sequencePackagePaths(copyRoot).metaPath, 'utf8')
    );
    expect(copied.versionHistory.revisions.map((revision) => revision.kind)).toEqual([
      'adopted',
      'sequence-save',
    ]);
    const snapshots = await Promise.all(
      copied.versionHistory.revisions.map((revision) =>
        readFile(fromPackageRelative(revision.productSnapshot.path, copyRoot), 'utf8')
      )
    );
    expect(snapshots[0].toUpperCase()).toContain('AACC');
    expect(snapshots[1].toUpperCase()).toContain('AATTCC');
  });

  it('gives managed annotations portable identities on Save and keeps them on an exact retry', async () => {
    const packageRoot = join(root, 'managed-annotations');
    const paths = sequencePackagePaths(packageRoot, { productFile: 'sequence.gb' });
    await mkdir(paths.metaDir, { recursive: true });
    sourcePath = paths.productPath;
    await writeFile(sourcePath, serializeSequenceForInPlaceSave(sequence('AACC'), sourcePath));
    await writeFile(
      paths.metaPath,
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: DOCUMENT_ID,
          name: 'lineage-test',
          product: { file: 'sequence.gb', topology: 'linear' },
        })
      )
    );
    const save = request('AACC', 'AATTCC', [{ start: 2, end: 4 }]);
    save.capture.sequence.annotations = [
      { name: 'New feature', type: 'misc_feature', start: 1, end: 3, direction: 1 },
    ];
    const first = await saveSequenceDocumentWithLineage(save, dependencies());
    const saved = await readFile(sourcePath, 'utf8');
    const annotations = listManagedGenBankAnnotations(saved);
    expect(annotations).toMatchObject([{ name: 'New feature' }]);
    expect(annotations[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(first).toMatchObject({ managedAnnotationIds: [annotations[0].id] });
    const marker = parseSequencePackageDocument(await readFile(paths.metaPath, 'utf8'));
    expect(marker.versionHistory.revisions.at(-1)?.state.annotationItems).toEqual([
      { id: annotations[0].id, label: 'New feature' },
    ]);
    expect(await saveSequenceDocumentWithLineage(save, dependencies())).toEqual(first);
    expect(await readFile(sourcePath, 'utf8')).toBe(saved);
  });

  it('puts Metadata and DNA Save on one portable parent chain', async () => {
    const packageRoot = join(root, 'metadata-chain');
    const paths = sequencePackagePaths(packageRoot, { productFile: 'sequence.gb' });
    await mkdir(paths.metaDir, { recursive: true });
    sourcePath = paths.productPath;
    await writeFile(sourcePath, serializeSequenceForInPlaceSave(sequence('AACC'), sourcePath));
    await writeFile(
      paths.metaPath,
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: DOCUMENT_ID,
          name: 'lineage-test',
          product: { file: 'sequence.gb', topology: 'linear' },
        })
      )
    );
    await saveSequenceDocumentWithLineage(
      request('AACC', 'AATTCC', [{ start: 2, end: 4 }]),
      dependencies()
    );
    const before = await readFile(paths.metaPath, 'utf8');
    const current = parseSequencePackageDocument(before);
    const result = await publishSequenceMetadataRevisionInMain({
      workspaceRoot: root,
      request: {
        document: { kind: 'managed-sequence', packageId: DOCUMENT_ID, packageRoot },
        expectedMarkerSha256: `sha256:${createHash('sha256').update(before).digest('hex')}`,
        operationId: 'rename-one',
        proposed: {
          name: 'Renamed entity',
          topology: current.product.topology,
          entity: {
            ...current.entity,
            fields: { ...current.entity.fields, description: 'A recorded metadata edit' },
          },
        },
      },
    });
    expect(result.productChanged).toBe(false);
    const copyRoot = join(root, 'metadata-chain-copy');
    await cp(packageRoot, copyRoot, { recursive: true });
    const copied = parseSequencePackageDocument(
      await readFile(sequencePackagePaths(copyRoot).metaPath, 'utf8')
    );
    expect(copied.versionHistory.revisions.map((revision) => revision.kind)).toEqual([
      'adopted',
      'sequence-save',
      'metadata-update',
    ]);
    expect(copied.versionHistory.revisions.map((revision) => revision.parentId)).toEqual([
      null,
      copied.versionHistory.revisions[0].id,
      copied.versionHistory.revisions[1].id,
    ]);
    expect(copied.versionHistory.revisions[2].state.entity.fields.description).toBe(
      'A recorded metadata edit'
    );
    expect(copied.versionHistory.revisions[2].productSnapshot).toEqual(
      copied.versionHistory.revisions[1].productSnapshot
    );
  });

  it('serializes competing metadata revisions and accepts only an exact completed retry', async () => {
    const packageRoot = join(root, 'competing-metadata');
    const paths = sequencePackagePaths(packageRoot, { productFile: 'sequence.gb' });
    await mkdir(paths.metaDir, { recursive: true });
    await writeFile(
      paths.productPath,
      serializeSequenceForInPlaceSave(sequence('AACC'), paths.productPath)
    );
    const document = buildSequencePackageDocument({
      id: DOCUMENT_ID,
      name: 'Before',
      product: { file: 'sequence.gb', topology: 'linear' },
    });
    const before = serializeSequencePackageDocument(document);
    await writeFile(paths.metaPath, before);
    const expectedMarkerSha256 = `sha256:${createHash('sha256').update(before).digest('hex')}`;
    const requestFor = (operationId: string, name: string) => ({
      document: { kind: 'managed-sequence' as const, packageId: DOCUMENT_ID, packageRoot },
      expectedMarkerSha256,
      operationId,
      proposed: { name, topology: 'linear' as const, entity: document.entity },
    });
    const first = requestFor('first-update', 'First');
    const second = requestFor('second-update', 'Second');
    const results = await Promise.allSettled([
      publishSequenceMetadataRevisionInMain({ workspaceRoot: root, request: first }),
      publishSequenceMetadataRevisionInMain({ workspaceRoot: root, request: second }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const winner = results[0].status === 'fulfilled' ? first : second;
    const retry = await publishSequenceMetadataRevisionInMain({
      workspaceRoot: root,
      request: winner,
    });
    expect(retry.alreadyPublished).toBe(true);
    const current = parseSequencePackageDocument(await readFile(paths.metaPath, 'utf8'));
    expect(current.name).toBe(winner.proposed.name);
    expect(current.versionHistory.revisions.map((revision) => revision.kind)).toEqual([
      'adopted',
      'metadata-update',
    ]);
    await expect(
      publishSequenceMetadataRevisionInMain({
        workspaceRoot: root,
        request: { ...winner, proposed: { ...winner.proposed, name: 'Different retry' } },
      })
    ).rejects.toThrow(/operation ID was already used/);
    expect(parseSequencePackageDocument(await readFile(paths.metaPath, 'utf8')).name).toBe(
      winner.proposed.name
    );
  });

  it('publishes accepted assembly and immutable primer exports under the same package head', async () => {
    const packageRoot = join(root, 'accepted-overwrite');
    const paths = sequencePackagePaths(packageRoot, { productFile: 'sequence.gb' });
    await mkdir(paths.metaDir, { recursive: true });
    const beforeProduct = serializeSequenceForInPlaceSave(sequence('AACC'), paths.productPath);
    const afterProduct = serializeSequenceForInPlaceSave(sequence('AATT'), paths.productPath);
    const initial = buildSequencePackageDocument({
      id: DOCUMENT_ID,
      name: 'Before',
      product: { file: 'sequence.gb', topology: 'linear' },
    });
    const beforeMarker = serializeSequencePackageDocument(initial);
    await writeFile(paths.metaPath, beforeMarker);
    await writeFile(paths.productPath, beforeProduct);
    const acceptedVersionId = 'accepted-test-one';
    const csvPath = 'contents/accepted-test-one.primers.csv';
    const fastaPath = 'contents/accepted-test-one.primers.fasta';
    const csvContent = 'primer,sequence\n';
    const fastaContent = '>primer\nAA\n';
    const hash = (content: string) =>
      `sha256:${createHash('sha256').update(content).digest('hex')}`;
    const next = buildSequencePackageDocument({
      id: DOCUMENT_ID,
      name: 'After',
      product: { file: 'sequence.gb', topology: 'linear' },
      assembly: {
        accepted: {
          acceptedAssemblyVersionId: acceptedVersionId,
          artifacts: { primerCsvPath: csvPath, primerFastaPath: fastaPath },
        },
      },
      members: [csvPath, fastaPath].map((path) => ({
        id: `primer-export:${path}`,
        role: 'primer-export',
        path,
        replaceable: false,
        createdAt: '2026-09-29T00:00:00.000Z',
      })),
      existing: initial,
    });
    const request = {
      workspaceRoot: root,
      packageRoot,
      packageId: DOCUMENT_ID,
      nextDocument: next,
      nextProductContent: afterProduct,
      acceptedVersionId,
      expectedMarkerSha256: hash(beforeMarker),
      expectedProductSha256: hash(beforeProduct),
      primerAssets: [
        { path: csvPath, sha256: hash(csvContent), content: csvContent },
        { path: fastaPath, sha256: hash(fastaContent), content: fastaContent },
      ],
    };
    const result = await publishAcceptedAssemblyRevisionInMain(request);
    const current = parseSequencePackageDocument(await readFile(paths.metaPath, 'utf8'));
    expect(current.versionHistory.revisions.map((revision) => revision.kind)).toEqual([
      'adopted',
      'assembly-finalization',
    ]);
    expect(current.versionHistory.headId).toBe(result.revisionId);
    expect(await readFile(paths.productPath, 'utf8')).toBe(afterProduct);
    expect(await readFile(fromPackageRelative(csvPath, packageRoot), 'utf8')).toBe(csvContent);
    expect(await readFile(fromPackageRelative(fastaPath, packageRoot), 'utf8')).toBe(fastaContent);
    expect(
      await readFile(
        fromPackageRelative(current.versionHistory.revisions[0].productSnapshot.path, packageRoot),
        'utf8'
      )
    ).toBe(beforeProduct);
    expect(
      await readFile(
        fromPackageRelative(current.versionHistory.revisions[1].productSnapshot.path, packageRoot),
        'utf8'
      )
    ).toBe(afterProduct);
    expect((await publishAcceptedAssemblyRevisionInMain(request)).revisionId).toBe(
      result.revisionId
    );
    await expect(
      publishAcceptedAssemblyRevisionInMain({
        ...request,
        primerAssets: [
          { ...request.primerAssets[0], content: 'different' },
          request.primerAssets[1],
        ],
      })
    ).rejects.toThrow();
  });

  it('restores mixed historical items as one new head without erasing intervening versions', async () => {
    const packageRoot = join(root, 'mixed-restore');
    const paths = sequencePackagePaths(packageRoot, { productFile: 'sequence.gb' });
    await mkdir(paths.metaDir, { recursive: true });
    const hash = (content: string) =>
      `sha256:${createHash('sha256').update(content).digest('hex')}`;
    const oldProduct = serializeSequenceForInPlaceSave(sequence('AACC'), paths.productPath);
    const secondProduct = serializeSequenceForInPlaceSave(sequence('AATT'), paths.productPath);
    const first = buildSequencePackageDocument({
      id: DOCUMENT_ID,
      name: 'First',
      product: { file: 'sequence.gb', topology: 'linear' },
    });
    await writeFile(paths.metaPath, serializeSequencePackageDocument(first));
    await writeFile(paths.productPath, oldProduct);
    const second = buildSequencePackageDocument({
      id: DOCUMENT_ID,
      name: 'Second',
      product: { file: 'sequence.gb', topology: 'linear' },
      entity: { ...first.entity, fields: { description: 'from second' } },
      existing: first,
    });
    await publishSequencePackageRevisionInMain({
      workspaceRoot: root,
      packageRoot,
      packageId: DOCUMENT_ID,
      nextDocument: second,
      nextProductContent: secondProduct,
      kind: 'sequence-save',
      operationId: 'second',
      revisionId: 'second',
      adoptedRevisionId: 'first-adopted',
      expectedMarkerSha256: hash(serializeSequencePackageDocument(first)),
      expectedProductSha256: hash(oldProduct),
    });
    const secondMarker = await readFile(paths.metaPath, 'utf8');
    const third = buildSequencePackageDocument({
      id: DOCUMENT_ID,
      name: 'Third',
      product: { file: 'sequence.gb', topology: 'linear' },
      entity: { ...second.entity, fields: { description: 'from third' } },
      existing: parseSequencePackageDocument(secondMarker),
    });
    await publishSequencePackageRevisionInMain({
      workspaceRoot: root,
      packageRoot,
      packageId: DOCUMENT_ID,
      nextDocument: third,
      nextProductContent: secondProduct,
      kind: 'metadata-update',
      operationId: 'third',
      revisionId: 'third',
      expectedMarkerSha256: hash(secondMarker),
      expectedProductSha256: hash(secondProduct),
    });
    const beforePreview = await readFile(paths.metaPath, 'utf8');
    const request = {
      workspaceRoot: root,
      packageRoot,
      packageId: DOCUMENT_ID,
      selections: [
        { itemId: 'product', revisionId: 'first-adopted' },
        { itemId: 'name', revisionId: 'third' },
        { itemId: 'field:description', revisionId: 'second' },
      ],
    };
    const preview = await previewSequenceRestoreInMain(request);
    expect(preview.blockers).toEqual([]);
    expect(preview.changedItems).toEqual(['field:description', 'product']);
    expect(await readFile(paths.metaPath, 'utf8')).toBe(beforePreview);
    expect(await readFile(paths.productPath, 'utf8')).toBe(secondProduct);
    const applyRequest = {
      ...request,
      operationId: 'restore-mixed',
      previewFingerprint: preview.previewFingerprint,
    };
    const restored = await applySequenceRestoreInMain(applyRequest);
    expect(restored.alreadyPublished).toBe(false);
    const current = parseSequencePackageDocument(await readFile(paths.metaPath, 'utf8'));
    expect(await readFile(paths.productPath, 'utf8')).toBe(oldProduct);
    expect(current.name).toBe('Third');
    expect(current.entity.fields.description).toBe('from second');
    expect(current.versionHistory.revisions.map((revision) => revision.id)).toEqual([
      'first-adopted',
      'second',
      'third',
      'restore:restore-mixed',
    ]);
    expect(current.versionHistory.revisions[3].parentId).toBe('third');
    expect(current.versionHistory.revisions[3].sources).toMatchObject({
      product: { revisionId: 'first-adopted', valueSha256: hash(oldProduct) },
      name: { revisionId: 'third' },
      'field:description': { revisionId: 'second' },
    });
    expect((await applySequenceRestoreInMain(applyRequest)).alreadyPublished).toBe(true);
    const copyRoot = join(root, 'mixed-restore-copy');
    await cp(packageRoot, copyRoot, { recursive: true });
    const copied = parseSequencePackageDocument(
      await readFile(sequencePackagePaths(copyRoot).metaPath, 'utf8')
    );
    for (const revision of copied.versionHistory.revisions) {
      expect(
        await readFile(fromPackageRelative(revision.productSnapshot.path, copyRoot), 'utf8')
      ).toBeTruthy();
    }
    await expect(
      applySequenceRestoreInMain({
        ...applyRequest,
        selections: [{ itemId: 'name', revisionId: 'first-adopted' }],
      })
    ).rejects.toThrow(/different preview/);
  });

  it.each(['finish', 'roll-back'] as const)(
    'recovers a crash between product and marker by %s from package snapshots',
    async (direction) => {
      const packageRoot = join(root, `crash-${direction}`);
      const paths = sequencePackagePaths(packageRoot, { productFile: 'sequence.gb' });
      await mkdir(paths.metaDir, { recursive: true });
      const beforeProduct = serializeSequenceForInPlaceSave(sequence('AACC'), paths.productPath);
      const afterProduct = serializeSequenceForInPlaceSave(sequence('AATT'), paths.productPath);
      const initial = buildSequencePackageDocument({
        id: DOCUMENT_ID,
        name: 'Before',
        product: { file: 'sequence.gb', topology: 'linear' },
      });
      const beforeMarker = serializeSequencePackageDocument(initial);
      const prepared = await prepareSequencePackageRevision({
        current: initial,
        currentProductContent: beforeProduct,
        next: { ...initial, name: 'After' },
        nextProductContent: afterProduct,
        kind: 'sequence-save',
        operationId: `crash-${direction}`,
        revisionId: `crash-${direction}`,
        adoptedRevisionId: `adopted-${direction}`,
      });
      const afterMarker = serializeSequencePackageDocument(prepared.document);
      await writeFile(paths.metaPath, beforeMarker);
      await writeFile(paths.productPath, afterProduct);
      for (const snapshot of prepared.snapshots) {
        const path = fromPackageRelative(snapshot.path, packageRoot);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, snapshot.content);
      }
      const beforeSnapshot = prepared.document.versionHistory.revisions[0].productSnapshot.path;
      const hash = (content: string) =>
        `sha256:${createHash('sha256').update(content).digest('hex')}`;
      await writeFile(
        join(paths.metaDir, 'sequence-revision-publication.json'),
        JSON.stringify({
          schema: 'waypoint.sequence-revision-publication.v1',
          state: 'pending',
          packageId: DOCUMENT_ID,
          operationId: `crash-${direction}`,
          beforeMarkerSha256: hash(beforeMarker),
          beforeProductSha256: hash(beforeProduct),
          beforeMarkerContent: beforeMarker,
          beforeProductSnapshotPath: beforeSnapshot,
          afterMarkerSha256: hash(afterMarker),
          afterProductSha256: hash(afterProduct),
          nextMarkerContent: afterMarker,
          nextProductSnapshotPath: prepared.revision.productSnapshot.path,
        })
      );
      if (direction === 'roll-back') {
        await writeFile(
          fromPackageRelative(prepared.revision.productSnapshot.path, packageRoot),
          'damaged snapshot'
        );
      }
      await recoverSequencePackageRevisionPublicationInMain(root, packageRoot);
      await recoverSequencePackageRevisionPublicationInMain(root, packageRoot);
      expect(await readFile(paths.productPath, 'utf8')).toBe(
        direction === 'finish' ? afterProduct : beforeProduct
      );
      expect(await readFile(paths.metaPath, 'utf8')).toBe(
        direction === 'finish' ? afterMarker : beforeMarker
      );
      const journal = JSON.parse(
        await readFile(join(paths.metaDir, 'sequence-revision-publication.json'), 'utf8')
      ) as { state: string };
      expect(journal.state).toBe(direction === 'finish' ? 'complete' : 'aborted');
    }
  );
});
