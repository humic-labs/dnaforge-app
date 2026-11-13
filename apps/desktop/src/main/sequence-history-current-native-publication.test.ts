import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { serializeGenBank } from '@waypoint/sequence-utils';
import { defineBlob, parseResourceId, listWorkspaceResources } from '@waypoint/workspace-revisions';
import {
  buildPrimerArtifact,
  parsePrimerArtifact,
  revisePrimerArtifactContent,
  serializePrimerArtifact,
} from '../features/primers/public/primer-artifact';
import { scientificSequencePackageResourceId } from './scientific-sequence-package';
import { recordCatalogEventInDb } from './catalog-association-commands';
import { bindCatalogEntityFileInDb } from './catalog-file-binding';
import { rebindCatalogFilesInDb, setCatalogFileStateInDb } from './catalog-projection-commands';
import type { CatalogFileBindingRow } from '../shared/catalog-binding';
import type { SequenceDocumentSnapshot } from '../shared/sequence-document';
import { parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import { SEQUENCE_SAVE_PRIMER_PUBLICATION_EVENT_TYPE } from '../shared/sequence-edit-lineage';
import {
  MANAGED_WORKSPACE_MARKER,
  BENCHLING_MIGRATION_WORKSPACE_MARKER,
} from '../shared/workspace-git-types';
import { createFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { createNativeSequenceWorkingCopies } from './native-sequence-working-copies';
import { NativeDocumentWorkspaces } from './native-document-workspaces';
import { ScientificObjectStore } from './scientific-object-store';
import { submitScientificWorkspace } from './scientific-workspace-service';
import { commitSequenceDocumentHistory } from './sequence-document-history';
import { assertCommittedDatabaseReadAllowed } from './workspace-sync-database-fence';
import { initManagedRepo, commitAllIfDirty, resolveHeadCommit } from './workspace-git';
import { executeManagedGit } from './workspace-git/native';
import {
  buildSequencePackageDocument,
  parseSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
} from '../db/sequence-package';
import type { SequenceDocumentHistoryInput } from '../shared/sequence-edit-lineage';
vi.mock('electron', () => ({
  app: { getPath: vi.fn(), getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
  shell: { trashItem: async (path: string) => rm(path, { recursive: true }) },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('./scientific-migration-recovery', () => ({
  ensureScientificEnrollmentCheckpoint: vi.fn(async () => {}),
}));
let database: ReturnType<typeof createFileTestDb>['db'] | undefined;
vi.mock('./ipc/database', () => ({
  getDb: () => {
    if (!database) throw new Error('The test database is not bound.');
    return database;
  },
}));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const inspect = {
  kind: 'inspect' as const,
  start: 0,
  limit: 1000,
  annotationOffset: 0,
  annotationLimit: 50,
};

async function publicationFixture(kind: 'legacy' | 'accepted', fileLocator = false) {
  const f = createFileTestDb('current-native-history');
  database = f.db;
  cleanups.push(f.cleanup);
  ensureSchema(f.db, f.dbPath);
  let root = join(f.tmpDir, 'project');
  await mkdir(root);
  root = await realpath(root);
  const documentId = 'history-current-document';
  const packageName = 'History proof';
  const packageRoot = join(root, packageName),
    paths = sequencePackagePaths(packageRoot, { productFile: 'sequence.gb' });
  const sourcePath = kind === 'accepted' ? paths.productPath : join(root, 'sequence.gb');
  const original = serializeGenBank({
    id: documentId,
    name: packageName,
    sequence: 'AACC',
    length: 4,
    circular: false,
    annotations: [],
  });
  const workspaceId = Number(
    f.db
      .prepare('INSERT INTO workspaces(name,path,repo_uuid,created_at) VALUES(?,?,?,1)')
      .run('History proof', root, 'history-current-proof').lastInsertRowid
  );
  f.db
    .prepare(
      "INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at) VALUES(?,'sequence','History proof',?,'file',?,1,1)"
    )
    .run(
      documentId,
      kind === 'accepted' ? packageRoot : fileLocator ? `file://${sourcePath}` : sourcePath,
      workspaceId
    );
  f.db
    .prepare(
      'INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,created_at,updated_at) VALUES(?,?,?,?,?,1,1)'
    )
    .run(
      'history-current-file',
      documentId,
      workspaceId,
      kind === 'accepted' ? packageRoot : sourcePath,
      kind === 'accepted' ? 'waypoint-sequence' : 'genbank'
    );
  if (kind === 'accepted') {
    const store = new ScientificObjectStore(f.db, workspaceId);
    await submitScientificWorkspace({
      db: f.db,
      workspaceId,
      request: {
        operationId: 'history-enroll-seed',
        expectedHead: null,
        source: {
          kind: 'documents',
          entries: [
            {
              resourceId: 'history-seed',
              path: 'seed.gb',
              representation: { format: 'genbank-v1', text: original },
            },
          ],
        },
      },
    });
    const marker = serializeSequencePackageDocument(
      buildSequencePackageDocument({
        id: documentId,
        name: packageName,
        product: {
          file: 'sequence.gb',
          topology: 'linear',
          genBankChecksum: defineBlob(new TextEncoder().encode(original)).hash,
        },
      })
    );
    await submitScientificWorkspace({
      db: f.db,
      workspaceId,
      request: {
        operationId: 'history-enroll-package',
        expectedHead: store.read().head,
        source: {
          kind: 'native-artifact',
          expectedRevisionId: null,
          entry: {
            resourceId: documentId,
            path: `${packageName}/sequence.gb`,
            representation: { format: 'genbank-v1', text: original },
            sequencePackageText: marker,
          },
        },
      },
    });
  } else await writeFile(sourcePath, original);
  await initManagedRepo(root);
  await commitAllIfDirty(root, 'baseline');
  const workspaces = new NativeDocumentWorkspaces({ resolveRoot: async (path) => path });
  await workspaces.replaceRoots([root], () => true);
  const create = async () => {
    const owner = createNativeSequenceWorkingCopies({
      db: () => f.db,
      workspaceRoots: () => workspaces.readableRoots(),
      writableWorkspaceRoots: () => workspaces.roots(),
      profileDirectory: () => join(f.tmpDir, 'profile'),
      captureWorkspace: (path, mutating) =>
        mutating ? workspaces.capture(path) : workspaces.captureReadable(path),
    });
    await owner.completeLegacyMigration([]);
    cleanups.push(() => owner.close());
    return owner;
  };
  return { ...f, root, workspaceId, documentId, packageRoot, paths, sourcePath, original, create };
}

it.each(['legacy', 'accepted'] as const)(
  'retains %s native-capture acknowledgement through a real index lock and owner reopen; retries only the intended History commit',
  async (kind) => {
    const f = await publicationFixture(kind),
      owner = await f.create();
    let state = await owner.execute({
      documentId: f.documentId,
      operation: inspect,
      projection: 'document',
    });
    state = await owner.execute({
      documentId: f.documentId,
      expectedVersion: state.version,
      operation: { kind: 'replace-bases', start: 2, end: 2, bases: 'TT', expectedBases: '' },
      projection: 'document',
    });
    await writeFile(join(f.root, 'unrelated.txt'), 'Unrelated staged work');
    await executeManagedGit(f.root, ['add', '--', 'unrelated.txt']);
    const index = await readFile(join(f.root, '.git', 'index')),
      head = await resolveHeadCommit(f.root);
    const lock = join(f.root, '.git', 'index.lock');
    await writeFile(lock, '', { flag: 'wx' });
    const captured = await owner.execute({
      documentId: f.documentId,
      expectedVersion: state.version,
      operation: { kind: 'capture-save', message: 'Save intended current revision' },
      projection: 'document',
    });
    if (!captured.captureId) throw new Error('The native immutable Save capture is missing.');
    const saved = await owner.execute({
      documentId: f.documentId,
      expectedVersion: captured.version,
      operation: { kind: 'publish-save', captureId: captured.captureId },
      projection: 'document',
    });
    expect(saved).toMatchObject({ saved: true, dirty: false, history: { status: 'failed' } });
    if (saved.saveResult?.status !== 'saved' || !saved.saveResult.writeReceipt)
      throw new Error('The current native producer omitted its acknowledged receipt.');
    const receipt = saved.saveResult.writeReceipt,
      bytes = await readFile(f.sourcePath);
    expect(bytes.toString()).not.toBe(f.original);
    expect(receipt.contentSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await resolveHeadCommit(f.root)).toBe(head);
    expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index);
    const acceptedHead =
      kind === 'accepted' ? new ScientificObjectStore(f.db, f.workspaceId).read().head : null;
    const events = f.db
      .prepare(
        "SELECT id FROM catalog_entity_events WHERE entity_id=? AND event_type='sequence_edit_transition_v1' ORDER BY id"
      )
      .all(f.documentId);
    await owner.close();
    const reopened = await f.create();
    const snapshot = await reopened.execute({
      documentId: f.documentId,
      operation: inspect,
      projection: 'document',
    });
    expect(snapshot.dirty).toBe(false);
    expect(snapshot.copy?.savedSequence?.sequence).toBe('AATTCC');
    expect(await readFile(f.sourcePath)).toEqual(bytes);
    const input: SequenceDocumentHistoryInput = {
      documentId: f.documentId,
      sourcePath: f.sourcePath,
      message: 'Save intended current revision',
      ...receipt,
    };
    await rm(lock);
    expect(
      (
        await commitSequenceDocumentHistory(input, {
          db: f.db,
          resolve: async () => ({
            documentId: f.documentId,
            workspaceRoot: f.root,
            sourcePath: f.sourcePath,
          }),
        })
      ).status
    ).toBe('committed');
    const committed = await resolveHeadCommit(f.root);
    expect(committed).not.toBe(head);
    expect(
      (await executeManagedGit(f.root, ['rev-list', '--count', `${head}..${committed}`])).trim()
    ).toBe('1');
    expect(
      (
        await commitSequenceDocumentHistory(input, {
          db: f.db,
          resolve: async () => ({
            documentId: f.documentId,
            workspaceRoot: f.root,
            sourcePath: f.sourcePath,
          }),
        })
      ).status
    ).toBe('already-committed');
    expect(await resolveHeadCommit(f.root)).toBe(committed);
    expect(await readFile(f.sourcePath)).toEqual(bytes);
    expect(
      f.db
        .prepare(
          "SELECT id FROM catalog_entity_events WHERE entity_id=? AND event_type='sequence_edit_transition_v1' ORDER BY id"
        )
        .all(f.documentId)
    ).toEqual(events);
    expect(await executeManagedGit(f.root, ['diff', '--cached', '--name-only'])).toContain(
      'unrelated.txt'
    );
    await expect(executeManagedGit(f.root, ['show', 'HEAD:unrelated.txt'])).rejects.toThrow();
    for (const path of saved.saveResult.publicationPaths ?? ['sequence.gb'])
      expect(await executeManagedGit(f.root, ['show', `HEAD:${path}`])).toBe(
        await readFile(join(f.root, path), 'utf8')
      );
    if (kind === 'accepted') {
      expect(new ScientificObjectStore(f.db, f.workspaceId).read().head).toBe(acceptedHead);
      expect(receipt.accepted?.resourceId).toBe(f.documentId);
      expect(receipt.accepted?.resourceRevisionId).toBe(
        saved.saveResult.accepted?.resourceRevisionId
      );
    }
  }
);

it('refuses an accepted package marker that changes after its native Save without advancing Git or rewriting acknowledged bytes', async () => {
  const f = await publicationFixture('accepted'),
    owner = await f.create();
  let state = await owner.execute({
    documentId: f.documentId,
    operation: inspect,
    projection: 'document',
  });
  state = await owner.execute({
    documentId: f.documentId,
    expectedVersion: state.version,
    operation: { kind: 'replace-bases', start: 2, end: 2, bases: 'TT', expectedBases: '' },
    projection: 'document',
  });
  const lock = join(f.root, '.git', 'index.lock');
  await writeFile(lock, '', { flag: 'wx' });
  const capture = await owner.execute({
    documentId: f.documentId,
    expectedVersion: state.version,
    operation: { kind: 'capture-save', message: 'Save exact package revision' },
    projection: 'document',
  });
  if (!capture.captureId) throw new Error('A native Save capture is required.');
  const saved = await owner.execute({
    documentId: f.documentId,
    expectedVersion: capture.version,
    operation: { kind: 'publish-save', captureId: capture.captureId },
    projection: 'document',
  });
  if (saved.saveResult?.status !== 'saved' || !saved.saveResult.writeReceipt)
    throw new Error('A native acknowledgement is required.');
  await rm(lock);
  const head = await resolveHeadCommit(f.root),
    index = await readFile(join(f.root, '.git', 'index')),
    bytes = await readFile(f.sourcePath),
    marker = await readFile(f.paths.metaPath, 'utf8');
  await writeFile(f.paths.metaPath, marker + '\n');
  const input: SequenceDocumentHistoryInput = {
    ...saved.saveResult.writeReceipt,
    documentId: f.documentId,
    sourcePath: f.sourcePath,
    message: 'Save exact package revision',
  };
  expect(
    (
      await commitSequenceDocumentHistory(input, {
        db: f.db,
        resolve: async () => ({
          documentId: f.documentId,
          workspaceRoot: f.root,
          sourcePath: f.sourcePath,
        }),
      })
    ).status
  ).toBe('revision-changed');
  expect(await resolveHeadCommit(f.root)).toBe(head);
  expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index);
  expect(await readFile(f.sourcePath)).toEqual(bytes);
  expect(await readFile(f.paths.metaPath, 'utf8')).toBe(marker + '\n');
  expect(owner.model.getState().isDirty(f.documentId)).toBe(false);
});

it.each(['project access', 'shared role', 'document lifecycle', 'binding identity'] as const)(
  'rejects a changed %s snapshot inside accepted Save and rolls back without replacing the committed authority proof',
  async (change) => {
    const f = await publicationFixture('accepted'),
      owner = await f.create();
    let state = await owner.execute({
      documentId: f.documentId,
      operation: inspect,
      projection: 'document',
    });
    state = await owner.execute({
      documentId: f.documentId,
      expectedVersion: state.version,
      operation: { kind: 'replace-bases', start: 2, end: 2, bases: 'TT', expectedBases: '' },
      projection: 'document',
    });
    const head = await resolveHeadCommit(f.root),
      index = await readFile(join(f.root, '.git', 'index')),
      bytes = await readFile(f.sourcePath),
      marker = await readFile(f.paths.metaPath),
      acceptedHead = new ScientificObjectStore(f.db, f.workspaceId).read().head,
      events = f.db
        .prepare(
          "SELECT id FROM catalog_entity_events WHERE entity_id=? AND event_type='sequence_edit_transition_v1' ORDER BY id"
        )
        .all(f.documentId);
    const submit = ScientificObjectStore.prototype.submit;
    const transaction = vi
      .spyOn(ScientificObjectStore.prototype, 'submit')
      .mockImplementation(function (this: ScientificObjectStore, input, onAcceptedInsideTx) {
        return submit.call(this, input, () => {
          expect(f.db.inTransaction).toBe(true);
          expect(() => assertCommittedDatabaseReadAllowed(f.db)).toThrow(
            'DATABASE_UNCOMMITTED_AUTHORITY_READ'
          );
          if (change === 'project access')
            f.db
              .prepare("UPDATE workspaces SET access_mode='reference' WHERE id=?")
              .run(f.workspaceId);
          if (change === 'shared role')
            f.db
              .prepare(
                "INSERT INTO workspace_sync_bindings(workspace_id,workspace_uuid,access_role,enabled,owner_account_id,created_at,updated_at) VALUES (?,?,'viewer',1,'test-account',1,1)"
              )
              .run(f.workspaceId, 'history-current-proof');
          if (change === 'document lifecycle')
            f.db
              .prepare("UPDATE catalog_entities SET status='archived' WHERE id=?")
              .run(f.documentId);
          if (change === 'binding identity')
            f.db
              .prepare("UPDATE catalog_entity_files SET file_kind='genbank' WHERE entity_id=?")
              .run(f.documentId);
          return onAcceptedInsideTx?.();
        });
      });
    try {
      const capture = await owner.execute({
        documentId: f.documentId,
        expectedVersion: state.version,
        operation: { kind: 'capture-save', message: 'Reject changed captured authority' },
        projection: 'document',
      });
      if (!capture.captureId) throw new Error('A native Save capture is required.');
      await expect(
        owner.execute({
          documentId: f.documentId,
          expectedVersion: capture.version,
          operation: { kind: 'publish-save', captureId: capture.captureId },
          projection: 'document',
        })
      ).rejects.toMatchObject({
        code: 'SEQUENCE_SAVE_FAILED',
        message: expect.stringContaining(
          change === 'binding identity'
            ? 'The sequence owner changed during the native command.'
            : 'The captured sequence write authority changed before acceptance.'
        ),
      });
      expect(transaction).toHaveBeenCalledOnce();
      expect(f.db.inTransaction).toBe(false);
      expect(() => assertCommittedDatabaseReadAllowed(f.db)).not.toThrow();
      expect(new ScientificObjectStore(f.db, f.workspaceId).read().head).toBe(acceptedHead);
      expect(await resolveHeadCommit(f.root)).toBe(head);
      expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index);
      expect(await readFile(f.sourcePath)).toEqual(bytes);
      expect(await readFile(f.paths.metaPath)).toEqual(marker);
      expect(owner.model.getState().isDirty(f.documentId)).toBe(true);
      expect(
        f.db
          .prepare(
            "SELECT id FROM catalog_entity_events WHERE entity_id=? AND event_type='sequence_edit_transition_v1' ORDER BY id"
          )
          .all(f.documentId)
      ).toEqual(events);
      expect(
        f.db.prepare('SELECT access_mode FROM workspaces WHERE id=?').get(f.workspaceId)
      ).toEqual({ access_mode: 'writable' });
      expect(
        f.db
          .prepare('SELECT workspace_id FROM workspace_sync_bindings WHERE workspace_id=?')
          .get(f.workspaceId)
      ).toBeUndefined();
      expect(
        f.db.prepare('SELECT status FROM catalog_entities WHERE id=?').get(f.documentId)
      ).toEqual({ status: 'active' });
      expect(
        f.db
          .prepare('SELECT file_kind FROM catalog_entity_files WHERE entity_id=?')
          .get(f.documentId)
      ).toEqual({ file_kind: 'waypoint-sequence' });
    } finally {
      transaction.mockRestore();
    }
  }
);

const copiedPrimerBases = 'ACGTACGTACGTACGTACGT';

async function capturedAcceptedPrimerFixture(count = 1) {
  const f = await publicationFixture('accepted');
  await expect(readFile(join(f.root, MANAGED_WORKSPACE_MARKER))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(readFile(join(f.root, BENCHLING_MIGRATION_WORKSPACE_MARKER))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  const primers: Array<{ id: string; path: string }> = [];
  for (let index = 0; index < count; index += 1) {
    const id = `550e8400-e29b-41d4-a716-44665544${1000 + index}`;
    const path = `primers/${id}.primer.json`;
    const artifact = await buildPrimerArtifact({
      id,
      catalogNumber: `PR-${String(100 + index).padStart(6, '0')}`,
      name: `Copied primer ${index + 1}`,
      sequence: copiedPrimerBases,
      workspaceRoot: f.root,
      artifactPath: join(f.root, path),
      source: 'manual',
    });
    await submitScientificWorkspace({
      db: f.db,
      workspaceId: f.workspaceId,
      request: {
        operationId: `seed-copied-primer-${index}`,
        expectedHead: new ScientificObjectStore(f.db, f.workspaceId).read().head,
        source: {
          kind: 'native-artifact',
          expectedRevisionId: null,
          entry: {
            resourceId: id,
            path,
            representation: { format: 'primer-v2', text: serializePrimerArtifact(artifact) },
          },
        },
      },
    });
    primers.push({ id, path });
  }
  await commitAllIfDirty(f.root, 'Seed actual accepted primers');
  const owner = await f.create();
  let state = await owner.execute({
    documentId: f.documentId,
    operation: inspect,
    projection: 'document',
  });
  state = await owner.execute({
    documentId: f.documentId,
    expectedVersion: state.version,
    operation: {
      kind: 'client-command',
      command: { method: 'dispatchEdit', action: { type: 'SET_CURSOR', position: 2 } },
    },
    projection: 'document',
  });
  state = await owner.execute({
    documentId: f.documentId,
    expectedVersion: state.version,
    operation: {
      kind: 'client-command',
      command: {
        method: 'dispatchEdit',
        action: {
          type: 'INSERT_FRAGMENT',
          fragment: {
            sequence: copiedPrimerBases,
            annotations: [],
            primerBindings: primers.map((primer) => ({
              primerId: primer.id,
              start: 0,
              end: copiedPrimerBases.length,
              strand: 1,
              sourceWorkspaceRoot: f.root,
            })),
          },
        },
      },
    },
    projection: 'document',
  });
  expect(state.copy?.sequence?.sequence).toBe(`AA${copiedPrimerBases}CC`);
  await mkdir(join(f.root, '.waypoint/lims'), { recursive: true });
  await writeFile(join(f.root, 'unrelated.txt'), 'Keep this staged');
  await writeFile(join(f.root, '.waypoint/lims/unrelated.json'), '{"unrelated":true}');
  await executeManagedGit(f.root, ['add', '--', 'unrelated.txt', '.waypoint/lims/unrelated.json']);
  const index = await readFile(join(f.root, '.git', 'index'));
  const head = await resolveHeadCommit(f.root);
  const lock = join(f.root, '.git', 'index.lock');
  await writeFile(lock, '', { flag: 'wx' });
  const capture = await owner.execute({
    documentId: f.documentId,
    expectedVersion: state.version,
    operation: { kind: 'capture-save', message: 'Save sequence with its copied primers' },
    projection: 'document',
  });
  if (!capture.captureId) throw new Error('The immutable native capture is missing.');
  const saved = await owner.execute({
    documentId: f.documentId,
    expectedVersion: capture.version,
    operation: { kind: 'publish-save', captureId: capture.captureId },
    projection: 'document',
  });
  expect(saved).toMatchObject({ saved: true, dirty: false, history: { status: 'failed' } });
  expect(saved.primerBindingFailure).toBeUndefined();
  if (saved.saveResult?.status !== 'saved' || !saved.saveResult.writeReceipt)
    throw new Error('The native acknowledgement is missing.');
  const receipt = saved.saveResult.writeReceipt;
  expect(receipt.primerPublicationIds).toHaveLength(count);
  const bytes = await readFile(f.sourcePath);
  expect(receipt.contentSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(await resolveHeadCommit(f.root)).toBe(head);
  expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index);
  const events = f.db
    .prepare(
      "SELECT id FROM catalog_entity_events WHERE entity_id=? AND event_type='sequence_edit_transition_v1' ORDER BY id"
    )
    .all(f.documentId);
  expect(events).toHaveLength(1);
  const publications = f.db
    .prepare<
      [string, string],
      { payload: string }
    >('SELECT payload FROM catalog_entity_events WHERE entity_id=? AND event_type=?')
    .all(f.documentId, SEQUENCE_SAVE_PRIMER_PUBLICATION_EVENT_TYPE);
  expect(publications).toHaveLength(count);
  for (const publication of publications)
    expect(JSON.parse(publication.payload)).toMatchObject({
      nativeActionId: receipt.nativeActionId,
      saveEventId: receipt.revisionId,
      saveContentSha256: receipt.contentSha256,
      gitStatus: 'failed',
    });
  for (const primer of primers) {
    const actual = parsePrimerArtifact(await readFile(join(f.root, primer.path), 'utf8'));
    expect(actual.bindings).toHaveLength(1);
    expect(actual.bindings[0]).toMatchObject({
      target: { documentId: f.documentId, fileContentHash: `sha256:${receipt.contentSha256}` },
      coordinates: { start: 2, end: 22, strand: 1 },
    });
  }
  const input: SequenceDocumentHistoryInput = {
    ...receipt,
    documentId: f.documentId,
    sourcePath: f.sourcePath,
    message: 'Save sequence with its copied primers',
  };
  const dependencies = {
    db: f.db,
    resolve: async () => ({
      documentId: f.documentId,
      workspaceRoot: f.root,
      sourcePath: f.sourcePath,
    }),
  };
  return {
    ...f,
    owner,
    primers,
    saved,
    receipt,
    bytes,
    index,
    head,
    lock,
    events,
    input,
    dependencies,
  };
}

it.each([1, 2])(
  'retains %s actual accepted copied-primer publication(s) through a real lock and owner reopen, then commits the captured closure once',
  async (count) => {
    const f = await capturedAcceptedPrimerFixture(count);
    const terminal = new ScientificObjectStore(f.db, f.workspaceId).read();
    await f.owner.close();
    const reopened = await f.create();
    const snapshot = await reopened.execute({
      documentId: f.documentId,
      operation: inspect,
      projection: 'document',
    });
    expect(snapshot.dirty).toBe(false);
    expect(snapshot.copy?.savedSequence?.sequence).toBe(`AA${copiedPrimerBases}CC`);
    expect(await readFile(f.sourcePath)).toEqual(f.bytes);
    await rm(f.lock);
    expect((await commitSequenceDocumentHistory(f.input, f.dependencies)).status).toBe('committed');
    const committed = await resolveHeadCommit(f.root);
    expect(
      (await executeManagedGit(f.root, ['rev-list', '--count', `${f.head}..${committed}`])).trim()
    ).toBe('1');
    expect((await commitSequenceDocumentHistory(f.input, f.dependencies)).status).toBe(
      'already-committed'
    );
    expect(await resolveHeadCommit(f.root)).toBe(committed);
    expect(new ScientificObjectStore(f.db, f.workspaceId).read().head).toBe(terminal.head);
    expect(await readFile(f.sourcePath)).toEqual(f.bytes);
    expect(
      f.db
        .prepare(
          "SELECT id FROM catalog_entity_events WHERE entity_id=? AND event_type='sequence_edit_transition_v1' ORDER BY id"
        )
        .all(f.documentId)
    ).toEqual(f.events);
    const staged = await executeManagedGit(f.root, ['diff', '--cached', '--name-only']);
    expect(staged).toContain('unrelated.txt');
    expect(staged).toContain('.waypoint/lims/unrelated.json');
    await expect(executeManagedGit(f.root, ['show', 'HEAD:unrelated.txt'])).rejects.toThrow();
    await expect(
      executeManagedGit(f.root, ['show', 'HEAD:.waypoint/lims/unrelated.json'])
    ).rejects.toThrow();
    for (const primer of f.primers)
      expect(await executeManagedGit(f.root, ['show', `HEAD:${primer.path}`])).toBe(
        await readFile(join(f.root, primer.path), 'utf8')
      );
    if (!terminal.head) throw new Error('The accepted primer closure is missing.');
    const slots = listWorkspaceResources(terminal.graph, terminal.head);
    if (!slots.ok) throw new Error('The accepted primer namespace is missing.');
    const bindings = slots.value.filter(
      (slot) =>
        slot.path && terminal.reader.current(slot.resourceId)?.document.kind === 'primer-binding'
    );
    expect(bindings).toHaveLength(count);
    for (const slot of bindings) {
      if (!slot.path) throw new Error('A live primer binding needs its native path.');
      expect(terminal.reader.current(slot.resourceId)?.document).toMatchObject({
        kind: 'primer-binding',
        target: { resourceId: f.documentId, revisionId: f.receipt.accepted?.resourceRevisionId },
      });
      expect(await executeManagedGit(f.root, ['show', `HEAD:${slot.path}`])).toBe(
        await readFile(join(f.root, slot.path), 'utf8')
      );
    }
  }
);

it.each([
  'unrelated primer',
  'unrelated metadata',
  'different native Save',
  'missing native publication',
  'reordered publications',
] as const)(
  'refuses %s when retrying an accepted copied-primer Save without changing Git or acknowledged bytes',
  async (change) => {
    const f = await capturedAcceptedPrimerFixture(change === 'reordered publications' ? 2 : 1);
    await rm(f.lock);
    const originalPrimerBytes = await readFile(join(f.root, f.primers[0].path), 'utf8');
    let input = f.input;
    if (change === 'unrelated primer') {
      const before = new ScientificObjectStore(f.db, f.workspaceId).read();
      const id = parseResourceId(f.primers[0].id);
      if (!id.ok) throw new Error('The fixture primer identity is invalid.');
      const current = before.reader.current(id.value);
      if (!current) throw new Error('The accepted primer is missing.');
      const next = await revisePrimerArtifactContent(parsePrimerArtifact(originalPrimerBytes), {
        name: 'Independent later primer change',
        sequence: copiedPrimerBases,
      });
      await submitScientificWorkspace({
        db: f.db,
        workspaceId: f.workspaceId,
        request: {
          operationId: 'independent-primer-after-save',
          expectedHead: before.head,
          source: {
            kind: 'native-artifact',
            expectedRevisionId: current.revisionId,
            entry: {
              resourceId: f.primers[0].id,
              path: f.primers[0].path,
              representation: { format: 'primer-v2', text: serializePrimerArtifact(next) },
            },
          },
        },
      });
    }
    if (change === 'unrelated metadata') {
      const before = new ScientificObjectStore(f.db, f.workspaceId).read();
      const id = parseResourceId(f.documentId);
      if (!id.ok) throw new Error('The fixture sequence identity is invalid.');
      const sequence = before.reader.current(id.value);
      const resources = before.head && listWorkspaceResources(before.graph, before.head);
      const marker =
        resources &&
        resources.ok &&
        resources.value.find(
          (slot) =>
            slot.resourceId === scientificSequencePackageResourceId(f.documentId) && !slot.tombstone
        );
      if (!sequence || !marker) throw new Error('The accepted package is missing.');
      const content = parseSequencePackageDocument(await readFile(f.paths.metaPath, 'utf8'));
      content.updatedAt = '2026-11-04T21:00:00.000Z';
      content.entity.fields = { ...content.entity.fields, notes: 'Independent later metadata' };
      await submitScientificWorkspace({
        db: f.db,
        workspaceId: f.workspaceId,
        request: {
          operationId: 'independent-metadata-after-save',
          expectedHead: before.head,
          source: {
            kind: 'sequence-metadata',
            resourceId: f.documentId,
            expectedRevisionId: sequence.revisionId,
            expectedPackageRevisionId: marker.revisionId,
            metadataText: serializeSequencePackageDocument(content),
          },
        },
      });
    }
    if (change === 'different native Save')
      input = { ...input, nativeActionId: '550e8400-e29b-41d4-a716-446655440099' };
    if (change === 'missing native publication')
      input = {
        ...input,
        primerPublicationIds: ['sequence-primer-publication:550e8400-e29b-41d4-a716-446655440099'],
      };
    if (change === 'reordered publications')
      input = { ...input, primerPublicationIds: [...(input.primerPublicationIds ?? [])].reverse() };
    const head = await resolveHeadCommit(f.root),
      index = await readFile(join(f.root, '.git', 'index'));
    const marker = await readFile(f.paths.metaPath),
      primer = await readFile(join(f.root, f.primers[0].path));
    const acceptedHead = new ScientificObjectStore(f.db, f.workspaceId).read().head;
    expect((await commitSequenceDocumentHistory(input, f.dependencies)).status).toBe(
      'revision-changed'
    );
    expect(await resolveHeadCommit(f.root)).toBe(head);
    expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index);
    expect(await readFile(f.sourcePath)).toEqual(f.bytes);
    expect(await readFile(f.paths.metaPath)).toEqual(marker);
    expect(await readFile(join(f.root, f.primers[0].path))).toEqual(primer);
    expect(new ScientificObjectStore(f.db, f.workspaceId).read().head).toBe(acceptedHead);
    expect(
      f.db
        .prepare(
          "SELECT id FROM catalog_entity_events WHERE entity_id=? AND event_type='sequence_edit_transition_v1' ORDER BY id"
        )
        .all(f.documentId)
    ).toEqual(f.events);
  }
);

it('refuses a caller-authored catalog event in the native copied-primer publication namespace', async () => {
  const f = await publicationFixture('accepted');
  const before = f.db.prepare('SELECT id FROM catalog_entity_events ORDER BY id').all();
  expect(() =>
    recordCatalogEventInDb(f.db, {
      entityId: f.documentId,
      eventType: SEQUENCE_SAVE_PRIMER_PUBLICATION_EVENT_TYPE,
      actor: 'system',
      payload: { nativeActionId: 'caller-value' },
    })
  ).toThrow('SEQUENCE_SAVE_HISTORY_PROTECTED');
  expect(f.db.prepare('SELECT id FROM catalog_entity_events ORDER BY id').all()).toEqual(before);
});

function recoveryPrecondition(snapshot: SequenceDocumentSnapshot) {
  if (!snapshot.copy) throw new Error('The native recovery fixture has no document copy.');
  return {
    revision: snapshot.revision,
    copyJson: JSON.stringify(snapshot.copy),
    bindingIdentity: snapshot.bindingIdentity,
  };
}

it.each(['legacy', 'accepted'] as const)(
  'recovers %s input only after the actual binding owner restores the identical missing row',
  async (kind) => {
    const f = await publicationFixture(kind),
      owner = await f.create();
    const initial = await owner.execute({
      documentId: f.documentId,
      operation: inspect,
      projection: 'document',
    });
    const binding = f.db
      .prepare("SELECT * FROM catalog_entity_files WHERE entity_id=? AND status='current'")
      .get(f.documentId) as CatalogFileBindingRow;
    const missing = setCatalogFileStateInDb(f.db, binding.path, 'missing', 'native-input-recovery');
    expect(missing).toMatchObject({ id: binding.id, status: 'missing' });
    await expect(
      owner.execute({
        documentId: f.documentId,
        expectedVersion: initial.version,
        operation: {
          kind: 'client-command',
          command: { method: 'replaceBases', start: 2, end: 2, bases: 'TT' },
        },
        projection: 'document',
      })
    ).rejects.toThrow('no unique owning project');
    expect(await readFile(f.sourcePath, 'utf8')).toBe(f.original);
    expect(owner.model.getState().getVersion(f.documentId)).toBe(initial.version);
    const restored = bindCatalogEntityFileInDb(f.db, {
      entityId: f.documentId,
      path: binding.path,
      workspaceRoot: f.root,
      fileKind: binding.file_kind,
      contentHash: binding.content_hash,
      status: binding.status,
    });
    expect(restored.id).toBe(binding.id);
    expect(restored.status).toBe(binding.status);
    const current = await owner.execute({
      documentId: f.documentId,
      expectedVersion: initial.version,
      expectedRevision: recoveryPrecondition(initial),
      operation: inspect,
      projection: 'document',
    });
    expect(current.copy).toEqual(initial.copy);
    expect(current.bindingIdentity).toBe(initial.bindingIdentity);
    const replayed = await owner.execute({
      documentId: f.documentId,
      expectedVersion: current.version,
      expectedRevision: recoveryPrecondition(current),
      operation: {
        kind: 'client-command',
        command: { method: 'replaceBases', start: 2, end: 2, bases: 'TT' },
      },
      projection: 'document',
    });
    expect(replayed.copy?.sequence.sequence).toBe('AATTCC');
    expect(replayed.version).toBe(initial.version + 1);
    const admitted = await owner.execute({
      documentId: f.documentId,
      expectedVersion: replayed.version,
      expectedRevision: recoveryPrecondition(replayed),
      operation: { kind: 'capture-save', message: 'Recover original missing-binding input' },
      projection: 'document',
    });
    expect(admitted.captureId).toBeDefined();
    const saved = await owner.execute({
      documentId: f.documentId,
      operation: { kind: 'publish-save', captureId: admitted.captureId! },
      projection: 'document',
    });
    expect(saved.saved).toBe(true);
    expect(saved.dirty).toBe(false);
    const acknowledged = await owner.execute({
      documentId: f.documentId,
      operation: inspect,
      projection: 'document',
    });
    expect(acknowledged.dirty).toBe(false);
    expect(acknowledged.copy?.sequence.sequence).toBe('AATTCC');
    expect(
      parseSequenceFileAsDocument(await readFile(f.sourcePath, 'utf8'), f.sourcePath).sequence
        .sequence
    ).toBe('AATTCC');
    expect(
      f.db.prepare('SELECT id,status FROM catalog_entity_files WHERE entity_id=?').all(f.documentId)
    ).toEqual([{ id: binding.id, status: 'current' }]);
  }
);

it.each(['legacy', 'accepted'] as const)(
  'rejects a replacement %s binding at the same path even after an unrelated native inspect adopts it',
  async (kind) => {
    const f = await publicationFixture(kind),
      owner = await f.create();
    const initial = await owner.execute({
      documentId: f.documentId,
      operation: inspect,
      projection: 'document',
    });
    const binding = f.db
      .prepare("SELECT * FROM catalog_entity_files WHERE entity_id=? AND status='current'")
      .get(f.documentId) as CatalogFileBindingRow;
    setCatalogFileStateInDb(f.db, binding.path, 'missing', 'native-input-recovery-replacement');
    f.db.prepare('DELETE FROM catalog_entity_files WHERE id=?').run(binding.id);
    const replacement = bindCatalogEntityFileInDb(f.db, {
      entityId: f.documentId,
      path: binding.path,
      workspaceRoot: f.root,
      fileKind: binding.file_kind,
      contentHash: binding.content_hash,
      status: binding.status,
    });
    expect(replacement.id).not.toBe(binding.id);
    const inspected = await owner.execute({
      documentId: f.documentId,
      operation: inspect,
      projection: 'document',
    });
    expect(inspected.copy).toEqual(initial.copy);
    expect(inspected.bindingIdentity).not.toBe(initial.bindingIdentity);
    await expect(
      owner.execute({
        documentId: f.documentId,
        expectedVersion: initial.version,
        expectedRevision: recoveryPrecondition(initial),
        operation: {
          kind: 'client-command',
          command: { method: 'replaceBases', start: 2, end: 2, bases: 'TT' },
        },
        projection: 'document',
      })
    ).rejects.toThrow('SEQUENCE_DOCUMENT_BINDING_CHANGED');
    expect(owner.model.getState().getVersion(f.documentId)).toBe(initial.version);
    expect(owner.model.getState().sequences[f.documentId].sequence).toBe('AACC');
    expect(await readFile(f.sourcePath, 'utf8')).toBe(f.original);
  }
);

it.each(['legacy', 'accepted'] as const)(
  'refuses changed %s source bytes before replay and preserves the previously acknowledged native copy',
  async (kind) => {
    const f = await publicationFixture(kind),
      owner = await f.create();
    const initial = await owner.execute({
      documentId: f.documentId,
      operation: inspect,
      projection: 'document',
    });
    const changed = serializeGenBank({
      id: f.documentId,
      name: 'Changed source',
      sequence: 'GGCC',
      length: 4,
      circular: false,
      annotations: [],
    });
    await writeFile(f.sourcePath, changed);
    await expect(
      owner.execute({
        documentId: f.documentId,
        expectedVersion: initial.version,
        expectedRevision: recoveryPrecondition(initial),
        operation: {
          kind: 'client-command',
          command: { method: 'replaceBases', start: 2, end: 2, bases: 'TT' },
        },
        projection: 'document',
      })
    ).rejects.toThrow('FILE_CHANGED');
    expect(owner.model.getState().getVersion(f.documentId)).toBe(initial.version);
    expect(owner.model.getState().sequences[f.documentId]).toEqual(initial.copy?.sequence);
    expect(await readFile(f.sourcePath, 'utf8')).toBe(changed);
  }
);

it.each(['reference project', 'viewer role'] as const)(
  'refuses recovered input after committed %s revocation without changing the draft or source',
  async (change) => {
    const f = await publicationFixture('legacy'),
      owner = await f.create();
    const initial = await owner.execute({
      documentId: f.documentId,
      operation: inspect,
      projection: 'document',
    });
    if (change === 'reference project')
      f.db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=?").run(f.workspaceId);
    else
      f.db
        .prepare(
          "INSERT INTO workspace_sync_bindings(workspace_id,workspace_uuid,access_role,enabled,owner_account_id,created_at,updated_at) VALUES (?,?,'viewer',1,'test-account',1,1)"
        )
        .run(f.workspaceId, 'history-current-proof');
    const current = await owner.execute({
      documentId: f.documentId,
      expectedVersion: initial.version,
      expectedRevision: recoveryPrecondition(initial),
      operation: inspect,
      projection: 'document',
    });
    expect(current.readOnly).toBe(true);
    await expect(
      owner.execute({
        documentId: f.documentId,
        expectedVersion: initial.version,
        expectedRevision: recoveryPrecondition(initial),
        operation: {
          kind: 'client-command',
          command: { method: 'replaceBases', start: 2, end: 2, bases: 'TT' },
        },
        projection: 'document',
      })
    ).rejects.toThrow(
      change === 'reference project' ? 'no unique current owning project' : 'view only'
    );
    expect(owner.model.getState().getVersion(f.documentId)).toBe(initial.version);
    expect(owner.model.getState().sequences[f.documentId]).toEqual(initial.copy?.sequence);
    expect(await readFile(f.sourcePath, 'utf8')).toBe(f.original);
  }
);

it.each(['save', 'capture-save', 'inspect', 'client-command'] as const)(
  'refuses implicit source adoption during %s after an owned catalog swap and saves only the restored original source',
  async (attempt) => {
    const f = await publicationFixture('legacy', true);
    const other = join(f.root, 'OtherSource.gb'),
      otherId = 'history-other-document';
    await writeFile(other, f.original);
    f.db
      .prepare(
        "INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at) VALUES(?,'sequence','OtherSource.gb',?,'file',?,1,1)"
      )
      .run(otherId, `file://${other}`, f.workspaceId);
    const otherBinding = bindCatalogEntityFileInDb(f.db, {
      entityId: otherId,
      path: other,
      workspaceRoot: f.root,
      fileKind: 'genbank',
      status: 'current',
    });
    const originalBinding = f.db
      .prepare("SELECT id FROM catalog_entity_files WHERE entity_id=? AND status='current'")
      .get(f.documentId) as { id: string };
    await commitAllIfDirty(f.root, 'Add other source fixture');
    const owner = await f.create();
    const initial = await owner.execute({
      documentId: f.documentId,
      operation: inspect,
      projection: 'document',
    });
    const edited = await owner.execute({
      documentId: f.documentId,
      expectedVersion: initial.version,
      operation: { kind: 'replace-bases', start: 2, end: 2, bases: 'TT', expectedBases: '' },
      projection: 'document',
    });
    const capture = structuredClone(owner.model.getState().captureForSave(f.documentId));
    const swap = () => {
      for (const [oldPath, newPath] of [
        [other, `${other}.stale-binding`],
        [f.sourcePath, other],
        [`${other}.stale-binding`, f.sourcePath],
      ]) {
        const result = rebindCatalogFilesInDb(f.db, { oldPath, newPath, workspaceRoot: f.root });
        expect(result).toEqual({ updated: 1, missingOldPath: false });
      }
    };
    swap();
    const bindings = f.db
      .prepare(
        'SELECT f.id,f.entity_id,f.path,f.file_kind,e.locator FROM catalog_entity_files f JOIN catalog_entities e ON e.id=f.entity_id WHERE f.entity_id IN (?,?) ORDER BY f.entity_id'
      )
      .all(f.documentId, otherId);
    expect(bindings).toEqual([
      {
        id: originalBinding.id,
        entity_id: f.documentId,
        path: other,
        file_kind: 'genbank',
        locator: `file://${other}`,
      },
      {
        id: otherBinding.id,
        entity_id: otherId,
        path: f.sourcePath,
        file_kind: 'genbank',
        locator: `file://${f.sourcePath}`,
      },
    ]);
    const events = f.db
      .prepare(
        "SELECT entity_id,payload FROM catalog_entity_events WHERE event_type='path_moved' ORDER BY rowid"
      )
      .all() as Array<{ entity_id: string; payload: string }>;
    expect(
      events.map((event) => ({ entityId: event.entity_id, ...JSON.parse(event.payload) }))
    ).toEqual([
      { entityId: otherId, oldPath: other, newPath: `${other}.stale-binding` },
      { entityId: f.documentId, oldPath: f.sourcePath, newPath: other },
      { entityId: otherId, oldPath: `${other}.stale-binding`, newPath: f.sourcePath },
    ]);
    const operation =
      attempt === 'save'
        ? { kind: 'save' as const, message: 'Refuse stale source' }
        : attempt === 'capture-save'
          ? { kind: 'capture-save' as const, message: 'Refuse stale source' }
          : attempt === 'inspect'
            ? inspect
            : {
                kind: 'client-command' as const,
                command: {
                  method: 'dispatchEdit' as const,
                  action: { type: 'SET_CURSOR' as const, position: 3 },
                },
              };
    await expect(
      owner.execute({
        documentId: f.documentId,
        expectedVersion: edited.version,
        ...(attempt === 'capture-save' ? { expectedRevision: recoveryPrecondition(edited) } : {}),
        operation,
        projection: 'document',
      })
    ).rejects.toThrow('SEQUENCE_DOCUMENT_BINDING_CHANGED');
    expect(owner.model.getState().captureForSave(f.documentId)).toEqual(capture);
    expect(owner.model.getState().isDirty(f.documentId)).toBe(true);
    expect(await readFile(f.sourcePath, 'utf8')).toBe(f.original);
    expect(await readFile(other, 'utf8')).toBe(f.original);
    swap();
    expect(
      f.db
        .prepare('SELECT id,path,file_kind FROM catalog_entity_files WHERE entity_id=?')
        .get(f.documentId)
    ).toEqual({ id: originalBinding.id, path: f.sourcePath, file_kind: 'genbank' });
    expect(
      f.db
        .prepare('SELECT id,path,file_kind FROM catalog_entity_files WHERE entity_id=?')
        .get(otherId)
    ).toEqual({ id: otherBinding.id, path: other, file_kind: 'genbank' });
    const admitted = await owner.execute({
      documentId: f.documentId,
      expectedVersion: edited.version,
      expectedRevision: recoveryPrecondition(edited),
      operation: { kind: 'capture-save', message: 'Save restored original source' },
      projection: 'document',
    });
    expect(admitted.captureId).toBeDefined();
    const saved = await owner.execute({
      documentId: f.documentId,
      operation: { kind: 'publish-save', captureId: admitted.captureId! },
      projection: 'document',
    });
    expect(saved.saved).toBe(true);
    expect(saved.dirty).toBe(false);
    expect(saved.path).toBe(f.sourcePath);
    expect(
      parseSequenceFileAsDocument(await readFile(f.sourcePath, 'utf8'), f.sourcePath).sequence
        .sequence
    ).toBe(capture?.sequence.sequence);
    expect(await readFile(other, 'utf8')).toBe(f.original);
    expect(
      f.db
        .prepare(
          "SELECT id FROM catalog_entity_events WHERE entity_id=? AND event_type='sequence_edit_transition_v1'"
        )
        .all(f.documentId)
    ).toHaveLength(1);
  }
);

it('continues to admit the existing owned relocation path for a clean native document', async () => {
  const f = await publicationFixture('legacy', true),
    owner = await f.create();
  const initial = await owner.execute({
    documentId: f.documentId,
    operation: inspect,
    projection: 'document',
  });
  const destination = join(f.root, 'Relocated.gb');
  await owner.assertClean(f.sourcePath);
  await rename(f.sourcePath, destination);
  expect(
    rebindCatalogFilesInDb(f.db, {
      oldPath: f.sourcePath,
      newPath: destination,
      workspaceRoot: f.root,
    })
  ).toEqual({ updated: 1, missingOldPath: false });
  await owner.relocate(f.sourcePath, destination);
  const relocated = await owner.execute({
    documentId: f.documentId,
    operation: inspect,
    projection: 'document',
  });
  expect(relocated.path).toBe(destination);
  expect(relocated.version).toBe(initial.version);
  expect(relocated.copy).toEqual(initial.copy);
  const edited = await owner.execute({
    documentId: f.documentId,
    expectedVersion: relocated.version,
    operation: { kind: 'replace-bases', start: 2, end: 2, bases: 'TT', expectedBases: '' },
    projection: 'document',
  });
  expect(edited.path).toBe(destination);
  expect(edited.copy?.sequence.sequence).toBe('AATTCC');
  expect(edited.dirty).toBe(true);
  expect(await readFile(destination, 'utf8')).toBe(f.original);
});
