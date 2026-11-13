// @vitest-environment node
import type Database from 'better-sqlite3';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeGenBank } from '@waypoint/sequence-utils';
import type { PlatformBridge } from '../../platform/types';

const state = vi.hoisted(() => ({
  bridge: null as ReturnType<typeof createBridgeFixture> | null,
}));
vi.mock('../../platform', () => ({ platform: () => state.bridge }));
vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
}));
vi.mock('../../main/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('./operations', () => ({
  queryLimsEntities: (input: unknown) => state.bridge!.lims.queryEntities(input as never),
  registerLimsEntity: (input: unknown, options: { mutationToken?: string }) =>
    state.bridge!.lims.registerEntity(input as never, options.mutationToken),
  updateLimsEntity: (input: unknown, options: { mutationToken?: string }) =>
    state.bridge!.lims.updateEntity(input as never, options.mutationToken),
  restoreLimsEntity: (input: unknown, options: { mutationToken?: string }) =>
    state.bridge!.lims.restoreEntity(input as never, options.mutationToken),
  archiveLimsEntity: (input: unknown, options: { mutationToken?: string }) =>
    state.bridge!.lims.archiveEntity(input as never, options.mutationToken),
}));

import { registerAcceptedAssemblyAsLimsEntity } from './assembly-bridge';
import { createFileTestDb } from '../../main/__tests__/test-db';
import { ensureSchema } from '../../main/schema';
import {
  archiveLimsEntityInDb,
  queryLimsEntitiesInDb,
  registerLimsEntityInDb,
  restoreLimsEntityInDb,
  updateLimsEntityInDb,
} from '../../main/lims';
import { assertFileBackedRegistryMutation } from '../../main/file-backed-registry-mutation';
import { settleEntityProjectionSourceInMain } from '../../main/entity-projection-receipts';
import {
  buildSequencePackageDocument,
  parseSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
  type SequencePackageDocument,
} from '../../db/sequence-package';
import { sequenceEntityProjectionContent } from '../../shared/sequence-package-projection';
import { projectManagedSequenceRegistry } from '../../shared/managed-sequence-registry-projection';
import { contentFingerprint } from '../../shared/content-fingerprint';
import { readSequenceProductSummary } from '../../db/entity-substrate/sequence-product-summary-runtime';

let fixture: ReturnType<typeof createFileTestDb>;
let db: Database.Database;
let workspaceRoot: string;
let packageRoot: string;
const actions: Array<{ action: string; id?: string; handled: boolean; token?: string }> = [];

beforeEach(async () => {
  fixture = createFileTestDb('accepted-assembly-projection');
  db = fixture.db;
  ensureSchema(db, fixture.dbPath);
  workspaceRoot = join(fixture.tmpDir, 'Project');
  packageRoot = join(workspaceRoot, 'Product');
  await mkdir(sequencePackagePaths(packageRoot).metaDir, { recursive: true });
  db.prepare('INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(7,?,?,?,1)').run(
    'Project',
    workspaceRoot,
    'accepted-project'
  );
  actions.length = 0;
  state.bridge = createBridgeFixture();
});

function createBridgeFixture() {
  const checked = async <T extends { id?: string }, R>(
    action: 'register' | 'update' | 'archive' | 'restore',
    input: T,
    token: string | undefined,
    write: () => R
  ): Promise<R> => {
    const handled = await assertFileBackedRegistryMutation(db, action, input as never);
    actions.push({ action, id: input.id, handled, token });
    return write();
  };
  const lims: Pick<
    PlatformBridge['lims'],
    'queryEntities' | 'registerEntity' | 'updateEntity' | 'archiveEntity' | 'restoreEntity'
  > = {
    queryEntities: async (input) => queryLimsEntitiesInDb(db, input),
    registerEntity: (input, token) =>
      checked('register', input, token, () => registerLimsEntityInDb(db, input)),
    updateEntity: (input, token) =>
      checked('update', input, token, () => updateLimsEntityInDb(db, input)),
    archiveEntity: (input, token) =>
      checked('archive', input, token, () => archiveLimsEntityInDb(db, input)),
    restoreEntity: (input, token) =>
      checked('restore', input, token, () => restoreLimsEntityInDb(db, input)),
  };
  return {
    db: {
      select: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
      settleEntityProjectionSource: (
        input: Parameters<PlatformBridge['db']['settleEntityProjectionSource']>[0]
      ) => settleEntityProjectionSourceInMain(db, input),
    },
    fs: {
      exists: (path: string) =>
        access(path).then(
          () => true,
          () => false
        ),
      readTextFile: (path: string) => readFile(path, 'utf8'),
      stat: async (path: string) => ({ mtime: (await stat(path)).mtimeMs }),
    },
    lims,
  };
}

afterEach(() => fixture.cleanup());

function packageDocument(acceptedAssemblyVersionId = 'accepted-1'): SequencePackageDocument {
  const document = buildSequencePackageDocument({
    id: 'construct-1',
    name: 'Golden Gate Product',
    product: { file: 'Product.gb' },
  });
  document.entity.fields = {
    cloningMethod: 'golden_gate',
    acceptedAssemblyVersionId,
    designId: 'design-1',
    canonicalDraftChecksum: 'draft-sha',
  };
  document.entity.registrationStatus = 'registered';
  return document;
}

async function publish(document = packageDocument(), sequence = 'ACGTACGT'): Promise<void> {
  const paths = sequencePackagePaths(packageRoot, { productFile: document.product.file });
  await writeFile(paths.metaPath, serializeSequencePackageDocument(document));
  await writeFile(
    paths.productPath,
    serializeGenBank({
      id: document.id,
      name: document.name,
      sequence,
      length: sequence.length,
      annotations: [],
      circular: true,
      description: '',
    })
  );
}

