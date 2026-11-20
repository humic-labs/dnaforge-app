import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { parseScientificDocumentIdentity, parseWorkspaceIdentity } from '@waypoint/domain-services';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./scientific-migration-recovery', () => ({
  ensureScientificEnrollmentCheckpoint: vi.fn(async () => {}),
}));
import { serializeSequenceForInPlaceSave, type AnnotatedSequence } from '@waypoint/sequence-utils';
import type { SequenceDocumentSaveInput } from '../shared/sequence-edit-lineage';
import { createFileTestDb } from './__tests__/test-db';
import { ScientificObjectStore } from './scientific-object-store';
import { submitScientificWorkspace } from './scientific-workspace-service';
import { actOnAcceptedScientificEntity } from './scientific-resource-lifecycle';
import { saveSequenceDocumentWithLineage } from './sequence-document-save';
import { readScientificDocumentInMain } from './ipc/scientific-documents';
import {
  defineBlob,
  inspectResourceRevision,
  inspectResourceState,
  listWorkspaceResources,
  parseResourceId,
  defineResourceState,
  parseOperationId,
} from '@waypoint/workspace-revisions';
import {
  buildSequencePackageDocument,
  parseSequencePackageDocument,
  sequencePackagePaths,
  SequencePackageFormatError,
  SEQUENCE_PACKAGE_FORMAT_VERSION,
} from '../db/sequence-package';
import { bindCatalogEntityFileInDb } from './catalog-file-binding';
import { registerCatalogEntityInDb } from './catalog-entity-registration';
import { restoreLimsEntityInsideTx } from './lims-entity-lifecycle';
import { createNativeSequenceDocumentResolver } from './native-sequence-document-resolver';
import { scientificSequencePackageResourceId } from './scientific-sequence-package';
import {
  prepareEnrolledNativeSequenceContent,
  saveEnrolledNativeSequenceEdit,
} from './scientific-sequence-save';
import {
  acquireWorkspaceSyncMutationLease,
  assertWorkspaceMutationLease,
} from './workspace-sync-mutation-lease';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(), getVersion: () => '1.0.0' },
  dialog: { showErrorBox: vi.fn() },
  shell: {
    trashItem: vi.fn(async (source: string) =>
      rename(source, join(f.tmpDir, 'archived-sequence.gb'))
    ),
  },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
import { ensureSchema } from './schema';

