import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('./ipc/database', () => ({
  getDb: () => {
    if (!fixture) throw new Error('Scientific package fixture is unavailable.');
    return fixture.db;
  },
}));

vi.mock('./scientific-migration-recovery', () => ({
  ensureScientificEnrollmentCheckpoint: vi.fn(async () => {}),
}));
import { serializeSequenceForInPlaceSave } from '@waypoint/sequence-utils';
import {
  defineBlob,
  defineResourceState,
  inspectResourceRevision,
  parseOperationId,
  parseResourceId,
  parseWorkspacePath,
  type WorkspaceMutation,
} from '@waypoint/workspace-revisions';
import { createNativeFileDocuments } from './native-file-documents';
import { retireSequenceEvidenceQuerySources } from './sequence-evidence-query-attachments';
import { materializeScientificWorkspace } from './scientific-object-materializer';
import { reconcileScientificProjections } from './scientific-projection-service';
import { assertKnownWorkspaceContentWritable } from './workspace-content-write-access';
import { assertUnversionedRendererFilesystemMutationAllowed } from './ipc/workspace-mutation-authority';
import { runWorkspaceFileTrash } from './workspace-file-trash';
import { trashAcceptedScientificPath } from './scientific-resource-lifecycle';
import { assertRendererDatabaseStatementAllowed } from './workspace-sync-database-fence';
import {
  sequencePackageAttachTwoClones,
  SEQUENCE_PACKAGE_ATTACH_PRODUCT_PATH,
  SEQUENCE_PACKAGE_ATTACH_DROP_A_PATH,
  SEQUENCE_PACKAGE_ATTACH_DROP_B_PATH,
} from '../test/scenarios/sequence-package-attach';
import {
  buildSequencePackageDocument,
  fromPackageRelative,
  parseSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
} from '../db/sequence-package';
import { prepareSequenceUserAttachmentMutation } from '../db/sequence-package-user-attachment-mutation';
import { createFileTestDb } from './__tests__/test-db';
import { ScientificObjectStore } from './scientific-object-store';
import { submitScientificWorkspace } from './scientific-workspace-service';
import { withEnrolledSequencePackagePublication } from './scientific-sequence-package-publication';
import { acquireWorkspaceSyncMutationLease } from './workspace-sync-mutation-lease';
import {
  applySequenceRestoreInMain,
  previewSequenceRestoreInMain,
  publishSequencePackageRevisionInMain,
  publishSequenceUserAttachmentMutationInMain,
} from './sequence-package-revision-publication';
import {
  failSequenceEvidenceRunInMain,
  prepareSequenceEvidenceRunInMain,
} from './sequence-package-evidence-publication';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/dnaforge-test-app-data'), getVersion: () => '1.0.0' },
  dialog: { showErrorBox: vi.fn() },
  shell: { trashItem: vi.fn(async (path: string) => rm(path, { recursive: true })) },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
import { ensureSchema } from './schema';

let fixture: ReturnType<typeof createFileTestDb> | undefined;
afterEach(() => fixture?.cleanup());