async function finalize(document = packageDocument()) {
  return registerAcceptedAssemblyAsLimsEntity({
    packageDocument: document,
    packageRoot,
    workspaceRoot,
    actor: 'accepted-author',
    mutationToken: 'finalization-lease',
    parentActionId: '550e8400-e29b-41d4-a716-446655440005',
  });
}

async function expectCanonicalReceipt(document: SequencePackageDocument) {
  const product = await readFile(join(packageRoot, document.product.file), 'utf8');
  const summary = await readSequenceProductSummary(product);
  expect(
    db
      .prepare(
        'SELECT adapter_kind,entity_id,workspace_key,projection_version,synchronized_fingerprint FROM entity_projection_sources'
      )
      .all()
  ).toEqual([
    {
      adapter_kind: 'sequence',
      entity_id: document.id,
      workspace_key: 'scope:accepted-project',
      projection_version: 2,
      synchronized_fingerprint: contentFingerprint(
        sequenceEntityProjectionContent(
          await projectManagedSequenceRegistry(
            document,
            summary,
            3,
            await readFile(sequencePackagePaths(packageRoot).metaPath, 'utf8')
          )
        )
      ),
    },
  ]);
}

describe('accepted assembly canonical Registry publication', () => {
  it('registers the actual product summary and settles the canonical native receipt', async () => {
    const document = packageDocument();
    await publish(document);
    const entity = await finalize(document);
    expect(entity).toMatchObject({
      id: document.id,
      workspaceId: 7,
      tombstone: false,
      fields: {
        acceptedAssemblyVersionId: 'accepted-1',
        _managedSequenceProjectionVersion: 3,
        _managedSequenceContent: { length: 8, topology: 'circular' },
        _managedSequenceDocument: { kind: 'managed-sequence', packageId: document.id, packageRoot },
      },
    });
    expect(actions).toEqual([
      { action: 'register', id: document.id, handled: true, token: 'finalization-lease' },
    ]);
    await expectCanonicalReceipt(document);
  });

  it('re-finalizes the same stable package and updates before restoring a historical tombstone', async () => {
    await publish();
    await finalize();
    archiveLimsEntityInDb(db, { id: 'construct-1' });
    const next = packageDocument('accepted-2');
    await publish(next, 'AACCGGTTAA');
    actions.length = 0;
    const entity = await finalize(next);
    expect(entity).toMatchObject({
      id: 'construct-1',
      tombstone: false,
      fields: {
        acceptedAssemblyVersionId: 'accepted-2',
        _managedSequenceContent: { length: 10 },
      },
    });
    expect(actions.map(({ action }) => action)).toEqual(['update', 'restore']);
    expect(actions.every(({ handled, token }) => handled && token === 'finalization-lease')).toBe(
      true
    );
    expect(queryLimsEntitiesInDb(db, { includeArchived: true })).toHaveLength(1);
    await expectCanonicalReceipt(next);
  });

  it('keeps consumed working-copy metadata out of the accepted semantic comparison', async () => {
    const intended = packageDocument();
    await publish({
      ...intended,
      updatedAt: new Date().toISOString(),
      members: [
        ...intended.members,
        {
          id: 'consumed-draft',
          path: 'contents/consumed-draft.json',
          role: 'assembly-draft',
          replaceable: false,
          createdAt: new Date().toISOString(),
        },
      ],
      assembly: { history: [] },
    });
    await expect(finalize(intended)).resolves.toMatchObject({ id: intended.id });
    const actual = parseSequencePackageDocument(
      await readFile(sequencePackagePaths(packageRoot).metaPath, 'utf8')
    );
    await expectCanonicalReceipt(actual);
  });

  it('refuses stale accepted metadata and an unrelated kind without changing Registry state', async () => {
    await publish(packageDocument('accepted-2'));
    await expect(finalize(packageDocument('accepted-1'))).rejects.toThrow(
      /published|source|accepted/i
    );
    expect(db.prepare('SELECT * FROM lims_entity').all()).toEqual([]);
    registerLimsEntityInDb(db, {
      id: 'construct-1',
      kind: 'protein',
      name: 'Unrelated',
      fields: {},
      workspaceId: 7,
    });
    await expect(finalize(packageDocument('accepted-2'))).rejects.toThrow(/wrong kind/i);
    expect(queryLimsEntitiesInDb(db, { id: 'construct-1' })[0]).toMatchObject({
      kind: 'protein',
      name: 'Unrelated',
    });
    expect(db.prepare('SELECT * FROM entity_projection_sources').all()).toEqual([]);
  });

  it('retires only the historical database-owned accepted-version rows after canonical publication', async () => {
    const document = packageDocument();
    registerLimsEntityInDb(db, {
      id: 'accepted-assembly-accepted-1',
      kind: 'sequence',
      name: 'Legacy accepted',
      fields: { acceptedAssemblyVersionId: 'accepted-1' },
      workspaceId: 7,
    });
    await publish(document);
    await finalize(document);
    expect(actions).toEqual([
      { action: 'register', id: document.id, handled: true, token: 'finalization-lease' },
      {
        action: 'archive',
        id: 'accepted-assembly-accepted-1',
        handled: false,
        token: 'finalization-lease',
      },
    ]);
    expect(
      queryLimsEntitiesInDb(db, { id: 'accepted-assembly-accepted-1', includeArchived: true })[0]
        .tombstone
    ).toBe(true);
    await expectCanonicalReceipt(document);
  });
});