const documentId = 'enrolled-sequence';
const sequence = (bases: string): AnnotatedSequence => ({
  id: documentId,
  name: 'Donor',
  sequence: bases,
  length: bases.length,
  circular: false,
  annotations: [],
});
let f: ReturnType<typeof createFileTestDb>;
let store: ScientificObjectStore;
let workspaceId: number;
let root: string;
let path: string;
let original: string;
let initial: { head: string; revisionId: string };
const dependencies = () => ({
  db: f.db,
  resolve: async () => ({ documentId, workspaceRoot: root, sourcePath: path }),
  runDatabase: <T>(operation: () => T): T => operation(),
});
const managedId = 'managed-sequence';
async function managedFixture() {
  const paths = sequencePackagePaths(join(root, 'Managed'), { productFile: 'Managed.gb' });
  const content = serializeSequenceForInPlaceSave(
    { ...sequence('AACC'), id: managedId, name: 'Managed' },
    paths.productPath
  );
  const document = buildSequencePackageDocument({
    id: managedId,
    name: 'Managed',
    product: {
      file: 'Managed.gb',
      genBankChecksum: defineBlob(new TextEncoder().encode(content)).hash,
      sequenceChecksum: defineBlob(new TextEncoder().encode('AACC')).hash,
      topology: 'linear',
    },
  });
  const metadata =
    JSON.stringify(
      {
        ...document,
        laboratoryNote: { source: 'preserve exactly' },
        product: { ...document.product, instrumentNote: 'native product data' },
        entity: { ...document.entity, futureField: ['keep', 7] },
      },
      null,
      2
    ) + '\n';
  f.db
    .prepare(
      "INSERT INTO catalog_entities (id,type,name,locator,storage_type,workspace_id,created_at,updated_at) VALUES (?, 'sequence','Managed',?,'file',?,1,1)"
    )
    .run(managedId, paths.root, workspaceId);
  f.db
    .prepare(
      "INSERT INTO catalog_entity_files (id,entity_id,workspace_id,path,file_kind,created_at,updated_at) VALUES ('managed-file',?,?,?,'waypoint-sequence',1,1)"
    )
    .run(managedId, workspaceId, paths.root);
  await submitScientificWorkspace({
    db: f.db,
    workspaceId,
    request: {
      operationId: 'create-managed',
      expectedHead: store.read().head,
      source: {
        kind: 'native-artifact',
        expectedRevisionId: null,
        entry: {
          resourceId: managedId,
          path: 'Managed/Managed.gb',
          representation: { format: 'genbank-v1', text: content },
          sequencePackageText: metadata,
        },
      },
    },
  });
  const accepted = store.read();
  const identity = parseResourceId(managedId);
  if (!identity.ok) throw new Error('Invalid test sequence identity.');
  const current = accepted.reader.current(identity.value);
  if (!accepted.head || !current) throw new Error('Missing managed sequence baseline.');
  const save = request();
  save.documentId = managedId;
  save.sourcePath = paths.productPath;
  save.accepted = {
    ...save.accepted,
    expectedHead: accepted.head,
    expectedRevisionId: current.revisionId,
  };
  save.capture.sequence = { ...save.capture.sequence, id: managedId, name: 'Managed' };
  const resolve = createNativeSequenceDocumentResolver({
    db: () => f.db,
    workspaceRoots: () => [root],
  });
  return {
    paths,
    content,
    metadata,
    head: accepted.head,
    save,
    dependencies: {
      ...dependencies(),
      resolve: (documentId: string) =>
        resolve({ operationId: 'managed-save', targetDocumentId: documentId }),
    },
  };
}
function packageTextAt(
  head: NonNullable<ReturnType<ScientificObjectStore['read']>['head']>
): string {
  const { graph } = store.read();
  const slots = listWorkspaceResources(graph, head);
  if (!slots.ok) throw new Error('Missing test namespace.');
  const slot = slots.value.find(
    (slot) => slot.resourceId === scientificSequencePackageResourceId(managedId)
  );
  if (!slot) throw new Error('Missing test package.');
  const revision = inspectResourceRevision(graph, slot.revisionId);
  if (!revision.ok || !revision.value.stateHash) throw new Error('Missing test revision.');
  const state = inspectResourceState(graph, revision.value.stateHash);
  if (!state.ok || state.value.layout !== 'file') throw new Error('Missing test state.');
  const bytes = store.readBlob(state.value.blob);
  if (!bytes) throw new Error('Missing test package bytes.');
  return new TextDecoder().decode(bytes);
}
function request(): SequenceDocumentSaveInput & {
  accepted: {
    operationId: string;
    expectedHead: string;
    expectedRevisionId: string;
    parentEventId: string | null;
  };
} {
  return {
    documentId,
    sourcePath: path,
    accepted: {
      operationId: 'save-enrolled-one',
      expectedHead: initial.head,
      expectedRevisionId: initial.revisionId,
      parentEventId: null,
    },
    capture: {
      sequence: sequence('AATTCC'),
      draftBaseline: { sequence: 'AACC', length: 4, circular: false },
      draftSequence: 'AATTCC',
      insertedRanges: [{ start: 2, end: 4 }],
      deletedRanges: [],
      substitutedRanges: [],
      draftLineageId: 'enrolled-draft-one',
    },
  };
}
beforeEach(async () => {
  f = createFileTestDb('scientific-sequence-save');
  ensureSchema(f.db, f.dbPath);
  root = join(f.tmpDir, 'project');
  await mkdir(root);
  root = await realpath(root);
  path = join(root, 'sequence.gb');
  workspaceId = Number(
    f.db
      .prepare('INSERT INTO workspaces (name, path, repo_uuid, created_at) VALUES (?, ?, ?, ?)')
      .run('Science', root, 'scientific-sequence-save', 1).lastInsertRowid
  );
  f.db
    .prepare(
      "INSERT INTO catalog_entities (id, type, name, locator, storage_type, workspace_id, created_at, updated_at) VALUES (?, 'sequence', 'Donor', ?, 'file', ?, 1, 1)"
    )
    .run(documentId, path, workspaceId);
  store = new ScientificObjectStore(f.db, workspaceId);
  original = serializeSequenceForInPlaceSave(sequence('AACC'), path);
  await submitScientificWorkspace({
    db: f.db,
    workspaceId,
    request: {
      operationId: 'enroll',
      expectedHead: null,
      source: {
        kind: 'documents',
        entries: [
          {
            resourceId: documentId,
            path: 'sequence.gb',
            representation: { format: 'genbank-v1', text: original },
          },
        ],
      },
    },
  });
  const accepted = store.read();
  if (!accepted.head) throw Error('Missing accepted baseline');
  initial = { head: accepted.head, revisionId: accepted.reader.listCurrent()[0].revisionId };
});
afterEach(() => f.cleanup());