it('accepts native binary attachments, item Restore and retained evidence together with exact package history, and leaves no files after rejected acceptance', async () => {
  const f = (fixture = createFileTestDb('scientific-native-package'));
  ensureSchema(f.db, f.dbPath);
  let root = join(f.tmpDir, 'project');
  await mkdir(root);
  root = await realpath(root);
  const packageRoot = join(root, 'record');
  const paths = sequencePackagePaths(packageRoot, { productFile: 'record.gb' });
  const content = (bases: string) =>
    serializeSequenceForInPlaceSave(
      {
        id: 'record',
        name: 'record',
        sequence: bases,
        length: bases.length,
        circular: false,
        annotations: [],
      },
      paths.productPath
    );
  const original = content('AACC');
  const hash = (value: string) => defineBlob(new TextEncoder().encode(value)).hash;
  const document = buildSequencePackageDocument({
    id: 'record',
    name: 'record',
    product: {
      file: 'record.gb',
      genBankChecksum: hash(original),
      sequenceChecksum: hash('AACC'),
      topology: 'linear',
    },
  });
  const marker = serializeSequencePackageDocument(document);
  const workspaceId = Number(
    f.db
      .prepare('INSERT INTO workspaces(name,path,repo_uuid,created_at) VALUES(?,?,?,1)')
      .run('Project', root, 'native-package-proof').lastInsertRowid
  );
  f.db
    .prepare(
      "INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at) VALUES('record','sequence','Record',?,'file',?,1,1)"
    )
    .run(packageRoot, workspaceId);
  f.db
    .prepare(
      "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,created_at,updated_at) VALUES('record-file','record',?,?,'waypoint-sequence',1,1)"
    )
    .run(workspaceId, packageRoot);
  const store = new ScientificObjectStore(f.db, workspaceId);
  await submitScientificWorkspace({
    db: f.db,
    workspaceId,
    request: {
      operationId: 'enroll-workspace',
      expectedHead: null,
      source: {
        kind: 'documents',
        entries: [
          {
            resourceId: 'seed',
            path: 'seed.gb',
            representation: { format: 'genbank-v1', text: original },
          },
        ],
      },
    },
  });
  await submitScientificWorkspace({
    db: f.db,
    workspaceId,
    request: {
      operationId: 'enroll-package',
      expectedHead: store.read().head,
      source: {
        kind: 'native-artifact',
        expectedRevisionId: null,
        entry: {
          resourceId: 'record',
          path: 'record/record.gb',
          representation: { format: 'genbank-v1', text: original },
          sequencePackageText: marker,
        },
      },
    },
  });
  const initialHead = store.read().head;
  const lease = await acquireWorkspaceSyncMutationLease(root);
  const run = <T>(operation: () => Promise<T>) =>
    withEnrolledSequencePackagePublication(
      { db: f.db, workspaceRoot: root, packageRoot, packageId: 'record', mutationLease: lease },
      operation
    );
  const baseline = {
    workspaceRoot: root,
    packageRoot,
    packageId: 'record',
    expectedMarkerSha256: hash(marker),
    expectedProductSha256: hash(original),
    operationId: 'attach-native-file',
    mutation: {
      kind: 'attach' as const,
      attachmentId: 'trace',
      memberId: 'ee9a3975-5590-4a14-ae9a-2a9f9dca3243',
      fileName: 'trace.bin',
      content: new Uint8Array([255, 0, 23, 128]),
      createdAt: '2026-10-11T05:00:00Z',
    },
  };
  try {
    const asset = (await prepareSequenceUserAttachmentMutation(document, baseline.mutation)).asset!;
    f.db.exec(
      "CREATE TRIGGER refuse_package_accept BEFORE UPDATE ON scientific_revision_refs BEGIN SELECT RAISE(ABORT,'refuse accepted package'); END"
    );
    await expect(run(() => publishSequenceUserAttachmentMutationInMain(baseline))).rejects.toThrow(
      'refuse accepted package'
    );
    expect(store.read().head).toBe(initialHead);
    expect(await readFile(paths.metaPath, 'utf8')).toBe(marker);
    await expect(readFile(fromPackageRelative(asset.path, packageRoot))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    f.db.exec('DROP TRIGGER refuse_package_accept');
    const attached = await run(() => publishSequenceUserAttachmentMutationInMain(baseline));
    expect(attached.publicationPaths).toContain('.dnaforge/scientific-objects.json');
    expect(await readFile(attached.assetPaths[0])).toEqual(Buffer.from(baseline.mutation.content));
    const afterAttach = parseSequencePackageDocument(await readFile(paths.metaPath, 'utf8'));
    expect(afterAttach.versionHistory.revisions.map((revision) => revision.kind)).toEqual([
      'adopted',
      'member-update',
    ]);
    const adopted = afterAttach.versionHistory.revisions[0].id;
    const edited = content('AACCGG');
    await run(() =>
      publishSequencePackageRevisionInMain({
        workspaceRoot: root,
        packageRoot,
        packageId: 'record',
        nextDocument: {
          ...afterAttach,
          product: {
            ...afterAttach.product,
            genBankChecksum: hash(edited),
            sequenceChecksum: hash('AACCGG'),
          },
        },
        nextProductContent: edited,
        kind: 'sequence-save',
        operationId: 'native-dna-edit',
        revisionId: 'native-dna-edit',
        expectedMarkerSha256: hash(serializeSequencePackageDocument(afterAttach)),
        expectedProductSha256: hash(original),
      })
    );
    expect(await readFile(paths.productPath, 'utf8')).toBe(edited);
    const request = {
      workspaceRoot: root,
      packageRoot,
      packageId: 'record',
      selections: [{ itemId: 'product', revisionId: adopted }],
    };
    const preview = await previewSequenceRestoreInMain(request);
    expect(preview.blockers).toEqual([]);
    const restored = await run(() =>
      applySequenceRestoreInMain({
        ...request,
        previewFingerprint: preview.previewFingerprint,
        operationId: 'restore-native-product',
      })
    );
    expect(
      restored.publicationPaths?.some((path) =>
        path.startsWith('.dnaforge/history/sequence-edits/')
      )
    ).toBe(true);
    expect(await readFile(paths.productPath, 'utf8')).toBe(original);
    const queryPath = join(packageRoot, 'contents', 'query.fasta');
    await writeFile(queryPath, '>query\nAACC\n');
    const evidenceInput = {
      workspaceRoot: root,
      packageRoot,
      packageId: 'record',
      sourcePath: paths.productPath,
      sessionId: 'review',
      session: {
        name: 'Stored review',
        mode: 'one-per-clone' as const,
        createdAt: '2026-10-11T05:01:00Z',
      },
      runId: 'retained-run',
      queries: [{ id: 'query', label: 'Query', path: queryPath }],
    };
    const retained = await run(() => prepareSequenceEvidenceRunInMain(evidenceInput));
    expect(await readFile(retained.referenceReadPath, 'utf8')).toBe(original);
    await run(() => failSequenceEvidenceRunInMain({ ...evidenceInput, status: 'interrupted' }));
    const finalMarker = await readFile(paths.metaPath, 'utf8');
    const final = parseSequencePackageDocument(finalMarker);
    expect(final.evidenceRuns?.[0].status).toBe('interrupted');
    expect(final.userAttachments.trace.sha256).toBe(defineBlob(baseline.mutation.content).hash);
    const finalHead = store.read().head;
    expect(finalHead).not.toBe(initialHead);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM catalog_entity_events').get()).toEqual({ n: 2 });
    await writeFile(paths.metaPath, 'External unsubmitted draft');
    await expect(
      run(() => prepareSequenceEvidenceRunInMain({ ...evidenceInput, runId: 'another-run' }))
    ).rejects.toThrow(/external package changes/i);
    expect(store.read().head).toBe(finalHead);
    expect(await readFile(paths.metaPath, 'utf8')).toBe('External unsubmitted draft');
    await writeFile(paths.metaPath, finalMarker);
  } finally {
    lease();
  }
});

const requireQueryFixtureValue = <T>(
  result: { ok: true; value: T } | { ok: false; error: unknown }
): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

async function acceptedQueryFixture(sourceKind: 'accepted' | 'unversioned') {
  const f = (fixture = createFileTestDb('accepted-query-retirement'));
  ensureSchema(f.db, f.dbPath);
  let root = join(f.tmpDir, 'project');
  await mkdir(root);
  root = await realpath(root);
  await mkdir(join(root, '.git'));
  const scenario = sequencePackageAttachTwoClones();
  const text = (path: string) => {
    const value = scenario.files?.[path];
    if (typeof value !== 'string') throw new Error('The full-length clone fixture is unavailable.');
    return value;
  };
  const reference = text(SEQUENCE_PACKAGE_ATTACH_PRODUCT_PATH);
  const clones = [
    text(SEQUENCE_PACKAGE_ATTACH_DROP_A_PATH),
    text(SEQUENCE_PACKAGE_ATTACH_DROP_B_PATH),
  ];
  const packageRoot = join(root, 'pUC19');
  const paths = sequencePackagePaths(packageRoot, { productFile: 'pUC19.gb' });
  const marker = serializeSequencePackageDocument(
    buildSequencePackageDocument({
      id: 'query-reference',
      name: 'pUC19',
      product: {
        file: 'pUC19.gb',
        genBankChecksum: defineBlob(new TextEncoder().encode(reference)).hash,
        topology: 'circular',
      },
    })
  );
  const workspaceId = Number(
    f.db
      .prepare('INSERT INTO workspaces(name,path,repo_uuid,created_at) VALUES(?,?,?,1)')
      .run('Query proof', root, 'accepted-query-proof').lastInsertRowid
  );
  f.db
    .prepare(
      "INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at) VALUES('query-reference','sequence','pUC19',?,'file',?,1,1)"
    )
    .run(packageRoot, workspaceId);
  f.db
    .prepare(
      "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,created_at,updated_at) VALUES('query-reference-file','query-reference',?,?,'waypoint-sequence',1,1)"
    )
    .run(workspaceId, packageRoot);
  const store = new ScientificObjectStore(f.db, workspaceId);
  await submitScientificWorkspace({
    db: f.db,
    workspaceId,
    request: {
      operationId: 'enroll-query-workspace',
      expectedHead: null,
      source: {
        kind: 'documents',
        entries: [
          {
            resourceId: 'query-seed',
            path: 'seed.gb',
            representation: { format: 'genbank-v1', text: reference },
          },
        ],
      },
    },
  });
  await submitScientificWorkspace({
    db: f.db,
    workspaceId,
    request: {
      operationId: 'enroll-query-package',
      expectedHead: store.read().head,
      source: {
        kind: 'native-artifact',
        expectedRevisionId: null,
        entry: {
          resourceId: 'query-reference',
          path: 'pUC19/pUC19.gb',
          representation: { format: 'genbank-v1', text: reference },
          sequencePackageText: marker,
        },
      },
    },
  });
  const raw = clones.map((content, index) => ({
    path: join(root, 'drop-inbox', String(index), 'clone-1.fasta'),
    relative: requireQueryFixtureValue(parseWorkspacePath(`drop-inbox/${index}/clone-1.fasta`)),
    resourceId: requireQueryFixtureValue(parseResourceId(`raw-source-${index}`)),
    bytes: new TextEncoder().encode(content),
  }));
  if (sourceKind === 'accepted') {
    const accepted = store.submit({
      operationId: requireQueryFixtureValue(parseOperationId('enroll-raw-query-sources')),
      expectedHead: store.read().head,
      mutations: raw.map<WorkspaceMutation>((source) => ({
        kind: 'create-resource',
        resourceId: source.resourceId,
        path: source.relative,
        state: requireQueryFixtureValue(
          defineResourceState({
            layout: 'file',
            resourceKind: 'dnaforge.file',
            mediaType: 'text/plain',
            blob: defineBlob(source.bytes),
          })
        ),
        origin: { kind: 'created' },
      })),
      blobs: raw.map((source) => source.bytes),
    });
    expect(accepted.kind).toBe('changed');
    expect(await materializeScientificWorkspace(store)).toMatchObject({ kind: 'complete' });
  } else {
    for (const source of raw) {
      await mkdir(join(root, 'drop-inbox', source.relative.split('/')[1]), { recursive: true });
      await writeFile(source.path, source.bytes);
    }
  }
  for (const source of raw) {
    f.db
      .prepare(
        "INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at) VALUES(?,'sequence','Raw clone',?,'file',?,1,1)"
      )
      .run(source.resourceId, source.path, workspaceId);
    f.db
      .prepare(
        "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,content_hash,created_at,updated_at) VALUES(?,?,?,?,'fasta',?,1,1)"
      )
      .run(
        `${source.resourceId}-file`,
        source.resourceId,
        workspaceId,
        source.path,
        defineBlob(source.bytes).hash
      );
  }
  const documents = createNativeFileDocuments({
    db: () => f.db,
    workspaceRoots: () => [root],
    writableWorkspaceRoots: () => [root],
    profileDirectory: () => join(f.tmpDir, 'profile'),
  });
  await documents.completeLegacyMigration([]);
  const request = {
    workspaceRoot: root,
    packageRoot,
    packageId: 'query-reference',
    sourcePath: paths.productPath,
    sessionId: 'full-length-clones',
    session: {
      name: 'Full-length clones',
      mode: 'one-per-clone' as const,
      createdAt: '2026-11-04T00:00:00Z',
    },
    runId: 'query-retirement-run',
    queries: raw.map((source, index) => ({
      id: `alignment-query-${index}`,
      label: `Clone ${index + 1}`,
      path: source.path,
    })),
  };
  const assertCurrent = () => assertKnownWorkspaceContentWritable(f.db, root);
  const context = (lease: () => void) => ({
    db: f.db,
    mutationLease: lease,
    assertCurrent,
    documents,
    assertMutationAllowed: async (mutationPaths: readonly string[]) => {
      assertCurrent();
      await assertUnversionedRendererFilesystemMutationAllowed(f.db, 1001, mutationPaths);
    },
    runDatabase: <T>(operation: () => T) => {
      assertRendererDatabaseStatementAllowed(f.db);
      return operation();
    },
  });
  const prepare = (lease: () => void) =>
    withEnrolledSequencePackagePublication(
      {
        db: f.db,
        workspaceRoot: root,
        packageRoot,
        packageId: request.packageId,
        mutationLease: lease,
      },
      () => prepareSequenceEvidenceRunInMain(request, undefined, undefined, assertCurrent)
    );
  return {
    f,
    root,
    workspaceId,
    store,
    packageRoot,
    paths,
    reference,
    clones,
    raw,
    documents,
    request,
    context,
    prepare,
  };
}

it.each(['accepted', 'unversioned'] as const)(
  'retires %s raw clone sources through their native owner and reconstructs only canonical and frozen package bytes from cold accepted history',
  async (sourceKind) => {
    const f = await acceptedQueryFixture(sourceKind);
    const initialSlots = f.store
      .catalog()
      .entries.filter((slot) => f.raw.some((source) => source.resourceId === slot.resourceId));
    if (sourceKind === 'accepted') {
      expect(initialSlots).toHaveLength(2);
      for (const slot of initialSlots)
        expect(f.store.read().reader.current(slot.resourceId)).toBeNull();
    }
    const lease = await acquireWorkspaceSyncMutationLease(f.root);
    let cold: ReturnType<typeof createFileTestDb> | undefined;
    try {
      const prepared = await f.prepare(lease);
      await retireSequenceEvidenceQuerySources(f.request, prepared, f.context(lease));
      const head = f.store.read().head;
      const marker = await readFile(f.paths.metaPath, 'utf8');
      const canonical = [
        join(f.packageRoot, 'contents', 'clone-1.fasta'),
        join(f.packageRoot, 'contents', 'clone-1-2.fasta'),
      ];
      for (const [index, source] of f.raw.entries()) {
        const id = f.request.queries[index].id;
        expect(prepared.attachedQueryPaths?.[id]).toBe(canonical[index]);
        expect(prepared.queryPaths[id]).not.toBe(canonical[index]);
        expect(prepared.run.queries[index].id).toBe(id);
        expect(await readFile(canonical[index], 'utf8')).toBe(f.clones[index]);
        expect(await readFile(prepared.queryPaths[id], 'utf8')).toBe(f.clones[index]);
        await expect(readFile(source.path)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(
          f.f.db.prepare('SELECT status FROM catalog_entity_files WHERE path=?').get(source.path)
        ).toEqual({ status: 'missing' });
        if (sourceKind === 'accepted') {
          const before = initialSlots.find((slot) => slot.resourceId === source.resourceId);
          const after = f.store
            .catalog()
            .entries.find((slot) => slot.resourceId === source.resourceId);
          expect(after).toMatchObject({
            resourceId: source.resourceId,
            path: null,
            lastPath: source.relative,
            tombstone: true,
          });
          if (!before || !after) throw new Error('Accepted source identity was lost.');
          expect(
            requireQueryFixtureValue(
              inspectResourceRevision(f.store.read().graph, after.revisionId)
            ).parentIds
          ).toContain(before.revisionId);
          expect(f.store.readBlob(defineBlob(source.bytes))).toEqual(Buffer.from(source.bytes));
        }
      }
      if (sourceKind === 'unversioned') {
        const trash = await runWorkspaceFileTrash({
          kind: 'list',
          workspaceRoot: f.root,
          offset: 0,
          limit: 50,
        });
        if (trash.kind !== 'list')
          throw new Error('The native query recovery entries are unavailable.');
        expect(trash.errors).toEqual([]);
        expect(trash.entries.map((entry) => entry.originalPath).sort()).toEqual(
          f.raw.map((source) => source.relative).sort()
        );
        for (const entry of trash.entries) {
          const source = f.raw.find((candidate) => candidate.relative === entry.originalPath);
          if (!source) throw new Error('The recovery entry is not an original query source.');
          expect(
            await readFile(join(f.root, '.git', 'dnaforge-file-trash', entry.id, 'payload'))
          ).toEqual(Buffer.from(source.bytes));
        }
      }
      expect(await readFile(f.paths.productPath, 'utf8')).toBe(f.reference);
      await retireSequenceEvidenceQuerySources(f.request, prepared, f.context(lease));
      expect(f.store.read().head).toBe(head);
      const envelope = f.store.exportHistory();
      const blobs = new Map(
        envelope.blobs.map((blob) => {
          const bytes = f.store.readBlob(blob);
          if (!bytes) throw new Error('The exported accepted blob is unavailable.');
          return [blob.hash, Uint8Array.from(bytes)] as const;
        })
      );
      await f.documents.close();
      f.f.db.close();
      await rm(f.packageRoot, { recursive: true });
      await rm(join(f.root, 'seed.gb'));
      lease();
      cold = createFileTestDb('cold-query-materialization');
      ensureSchema(cold.db, cold.dbPath);
      const coldWorkspace = Number(
        cold.db
          .prepare('INSERT INTO workspaces(name,path,repo_uuid,created_at) VALUES(?,?,?,1)')
          .run('Cold query proof', f.root, 'accepted-query-proof').lastInsertRowid
      );
      const restored = new ScientificObjectStore(cold.db, coldWorkspace);
      expect(
        restored.installHistory({
          envelope,
          expectedHead: null,
          readBlob: (blob) => blobs.get(blob.hash) ?? null,
        }).kind
      ).toBe('adopted');
      expect(restored.pendingMaterializations()).toHaveLength(1);
      await reconcileScientificProjections({ db: cold.db, workspaceId: coldWorkspace });
      expect(restored.pendingMaterializations()).toHaveLength(0);
      expect(restored.read().head).toBe(head);
      expect(await readFile(f.paths.productPath, 'utf8')).toBe(f.reference);
      expect(await readFile(f.paths.metaPath, 'utf8')).toBe(marker);
      for (const [index, source] of f.raw.entries()) {
        const id = f.request.queries[index].id;
        await expect(readFile(source.path)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(canonical[index], 'utf8')).toBe(f.clones[index]);
        expect(await readFile(prepared.queryPaths[id], 'utf8')).toBe(f.clones[index]);
        expect(
          cold.db
            .prepare("SELECT path FROM catalog_entity_files WHERE path=? AND status='current'")
            .get(source.path)
        ).toBeUndefined();
        if (sourceKind === 'accepted') {
          expect(
            restored.catalog().entries.find((slot) => slot.resourceId === source.resourceId)
          ).toMatchObject({ resourceId: source.resourceId, tombstone: true });
          expect(restored.readBlob(defineBlob(source.bytes))).toEqual(Buffer.from(source.bytes));
        }
      }
      expect(
        cold.db
          .prepare("SELECT id FROM catalog_entities WHERE id='query-reference' AND status='active'")
          .get()
      ).toEqual({ id: 'query-reference' });
    } finally {
      lease();
      cold?.cleanup();
    }
  }
);

it('refuses accepted evidence when the project is demoted while native acceptance is pending', async () => {
  const f = await acceptedQueryFixture('accepted');
  const lease = await acquireWorkspaceSyncMutationLease(f.root);
  const head = f.store.read().head;
  const marker = await readFile(f.paths.metaPath);
  const { ensureScientificEnrollmentCheckpoint } = await import('./scientific-migration-recovery');
  vi.mocked(ensureScientificEnrollmentCheckpoint).mockImplementationOnce(async () => {
    f.f.db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=?").run(f.workspaceId);
  });
  try {
    await expect(f.prepare(lease)).rejects.toThrow('owner or write access changed');
    expect(f.store.read().head).toBe(head);
    expect(await readFile(f.paths.metaPath)).toEqual(marker);
    for (const source of f.raw)
      expect(await readFile(source.path)).toEqual(Buffer.from(source.bytes));
  } finally {
    await f.documents.close();
    lease();
  }
});

it.each(['changed-bytes', 'view-only', 'missing-source'] as const)(
  'retains accepted query identity and available raw inputs when retirement is refused for %s',
  async (refusal) => {
    const f = await acceptedQueryFixture('accepted');
    const lease = await acquireWorkspaceSyncMutationLease(f.root);
    try {
      const prepared = await f.prepare(lease);
      const head = f.store.read().head;
      const marker = await readFile(f.paths.metaPath, 'utf8');
      const first = f.raw[0];
      const changed = new TextEncoder().encode('>new unsaved input\nTTTT\n');
      if (refusal === 'changed-bytes') await writeFile(first.path, changed);
      if (refusal === 'missing-source') await rm(first.path);
      if (refusal === 'view-only')
        f.f.db
          .prepare("UPDATE workspaces SET access_mode='reference' WHERE id=?")
          .run(f.workspaceId);
      await expect(
        retireSequenceEvidenceQuerySources(f.request, prepared, f.context(lease))
      ).rejects.toThrow();
      expect(f.store.read().head).toBe(head);
      expect(await readFile(f.paths.metaPath, 'utf8')).toBe(marker);
      for (const source of f.raw) {
        expect(
          f.store.catalog().entries.find((slot) => slot.resourceId === source.resourceId)
        ).toMatchObject({ tombstone: false });
        expect(f.store.readBlob(defineBlob(source.bytes))).toEqual(Buffer.from(source.bytes));
        expect(
          f.f.db.prepare('SELECT status FROM catalog_entity_files WHERE path=?').get(source.path)
        ).toEqual({ status: 'current' });
        if (refusal !== 'missing-source' || source !== first)
          expect(await readFile(source.path)).toEqual(
            Buffer.from(refusal === 'changed-bytes' && source === first ? changed : source.bytes)
          );
      }
    } finally {
      await f.documents.close();
      lease();
    }
  }
);

it.each(['canonical-member', 'marker', 'identity-map'] as const)(
  'refuses standalone accepted-file deletion of a protected %s',
  async (target) => {
    const f = await acceptedQueryFixture('accepted');
    const lease = await acquireWorkspaceSyncMutationLease(f.root);
    try {
      const prepared = await f.prepare(lease);
      const path =
        target === 'marker'
          ? f.paths.metaPath
          : target === 'identity-map'
            ? join(f.root, '.dnaforge', 'scientific-objects.json')
            : prepared.attachedQueryPaths?.[f.request.queries[0].id];
      if (!path) throw new Error('The protected accepted package input is unavailable.');
      const bytes = await readFile(path);
      const head = f.store.read().head;
      await expect(
        trashAcceptedScientificPath({
          db: f.f.db,
          path,
          mutationLease: lease,
          assertCurrent: f.context(lease).assertCurrent,
          expectedContentHash: defineBlob(bytes).hash,
        })
      ).rejects.toThrow();
      expect(f.store.read().head).toBe(head);
      expect(await readFile(path)).toEqual(bytes);
      for (const source of f.raw)
        expect(await readFile(source.path)).toEqual(Buffer.from(source.bytes));
    } finally {
      await f.documents.close();
      lease();
    }
  }
);