describe('enrolled sequence Save transaction', () => {
  it('publishes retained annotations and managed history under the native producer lease without admitting a queued replacement', async () => {
    const fixture = await managedFixture();
    const document = {
      documentId: managedId,
      workspaceRoot: root,
      sourcePath: fixture.paths.productPath,
    };
    const operationId = 'native-annotation-apply:retained-test';
    const content = prepareEnrolledNativeSequenceContent({
      db: f.db,
      document,
      operationId,
      content: serializeSequenceForInPlaceSave(
        {
          ...sequence('AACC'),
          id: managedId,
          name: 'Managed',
          annotations: [
            {
              name: 'Retained result',
              type: 'misc_feature',
              label: 'Retained result',
              start: 1,
              end: 2,
              direction: 0,
            },
          ],
        },
        fixture.paths.productPath
      ),
    });
    expect(content).toContain('/dnaforge_ann_id=');
    const lease = await acquireWorkspaceSyncMutationLease(root);
    let replacementEntered = false;
    const replacement = acquireWorkspaceSyncMutationLease(root).then((release) => {
      replacementEntered = true;
      release();
    });
    try {
      expect(() => assertWorkspaceMutationLease(lease, join(root, 'another'))).toThrow(
        'WORKSPACE_MUTATION_LEASE_INVALID'
      );
      const result = await saveEnrolledNativeSequenceEdit({
        db: f.db,
        document,
        content,
        expectedContentHash: defineBlob(new TextEncoder().encode(fixture.content)).hash.slice(
          'sha256:'.length
        ),
        operationId,
        createdAt: '2026-10-11T05:00:00.000Z',
        mutationLease: lease,
      });
      expect(result).toMatchObject({ status: 'saved', lineage: 'recorded' });
      if (result?.status !== 'saved') throw new Error('Native annotation Save did not complete.');
      expect(replacementEntered).toBe(false);
      const current = store.read();
      expect(current.head).not.toBe(fixture.head);
      const identity = parseResourceId(managedId);
      if (!identity.ok) throw new Error('Missing managed sequence identity.');
      expect(current.reader.current(identity.value)?.representation?.text).toBe(content);
      expect(await readFile(fixture.paths.productPath, 'utf8')).toBe(content);
      if (!current.head) throw new Error('Missing native annotation head.');
      const metadata = parseSequencePackageDocument(packageTextAt(current.head));
      expect(metadata.product.genBankChecksum).toBe(
        defineBlob(new TextEncoder().encode(content)).hash
      );
      expect(metadata.versionHistory.revisions).toHaveLength(2);
      expect(packageTextAt(fixture.head)).toBe(fixture.metadata);
      expect(result?.publicationPaths).toEqual(
        expect.arrayContaining(['Managed/Managed.gb', 'Managed/.forge/plasmid.json'])
      );
      expect(
        result?.publicationPaths?.some((path) =>
          path.startsWith('.dnaforge/history/sequence-edits/')
        )
      ).toBe(true);
      expect(
        result?.publicationPaths?.some((path) =>
          path.startsWith('Managed/contents/sequence-snapshot-')
        )
      ).toBe(true);
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM catalog_entity_events').get()).toEqual({
        n: 1,
      });
    } finally {
      lease();
      await replacement;
    }
    expect(replacementEntered).toBe(true);
    expect(() => assertWorkspaceMutationLease(lease, root)).toThrow(
      'WORKSPACE_MUTATION_LEASE_INVALID'
    );
  });
  it.each(['identity', 'format', 'checksum'] as const)(
    'refuses %s-invalid accepted package data before editing and never uses valid working metadata as a fallback',
    async (mismatch) => {
      const fixture = await managedFixture();
      const metadata = JSON.parse(fixture.metadata) as Record<string, unknown>;
      if (mismatch === 'identity') metadata.id = 'another-sequence';
      if (mismatch === 'format') metadata.formatVersion = SEQUENCE_PACKAGE_FORMAT_VERSION + 1;
      if (mismatch === 'checksum')
        metadata.product = {
          ...(metadata.product as Record<string, unknown>),
          genBankChecksum: 'sha256:' + 'f'.repeat(64),
        };
      const bytes = new TextEncoder().encode(JSON.stringify(metadata));
      const { graph, head } = store.read();
      if (!head) throw new Error('Missing accepted test head.');
      const slots = listWorkspaceResources(graph, head),
        operationId = parseOperationId(`invalid-package-${mismatch}`);
      const state = defineResourceState({
        layout: 'file',
        resourceKind: `dnaforge.sequence-package.v${metadata.formatVersion}`,
        mediaType: 'application/json',
        blob: defineBlob(bytes),
      });
      if (!slots.ok || !operationId.ok || !state.ok) throw new Error('Invalid corruption fixture.');
      const resourceId = scientificSequencePackageResourceId(managedId);
      const slot = slots.value.find((slot) => slot.resourceId === resourceId);
      if (!slot) throw new Error('Missing package fixture.');
      const corrupted = store.submit({
        operationId: operationId.value,
        expectedHead: head,
        mutations: [
          {
            kind: 'edit-resource',
            resourceId,
            expectedRevision: slot.revisionId,
            state: state.value,
          },
        ],
        blobs: [bytes],
      });
      expect(corrupted.kind).toBe('changed');
      const corruptedHead = store.read().head;
      await expect(
        saveSequenceDocumentWithLineage(fixture.save, fixture.dependencies)
      ).rejects.toThrow(
        mismatch === 'format' ? SequencePackageFormatError : /accepted sequence package/iu
      );
      expect(store.read().head).toBe(corruptedHead);
      expect(await readFile(fixture.paths.metaPath, 'utf8')).toBe(fixture.metadata);
      expect(await readFile(fixture.paths.productPath, 'utf8')).toBe(fixture.content);
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM catalog_entity_events').get()).toEqual({
        n: 0,
      });
    }
  );
  it('accepts the managed GenBank, exact package checksum and history together, preserving unknown metadata and prior bytes', async () => {
    const fixture = await managedFixture();
    const result = await saveSequenceDocumentWithLineage(fixture.save, fixture.dependencies);
    expect(result.status).toBe('saved');
    const head = store.read().head;
    if (!head) throw new Error('Missing Save head.');
    const text = packageTextAt(head),
      metadata = parseSequencePackageDocument(text);
    const product = await readFile(fixture.paths.productPath, 'utf8');
    expect(metadata.product).toMatchObject({
      genBankChecksum: defineBlob(new TextEncoder().encode(product)).hash,
      sequenceChecksum: defineBlob(new TextEncoder().encode('AATTCC')).hash,
      topology: 'linear',
      instrumentNote: 'native product data',
    });
    expect(JSON.parse(text)).toMatchObject({
      laboratoryNote: { source: 'preserve exactly' },
      entity: { futureField: ['keep', 7] },
    });
    expect(await readFile(fixture.paths.metaPath, 'utf8')).toBe(text);
    expect(packageTextAt(fixture.head)).toBe(fixture.metadata);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM catalog_entity_events').get()).toEqual({ n: 1 });
    expect(await saveSequenceDocumentWithLineage(fixture.save, fixture.dependencies)).toEqual(
      result
    );
    expect(store.read().head).toBe(head);
  });
  it('resolves accepted package authority over invalid working metadata and retries the same blocked compound Save without duplicating history', async () => {
    const fixture = await managedFixture();
    await writeFile(fixture.paths.metaPath, 'Unsubmitted external package edit');
    const pending = await saveSequenceDocumentWithLineage(fixture.save, fixture.dependencies);
    expect(pending.status).toBe('accepted-pending');
    if (pending.status !== 'accepted-pending') throw new Error('Expected pending delivery.');
    const head = store.read().head;
    if (!head) throw new Error('Missing pending head.');
    expect(packageTextAt(head)).not.toBe(fixture.metadata);
    expect(await readFile(fixture.paths.metaPath, 'utf8')).toBe(
      'Unsubmitted external package edit'
    );
    expect(await saveSequenceDocumentWithLineage(fixture.save, fixture.dependencies)).toEqual(
      pending
    );
    await writeFile(fixture.paths.metaPath, fixture.metadata);
    expect(await saveSequenceDocumentWithLineage(fixture.save, fixture.dependencies)).toMatchObject(
      { status: 'saved', eventId: pending.eventId }
    );
    expect(store.read().head).toBe(head);
    expect(await readFile(fixture.paths.metaPath, 'utf8')).toBe(packageTextAt(head));
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM catalog_entity_events').get()).toEqual({ n: 1 });
  });
  it('rolls back the managed package revision with the sequence, receipt and delivery job when its history insert fails', async () => {
    const fixture = await managedFixture();
    const records = f.db.prepare('SELECT * FROM scientific_revision_records').all();
    const blobs = f.db.prepare('SELECT * FROM scientific_revision_blobs').all();
    const jobs = f.db.prepare('SELECT * FROM scientific_materialization_jobs').all();
    f.db.exec(
      "CREATE TRIGGER refuse_managed_lineage BEFORE INSERT ON catalog_entity_events BEGIN SELECT RAISE(ABORT, 'managed history refused'); END"
    );
    await expect(
      saveSequenceDocumentWithLineage(fixture.save, fixture.dependencies)
    ).rejects.toThrow('managed history refused');
    expect(store.read().head).toBe(fixture.head);
    expect(f.db.prepare('SELECT * FROM scientific_revision_records').all()).toEqual(records);
    expect(f.db.prepare('SELECT * FROM scientific_revision_blobs').all()).toEqual(blobs);
    expect(f.db.prepare('SELECT * FROM scientific_materialization_jobs').all()).toEqual(jobs);
    expect(await readFile(fixture.paths.metaPath, 'utf8')).toBe(fixture.metadata);
    expect(await readFile(fixture.paths.productPath, 'utf8')).toBe(fixture.content);
  });
  it('reads accepted bytes despite invalid working data, preserves a blocked delivery and retries one accepted Save without duplicate history', async () => {
    await writeFile(path, 'Unsubmitted external edit');
    const loaded = await readScientificDocumentInMain(
      {
        operationId: 'read-enrolled',
        workspaceRoot: root,
        workspace: parseWorkspaceIdentity('scientific-sequence-save'),
        document: parseScientificDocumentIdentity('sequence.gb'),
      },
      {
        database: f.db,
        read: async () => {
          throw Error('Accepted reader used working bytes');
        },
      }
    );
    expect(loaded).toMatchObject({
      ok: true,
      document: {
        content: original,
        revision: {
          kind: 'accepted-object',
          resourceId: documentId,
          resourceRevisionId: initial.revisionId,
          workspaceVersionId: initial.head,
          sequenceEditParentEventId: null,
        },
      },
    });
    const pending = await saveSequenceDocumentWithLineage(request(), dependencies());
    expect(pending).toMatchObject({ status: 'accepted-pending', lineage: 'recorded' });
    if (pending.status !== 'accepted-pending') throw Error('Expected pending acceptance');
    const head = store.read().head;
    expect(head).not.toBe(initial.head);
    expect(await readFile(path, 'utf8')).toBe('Unsubmitted external edit');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM catalog_entity_events').get()).toEqual({ n: 1 });
    expect(await saveSequenceDocumentWithLineage(request(), dependencies())).toEqual(pending);
    await writeFile(path, original);
    const delivered = await saveSequenceDocumentWithLineage(request(), dependencies());
    expect(delivered).toMatchObject({ status: 'saved', lineage: 'recorded' });
    if (delivered.status !== 'saved') throw Error('Expected completed delivery');
    expect(delivered.eventId).toBe(pending.eventId);
    expect(store.read().head).toBe(head);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM catalog_entity_events').get()).toEqual({ n: 1 });
  });

  it('accepts a proved racing sibling from the captured baseline, rejects another draft and keeps an older retry from rewinding current bytes', async () => {
    const first = await saveSequenceDocumentWithLineage(request(), dependencies());
    if (first.status !== 'saved' || !first.accepted || !first.eventId)
      throw Error('Missing first accepted Save');
    const sibling = request();
    sibling.accepted = {
      operationId: 'save-racing-two',
      expectedHead: first.accepted.workspaceVersionId,
      expectedRevisionId: first.accepted.resourceRevisionId,
      parentEventId: null,
      baseline: { head: initial.head, revisionId: initial.revisionId },
      replacementEventId: first.eventId,
    };
    sibling.capture.sequence = sequence('AAGGCC');
    sibling.capture.draftSequence = 'AAGGCC';
    expect(await saveSequenceDocumentWithLineage(sibling, dependencies())).toMatchObject({
      status: 'saved',
    });
    const head = store.read().head,
      bytes = await readFile(path, 'utf8');
    const unrelated = structuredClone(sibling);
    unrelated.accepted.operationId = 'unrelated-draft';
    unrelated.capture.draftLineageId = 'another-draft';
    await expect(saveSequenceDocumentWithLineage(unrelated, dependencies())).rejects.toThrow(
      /draft sibling/iu
    );
    const reused = request();
    reused.capture.draftLineageId = 'another-intent-with-same-final-bases';
    await expect(saveSequenceDocumentWithLineage(reused, dependencies())).rejects.toThrow(
      /not accepted/iu
    );
    expect(await saveSequenceDocumentWithLineage(request(), dependencies())).toMatchObject({
      status: 'accepted-pending',
      reason: expect.stringContaining('another sequence revision'),
    });
    expect(store.read().head).toBe(head);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM catalog_entity_events').get()).toEqual({ n: 2 });
  });

  it('refuses stale or missing authority and never treats an archived accepted sequence as an ordinary file Save', async () => {
    const unqualified: SequenceDocumentSaveInput = { ...request(), accepted: undefined };
    await expect(saveSequenceDocumentWithLineage(unqualified, dependencies())).rejects.toThrow(
      /Reopen/iu
    );
    const newer = serializeSequenceForInPlaceSave(sequence('GGCC'), path);
    await submitScientificWorkspace({
      db: f.db,
      workspaceId,
      request: {
        operationId: 'another-sequence-edit',
        expectedHead: initial.head,
        source: {
          kind: 'documents',
          entries: [
            {
              resourceId: documentId,
              path: 'sequence.gb',
              representation: { format: 'genbank-v1', text: newer },
            },
          ],
        },
      },
    });
    const head = store.read().head;
    await expect(saveSequenceDocumentWithLineage(request(), dependencies())).rejects.toThrow(
      /not accepted: conflict/iu
    );
    expect(store.read().head).toBe(head);
    expect(await readFile(path, 'utf8')).toBe(newer);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM catalog_entity_events').get()).toEqual({ n: 0 });
    await writeFile(path, 'Unsubmitted retained working file');
    await expect(
      submitScientificWorkspace({
        db: f.db,
        workspaceId,
        request: {
          operationId: 'delete-sequence',
          expectedHead: head,
          source: { kind: 'documents', entries: [] },
        },
      })
    ).rejects.toThrow('SAVED_ENTITY_CONTENT');
    expect(store.read().head).toBe(head);
    await expect(
      actOnAcceptedScientificEntity({
        db: f.db,
        action: 'archive',
        input: { id: documentId },
      })
    ).rejects.toThrow('Save or submit the working changes');
    expect(await readFile(path, 'utf8')).toBe('Unsubmitted retained working file');
    await writeFile(path, newer);
    const archived = await actOnAcceptedScientificEntity({
      db: f.db,
      action: 'archive',
      input: { id: documentId },
    });
    expect(archived?.entity.id).toBe(documentId);
    const deletedHead = store.read().head;
    await writeFile(path, 'Unsubmitted retained working file');
    f.db.transaction(() => {
      registerCatalogEntityInDb(f.db, {
        id: documentId,
        type: 'sequence',
        name: 'Donor',
        locator: path,
        storageType: 'file',
        workspaceRoot: root,
      });
      restoreLimsEntityInsideTx(f.db, { id: documentId });
      bindCatalogEntityFileInDb(f.db, {
        entityId: documentId,
        path,
        workspaceRoot: root,
        fileKind: 'genbank',
        status: 'current',
      });
    })();
    await expect(saveSequenceDocumentWithLineage(unqualified, dependencies())).rejects.toThrow(
      /Restore it explicitly/iu
    );
    expect(store.read().head).toBe(deletedHead);
    expect(await readFile(path, 'utf8')).toBe('Unsubmitted retained working file');
    expect(
      await readScientificDocumentInMain(
        {
          operationId: 'read-deleted',
          workspaceRoot: root,
          workspace: parseWorkspaceIdentity('scientific-sequence-save'),
          document: parseScientificDocumentIdentity('sequence.gb'),
        },
        { database: f.db }
      )
    ).toMatchObject({ ok: false, error: { code: 'DOCUMENT_NOT_FOUND' } });
  });
  it('accepts the new version and coordinate history together and replays one Save without duplicate lineage', async () => {
    const result = await saveSequenceDocumentWithLineage(request(), dependencies());
    expect(result).toMatchObject({ status: 'saved', lineage: 'recorded' });
    const accepted = store.read();
    expect(accepted.head).not.toBe(initial.head);
    expect(accepted.reader.listCurrent()[0].document).toMatchObject({ bases: 'AATTCC' });
    const events = f.db.prepare('SELECT payload FROM catalog_entity_events').all();
    expect(events).toHaveLength(1);
    expect(await saveSequenceDocumentWithLineage(request(), dependencies())).toEqual(result);
    expect(f.db.prepare('SELECT payload FROM catalog_entity_events').all()).toEqual(events);
    expect(store.read().head).toBe(accepted.head);
  });
  it('rolls back the accepted version, receipt, blobs and delivery job when the lineage write fails, preserving every file', async () => {
    const records = f.db.prepare('SELECT * FROM scientific_revision_records').all();
    const blobs = f.db.prepare('SELECT * FROM scientific_revision_blobs').all();
    const jobs = f.db.prepare('SELECT * FROM scientific_materialization_jobs').all();
    f.db.exec(
      "CREATE TRIGGER refuse_sequence_lineage BEFORE INSERT ON catalog_entity_events BEGIN SELECT RAISE(ABORT, 'lineage write refused'); END"
    );
    await expect(saveSequenceDocumentWithLineage(request(), dependencies())).rejects.toThrow(
      /lineage write refused/iu
    );
    expect(store.read().head).toBe(initial.head);
    expect(f.db.prepare('SELECT * FROM scientific_revision_records').all()).toEqual(records);
    expect(f.db.prepare('SELECT * FROM scientific_revision_blobs').all()).toEqual(blobs);
    expect(f.db.prepare('SELECT * FROM scientific_materialization_jobs').all()).toEqual(jobs);
    expect(await readFile(path, 'utf8')).toBe(original);
    f.db.exec('DROP TRIGGER refuse_sequence_lineage');
    expect(await saveSequenceDocumentWithLineage(request(), dependencies())).toMatchObject({
      status: 'saved',
      lineage: 'recorded',
    });
  });
});
