import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serializeGenBank } from '@waypoint/sequence-utils';
import type { PlatformBridge } from '../../platform';

let limsBridge: PlatformBridge['lims'];
let fsBridge: Partial<PlatformBridge['fs']>;

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '1.0.0', exit: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    lims: limsBridge,
    fs: fsBridge,
    db: {
      settleEntityProjectionSource: async (
        input: Parameters<typeof settleProjectionSourceForTest>[1]
      ) => settleProjectionSourceForTest(openDbs.at(-1)!, input),
      select: async (sql: string, params: unknown[] = []) =>
        openDbs
          .at(-1)!
          .prepare(sql)
          .all(...params),
      execute: async (sql: string, params: unknown[] = []) =>
        openDbs
          .at(-1)!
          .prepare(sql)
          .run(...params),
    },
  }),
}));

import { createLimsTestBridge } from '../../main/__tests__/lims-bridge-for-db';
import { settleProjectionSourceForTest } from '../../main/__tests__/projection-receipt-for-db';
import { buildLimsRegistrySummary } from '../../main/lims-registry-projection';
import { registrySequenceText } from '../../features/lims/components/registry-presenters';
import { BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT } from '../../shared/sequence-entity-schema';
import {
  buildSequencePackageDocument,
  parseSequencePackageDocument,
  serializeSequencePackageDocument,
  sequencePackagePaths,
  type SequencePackageDocument,
} from '../sequence-package';
import { reconcileEntityFile } from './adapter';
import { sequencePackageEntityAdapter } from './sequence-package-adapter';
import {
  projectManagedSequenceRegistry,
  semanticManagedSequenceProjectionFields,
} from '../../shared/managed-sequence-registry-projection';
import { readSequenceProductSummary } from './sequence-product-summary-runtime';

const openDbs: Array<ReturnType<typeof createLimsTestBridge>['db']> = [];
const ownedRoots: string[] = [];

async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function mockAtomicPackageWriter() {
  return vi.fn(
    async (
      input: Parameters<PlatformBridge['fs']['writeWorkspaceTextFileAtomic']>[0]
    ): ReturnType<PlatformBridge['fs']['writeWorkspaceTextFileAtomic']> => {
      if (input.mode === 'replace' && !input.expectedContentHash) {
        throw new Error('Replacement is missing its expected content hash.');
      }
      return { path: input.path, contentHash: await sha256Text(input.content) };
    }
  );
}

beforeEach(() => {
  const bridge = createLimsTestBridge();
  openDbs.push(bridge.db);
  limsBridge = bridge.lims;
  fsBridge = {
    writeWorkspaceTextFileAtomic: mockAtomicPackageWriter(),
  };
  bridge.db
    .prepare(
      `INSERT INTO workspaces (id, name, path, created_at, last_opened_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(7, 'Workspace', '/ws', 1, 1);
});

afterEach(async () => {
  while (openDbs.length > 0) openDbs.pop()?.close();
  for (const root of ownedRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function checkedLegacySourceFixture(
  document: SequencePackageDocument,
  ownerId = document.id
) {
  const db = openDbs.at(-1);
  if (!db) throw new Error('The adapter fixture database is missing.');
  const root = await mkdtemp(join(tmpdir(), 'legacy-plasmid-adapter-'));
  ownedRoots.push(root);
  const packageRoot = join(root, 'Legacy');
  const metadataPath = sequencePackagePaths(packageRoot).metaPath;
  const productPath = join(packageRoot, document.product.file);
  const source = serializeSequencePackageDocument(document);
  const product = serializeGenBank({
    id: document.id,
    name: document.name,
    sequence: 'ACGTACGTACGT',
    length: 12,
    circular: true,
    annotations: [],
    description: '',
  });
  await mkdir(sequencePackagePaths(packageRoot).metaDir, { recursive: true });
  await writeFile(metadataPath, source);
  await writeFile(productPath, product);
  db.prepare("UPDATE workspaces SET path=?,repo_uuid='legacy-adapter-scope' WHERE id=7").run(root);
  db.prepare(
    "INSERT INTO workspace_sync_bindings(workspace_id,workspace_uuid,owner_account_id,remote_workspace_id,enabled,access_role,created_at,updated_at) VALUES(7,'legacy-adapter-scope','account-a','remote-a',0,'viewer',1,1)"
  ).run();
  db.prepare(
    "INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at) VALUES(?,'sequence','Legacy source',?,'file',7,1,1) ON CONFLICT(id) DO UPDATE SET type='sequence',locator=excluded.locator,storage_type='file',workspace_id=7"
  ).run(ownerId, productPath);
  db.prepare(
    "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,created_at,updated_at) VALUES('legacy-file',?,7,?,'waypoint-sequence',1,1)"
  ).run(ownerId, productPath);
  const genericWrite = vi.fn(async () => {
    throw new Error('Viewer generic source writes are unavailable.');
  });
  fsBridge = {
    readTextFile: (path) => readFile(path, 'utf8'),
    stat: async (path) => {
      const info = await stat(path, { bigint: true });
      return {
        canonicalPath: await realpath(path),
        size: Number(info.size),
        mtime: Number(info.mtimeMs),
        ctime: Number(info.ctimeMs),
        mtimeNs: info.mtimeNs.toString(),
        ctimeNs: info.ctimeNs.toString(),
        isFile: info.isFile(),
        isDirectory: info.isDirectory(),
      };
    },
    writeWorkspaceTextFileAtomic: genericWrite,
  };
  const reconstruction = vi.spyOn(limsBridge, 'reconstructLegacyAcceptedPlasmid');
  return {
    root,
    packageRoot,
    metadataPath,
    productPath,
    source,
    product,
    genericWrite,
    reconstruction,
  };
}

describe('sequence package Registry adapter', () => {
  it('retains links and audit history when an archived package is reconciled', async () => {
    const parent = buildSequencePackageDocument({
      id: 'archived-sequence-parent',
      name: 'Retained parent',
      product: { file: 'parent.gb' },
    });
    const document = buildSequencePackageDocument({
      id: 'archived-sequence-links',
      name: 'Archived sequence',
      product: { file: 'sequence.gb' },
    });
    document.entity.relationships = [
      {
        fromEntityId: document.id,
        toEntityId: parent.id,
        type: 'derives_from',
        payload: { evidence: 'retained history' },
      },
    ];
    const context = { workspaceRoot: '/ws', workspaceId: 7 };
    for (const item of [parent, document]) {
      await reconcileEntityFile(
        sequencePackageEntityAdapter,
        serializeSequencePackageDocument(item),
        `/ws/${item.id}/.forge/plasmid.json`,
        1,
        context
      );
    }
    await sequencePackageEntityAdapter.reconcileRelationships!(
      document,
      document.id,
      '/ws/archived-sequence-links/.forge/plasmid.json',
      context
    );
    await limsBridge.archiveEntity({ id: document.id, actor: 'archive-regression' });
    const beforeLinks = openDbs[0].prepare('SELECT * FROM lims_link').all();
    expect(beforeLinks).toHaveLength(1);
    const beforeAudit = openDbs[0].prepare('SELECT * FROM lims_audit ORDER BY event_seq').all();
    document.entity.lifecycle = { archived: true, archivedAt: Date.parse('2026-10-18T00:00:00Z') };
    document.entity.relationships[0].toEntityId = 'unavailable-retained-parent';
    const archivedBytes = serializeSequencePackageDocument(document);
    await expect(
      sequencePackageEntityAdapter.reconcileRelationships!(
        document,
        document.id,
        '/ws/archived-sequence-links/.forge/plasmid.json',
        context
      )
    ).resolves.toBeUndefined();
    expect(openDbs[0].prepare('SELECT * FROM lims_link').all()).toEqual(beforeLinks);
    expect(openDbs[0].prepare('SELECT * FROM lims_audit ORDER BY event_seq').all()).toEqual(
      beforeAudit
    );
    expect(serializeSequencePackageDocument(document)).toBe(archivedBytes);
  });
  it('projects the complete package value through the shared pure owner without losing custom fields', async () => {
    const product = serializeGenBank({
      id: 'complete-projection-product',
      name: 'Complete projection',
      sequence: 'ATGAAA',
      length: 6,
      annotations: [],
      circular: true,
      description: '',
    });
    const document = buildSequencePackageDocument({
      id: 'complete-projection-package',
      name: 'Complete projection',
      product: {
        file: 'product.gb',
        genBankChecksum: 'sha256:complete-file',
        sequenceChecksum: 'sha256:complete-sequence',
        topology: 'linear',
      },
      entity: {
        schema: {
          schemaId: 'schema-custom-projection',
          schemaRevisionId: 'schema-custom-projection-v7',
          name: 'custom_projection',
          displayName: 'Custom projection',
          baseKind: 'sequence',
          version: 7,
          fields: [{ key: 'host', label: 'Host', type: 'text', required: true }],
        },
        fields: { host: 'E. coli', vendorPayload: { nested: [0, false, null], note: 'retained' } },
        registrationStatus: 'registered',
        domainStatus: null,
        registryId: null,
        relationships: [],
      },
    });
    const source = serializeSequencePackageDocument(document);
    const parsed = parseSequencePackageDocument(source);
    const summary = await readSequenceProductSummary(product);
    const projection = await projectManagedSequenceRegistry(parsed, summary);
    expect(projection).toEqual({
      id: parsed.id,
      kind: 'custom_projection',
      name: 'Complete projection',
      fields: {
        host: 'E. coli',
        vendorPayload: { nested: [0, false, null], note: 'retained' },
        schemaId: 'schema-custom-projection',
        schemaRevisionId: 'schema-custom-projection-v7',
        packageKind: 'sequence',
        _managedSequenceProjectionVersion: 3,
        _managedSequenceSnapshot: {
          version: 1,
          markerSha256: `sha256:${await sha256Text(serializeSequencePackageDocument(parsed))}`,
        },
        _managedSequenceContent: {
          fileContentHash: 'sha256:complete-file',
          normalizedSequenceHash: 'sha256:complete-sequence',
          length: 6,
          topology: 'circular',
          geneticCode: 1,
        },
      },
      schemaRevisionId: parsed.entity.schema.schemaRevisionId,
      schemaSnapshot: parsed.entity.schema,
      registrationStatus: 'registered',
      domainStatus: null,
    });
    expect(projection.schemaSnapshot).toBe(parsed.entity.schema);
    const locator = {
      kind: 'managed-sequence',
      packageId: parsed.id,
      packageRoot: '/ws/Complete',
    };
    expect(
      semanticManagedSequenceProjectionFields({
        ...projection.fields,
        _managedSequenceDocument: locator,
      })
    ).toEqual(projection.fields);
    expect(serializeSequencePackageDocument(parsed)).toBe(source);

    fsBridge = {
      readTextFile: vi.fn(async () => product),
      stat: vi.fn(async () => ({ mtime: 20 })),
      writeWorkspaceTextFileAtomic: mockAtomicPackageWriter(),
    };
    const register = vi.spyOn(limsBridge, 'registerEntity');
    await reconcileEntityFile(
      sequencePackageEntityAdapter,
      source,
      '/ws/Complete/.forge/plasmid.json',
      10,
      { workspaceRoot: '/ws', workspaceId: 7 }
    );
    expect(register).toHaveBeenCalledWith(
      {
        ...projection,
        fields: { ...projection.fields, _managedSequenceDocument: locator },
        workspaceId: 7,
        actor: 'workspace-reconcile',
      },
      undefined
    );
  });

  it('reuses an unchanged product summary while still checking live bytes and timestamps', async () => {
    const makeProduct = (sequence: string, circular: boolean) =>
      serializeGenBank({
        id: 'summary-cache-product',
        name: 'Summary cache regression',
        sequence,
        length: sequence.length,
        annotations: [],
        circular,
        description: '',
      });
    let product = makeProduct('ACGTACGT', true);
    let mtime = 20;
    fsBridge = {
      readTextFile: vi.fn(async () => product),
      stat: vi.fn(async (canonicalPath: string) => ({
        canonicalPath,
        size: product.length,
        mtime,
        ctime: mtime,
        mtimeNs: String(mtime * 1000000),
        ctimeNs: String(mtime * 1000000),
        isFile: true,
        isDirectory: false,
      })),
      writeWorkspaceTextFileAtomic: mockAtomicPackageWriter(),
    };
    const document = buildSequencePackageDocument({
      id: 'summary-cache-package',
      name: 'Summary cache package',
      product: { file: 'summary.gb' },
    });
    const source = serializeSequencePackageDocument(document);
    const path = '/ws/Summary/.forge/plasmid.json';
    const ctx = { workspaceRoot: '/ws', workspaceId: 7 };
    const parse = vi.spyOn(await import('@waypoint/sequence-utils'), 'parseGenBankFull');
    try {
      await reconcileEntityFile(sequencePackageEntityAdapter, source, path, 10, ctx);
      mtime = 30;
      await reconcileEntityFile(sequencePackageEntityAdapter, source, path, 10, ctx);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(fsBridge.readTextFile).toHaveBeenCalledTimes(2);
      expect(fsBridge.stat).toHaveBeenCalledTimes(2);

      product = makeProduct('ACGT', false);
      await reconcileEntityFile(sequencePackageEntityAdapter, source, path, 10, ctx);
      expect(parse).toHaveBeenCalledTimes(2);
      const [entity] = await limsBridge.queryEntities({ id: document.id });
      expect(buildLimsRegistrySummary(openDbs[0], entity).fieldValues).toMatchObject({
        size: 4,
        topology: 'linear',
        geneticCode: 1,
      });
    } finally {
      parse.mockRestore();
    }
  });

  it('reads an existing version2 projection without manufacturing a new registration during reconstruction', async () => {
    const document = buildSequencePackageDocument({
      id: 'legacy-marker-association',
      name: 'Existing sequence',
      product: { file: 'saved.gb' },
    });
    const bytes = serializeSequencePackageDocument(document);
    const path = '/ws/Existing/.forge/plasmid.json';
    const ctx = { workspaceRoot: '/ws', workspaceId: 7 };
    await reconcileEntityFile(sequencePackageEntityAdapter, bytes, path, 10, ctx);
    const [current] = await limsBridge.queryEntities({ id: document.id });
    const fields = Object.fromEntries(
      Object.entries(current.fields).filter(([key]) => key !== '_managedSequenceSnapshot')
    );
    await limsBridge.updateEntity({
      id: document.id,
      replaceFields: true,
      fields: { ...fields, _managedSequenceProjectionVersion: 2 },
    });
    const update = vi.spyOn(limsBridge, 'updateEntity');
    await expect(
      reconcileEntityFile(sequencePackageEntityAdapter, bytes, path, 20, ctx)
    ).resolves.toEqual({
      id: document.id,
      outcome: 'in-sync',
    });
    expect(update).not.toHaveBeenCalled();
    const [read] = await limsBridge.queryEntities({ id: document.id });
    expect(read.fields._managedSequenceProjectionVersion).toBe(2);
    expect(read.fields).not.toHaveProperty('_managedSequenceSnapshot');
    update.mockRestore();
  });

  it.each([null, 'dna000999'])(
    'rebuilds two independent Registry projections without changing package identity %s',
    async (registryId) => {
      const document = buildSequencePackageDocument({
        id: 'shared-package-identity',
        name: 'Shared package',
        product: { file: 'shared.gb' },
      });
      document.entity.registryId = registryId;
      const source = serializeSequencePackageDocument(document);
      const path = '/ws/Shared/.forge/plasmid.json';
      const ctx = { workspaceRoot: '/ws', workspaceId: 7 };
      const localIds: string[] = [];
      for (const counter of [0, 3]) {
        if (counter > 0) {
          const bridge = createLimsTestBridge();
          openDbs.push(bridge.db);
          limsBridge = bridge.lims;
          bridge.db
            .prepare(
              'INSERT INTO workspaces (id, name, path, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)'
            )
            .run(7, 'Workspace', '/ws', 1, 1);
          for (let index = 0; index < counter; index += 1) {
            await limsBridge.registerEntity({
              id: `local-record-${index}`,
              kind: 'sequence',
              name: `Local record ${index}`,
              fields: {},
              workspaceId: 7,
            });
          }
        }
        fsBridge = { writeWorkspaceTextFileAtomic: mockAtomicPackageWriter() };
        await expect(
          reconcileEntityFile(sequencePackageEntityAdapter, source, path, 10, ctx)
        ).resolves.toEqual({ id: document.id, outcome: 'created' });
        const [projection] = await limsBridge.queryEntities({ id: document.id });
        expect(projection.registryId).toEqual(expect.any(String));
        localIds.push(projection.registryId!);
        expect(fsBridge.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
        await expect(
          reconcileEntityFile(sequencePackageEntityAdapter, source, path, 11, ctx)
        ).resolves.toEqual({ id: document.id, outcome: 'in-sync' });
        expect(fsBridge.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
      }
      expect(localIds[0]).not.toBe(localIds[1]);
      expect(serializeSequencePackageDocument(document)).toBe(source);
    }
  );

  it('does not reproject a matching package because SQLite bookkeeping changed', async () => {
    const document = buildSequencePackageDocument({
      id: 'managed-sequence-idempotent',
      name: 'Stable package',
      product: { file: 'stable.gb' },
    });
    const path = '/ws/Stable/.forge/plasmid.json';
    const ctx = { workspaceRoot: '/ws', workspaceId: 7 };
    await expect(
      reconcileEntityFile(
        sequencePackageEntityAdapter,
        serializeSequencePackageDocument(document),
        path,
        Date.now(),
        ctx
      )
    ).resolves.toEqual({ id: document.id, outcome: 'created' });

    const writes = vi.mocked(fsBridge.writeWorkspaceTextFileAtomic!);
    expect(writes).not.toHaveBeenCalled();
    const persistedMarker = serializeSequencePackageDocument(document);
    const update = vi.spyOn(limsBridge, 'updateEntity');
    await expect(
      reconcileEntityFile(
        sequencePackageEntityAdapter,
        persistedMarker,
        path,
        Date.now() + 1000,
        ctx
      )
    ).resolves.toEqual({ id: document.id, outcome: 'in-sync' });
    expect(update).not.toHaveBeenCalled();
  });

  it('borrows the active workspace mutation for Registry projection writes', async () => {
    const document = buildSequencePackageDocument({
      id: 'managed-sequence-token',
      name: 'Token-bound package',
      product: { file: 'token-bound.gb' },
    });
    const register = vi.spyOn(limsBridge, 'registerEntity');
    const replaceRelationships = vi.spyOn(limsBridge, 'replaceOutgoingRelationships');
    const ctx = {
      workspaceRoot: '/ws',
      workspaceId: 7,
      mutationToken: 'workspace-mutation-token',
    };

    const source = serializeSequencePackageDocument(document);
    await reconcileEntityFile(
      sequencePackageEntityAdapter,
      source,
      '/ws/Token/.forge/plasmid.json',
      Date.now(),
      ctx
    );
    await sequencePackageEntityAdapter.reconcileRelationships?.(
      document,
      document.id,
      '/ws/Token/.forge/plasmid.json',
      ctx
    );

    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ id: document.id }),
      'workspace-mutation-token'
    );
    expect(replaceRelationships).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: document.id }),
      'workspace-mutation-token'
    );
  });

  it('projects the equivalent published description revision without rewriting its native snapshot', async () => {
    const document = buildSequencePackageDocument({
      id: 'published-description-revision',
      name: 'Preserved native sequence',
      product: { file: 'preserved.gb' },
    });
    document.entity.schema.schemaRevisionId = 'schema-entity-sequence-builtin-description-v3';
    document.entity.fields.description = 'Retain the saved sequence metadata';
    const source = serializeSequencePackageDocument(document);
    const ctx = { workspaceRoot: '/ws', workspaceId: 7 };
    const path = '/ws/Preserved/.forge/plasmid.json';

    await expect(
      reconcileEntityFile(sequencePackageEntityAdapter, source, path, Date.now(), ctx)
    ).resolves.toEqual({ id: document.id, outcome: 'created' });
    await reconcileEntityFile(sequencePackageEntityAdapter, source, path, Date.now(), ctx);

    await expect(limsBridge.queryEntities({ id: document.id })).resolves.toEqual([
      expect.objectContaining({
        schemaRevisionId: BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT.schemaRevisionId,
        fields: expect.objectContaining({
          schemaRevisionId: BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT.schemaRevisionId,
          description: 'Retain the saved sequence metadata',
        }),
      }),
    ]);
    expect(serializeSequencePackageDocument(document)).toBe(source);
    expect(fsBridge.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
  });

  it('refuses a conflicting description revision instead of replacing its fields', async () => {
    const document = buildSequencePackageDocument({
      id: 'conflicting-description-revision',
      name: 'Different schema definition',
      product: { file: 'different.gb' },
    });
    document.entity.schema.schemaRevisionId = 'schema-entity-sequence-builtin-description-v3';
    document.entity.schema.fields.push({ key: 'purpose', label: 'Purpose', type: 'text' });
    document.entity.fields.purpose = 'Keep this distinct field';
    const source = serializeSequencePackageDocument(document);

    await expect(
      reconcileEntityFile(
        sequencePackageEntityAdapter,
        source,
        '/ws/Different/.forge/plasmid.json',
        Date.now(),
        { workspaceRoot: '/ws', workspaceId: 7 }
      )
    ).rejects.toThrow(/Schema version 3.*already/);
    expect(serializeSequencePackageDocument(document)).toBe(source);
    await expect(limsBridge.queryEntities({ id: document.id })).resolves.toEqual([]);
  });

  it('materializes a package-owned custom schema before rebuilding its Registry row', async () => {
    const document = buildSequencePackageDocument({
      id: 'custom-sequence-1',
      name: 'Portable custom sequence',
      product: { file: 'portable.gb' },
      entity: {
        schema: {
          schemaId: 'schema-custom-sequence',
          schemaRevisionId: 'schema-custom-sequence-v7',
          name: 'custom_sequence',
          displayName: 'Custom sequence',
          baseKind: 'sequence',
          version: 7,
          fields: [{ key: 'host', label: 'Host', type: 'text', required: true }],
        },
        fields: { host: 'E. coli' },
        registrationStatus: 'registered',
        domainStatus: null,
        registryId: null,
        relationships: [],
      },
    });

    await expect(
      reconcileEntityFile(
        sequencePackageEntityAdapter,
        serializeSequencePackageDocument(document),
        '/ws/Portable/.forge/plasmid.json',
        Date.now(),
        { workspaceRoot: '/ws', workspaceId: 7 }
      )
    ).resolves.toEqual({ id: document.id, outcome: 'created' });

    await expect(limsBridge.queryEntities({ id: document.id })).resolves.toEqual([
      expect.objectContaining({
        kind: 'custom_sequence',
        schemaId: 'schema-custom-sequence',
        schemaRevisionId: 'schema-custom-sequence-v7',
        fields: expect.objectContaining({ host: 'E. coli' }),
      }),
    ]);
  });

  it('rebinds an existing Registry projection to the package schema revision', async () => {
    const id = 'existing-schema-reprojection';
    await limsBridge.registerEntity({
      id,
      kind: 'sequence',
      name: 'Old projection',
      fields: { description: 'Old value' },
      registrationStatus: 'tracked',
    });
    const document = buildSequencePackageDocument({
      id,
      name: 'Package-owned record',
      product: { file: 'product.gb' },
      entity: {
        schema: {
          schemaId: 'schema-custom-vector',
          schemaRevisionId: 'schema-custom-vector-v4',
          name: 'custom_vector',
          displayName: 'Custom vector',
          baseKind: 'sequence',
          version: 4,
          fields: [{ key: 'purpose', label: 'Purpose', type: 'text' }],
        },
        fields: { purpose: 'Expression' },
        registrationStatus: 'registered',
        domainStatus: null,
        registryId: null,
        relationships: [],
      },
    });

    await expect(
      reconcileEntityFile(
        sequencePackageEntityAdapter,
        serializeSequencePackageDocument(document),
        '/ws/Reprojected/.forge/plasmid.json',
        Date.now(),
        { workspaceRoot: '/ws', workspaceId: 7 }
      )
    ).resolves.toEqual({ id, outcome: 'updated-from-file' });

    await expect(limsBridge.queryEntities({ id })).resolves.toEqual([
      expect.objectContaining({
        kind: 'custom_vector',
        schemaId: 'schema-custom-vector',
        schemaRevisionId: 'schema-custom-vector-v4',
        name: 'Package-owned record',
        fields: expect.objectContaining({ purpose: 'Expression' }),
      }),
    ]);
  });

  it('adopts a legacy accepted assembly into the current Plasmid package schema once', async () => {
    const id = 'legacy-accepted-plasmid';
    const existing = await limsBridge.registerEntity({
      id,
      workspaceId: 7,
      kind: 'plasmid',
      name: 'Accepted plasmid',
      fields: {
        cloningMethod: 'gibson',
        notes: 'Legacy Registry note',
        assemblyBookkeeping: 'must not be copied',
      },
      registrationStatus: 'registered',
    });
    const document = buildSequencePackageDocument({
      id,
      name: 'Accepted plasmid',
      product: { file: 'accepted.gb', topology: 'circular' },
      assembly: { accepted: { type: 'accepted_assembly' } },
      entity: {
        schema: BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT,
        fields: { description: 'Package-only legacy metadata' },
        registrationStatus: 'tracked',
        domainStatus: null,
        registryId: null,
        relationships: [],
      },
    });

    const fixture = await checkedLegacySourceFixture(document);
    const source = fixture.source;
    await reconcileEntityFile(
      sequencePackageEntityAdapter,
      source,
      fixture.metadataPath,
      Date.now(),
      { workspaceRoot: fixture.root, workspaceId: 7 }
    );

    const [projected] = await limsBridge.queryEntities({ id });
    expect(projected).toMatchObject({
      kind: 'plasmid',
      registryId: existing.registryId,
      fields: expect.objectContaining({
        description: 'Package-only legacy metadata',
        cloningMethod: 'gibson',
        notes: 'Legacy Registry note',
      }),
    });
    expect(projected.fields).not.toHaveProperty('assemblyBookkeeping');

    expect(fixture.genericWrite).not.toHaveBeenCalled();
    expect(fixture.reconstruction).toHaveBeenCalledOnce();
    expect(fixture.reconstruction.mock.calls[0][0].expectedMetadataSha256).toBe(
      await sha256Text(source)
    );
    const adopted = parseSequencePackageDocument(await readFile(fixture.metadataPath, 'utf8'));
    expect(adopted.entity.schema).toMatchObject({ name: 'plasmid', baseKind: 'sequence' });
    expect(adopted.entity.registryId).toBe(existing.registryId);
    expect(adopted.entity.fields).toMatchObject({
      description: 'Package-only legacy metadata',
      cloningMethod: 'gibson',
      notes: 'Legacy Registry note',
    });
    expect(adopted.entity.fields).not.toHaveProperty('assemblyBookkeeping');
  });

  it('replaces the old accepted-version Registry identity with the stable package identity', async () => {
    const packageId = 'accepted-version-1';
    const legacyId = `accepted-assembly-${packageId}`;
    const document = buildSequencePackageDocument({
      id: packageId,
      name: 'Legacy accepted plasmid',
      product: { file: 'accepted.gb', topology: 'circular' },
      assembly: {
        accepted: { type: 'accepted_assembly', acceptedAssemblyVersionId: packageId },
      },
      entity: {
        schema: BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT,
        fields: {},
        registrationStatus: 'tracked',
        domainStatus: null,
        registryId: null,
        relationships: [],
      },
    });

    const fixture = await checkedLegacySourceFixture(document, legacyId);
    await limsBridge.registerEntity({
      id: legacyId,
      kind: 'plasmid',
      name: 'Legacy accepted plasmid',
      fields: {
        sequence: {
          mode: 'file',
          relPath: fixture.productPath,
          topology: 'circular',
          length: 12,
          contentHash: `sha256:${await sha256Text(fixture.product)}`,
          sourceFormat: 'gb',
        },
        acceptedAssemblyVersionId: packageId,
        cloningMethod: 'gibson',
      },
      registrationStatus: 'registered',
    });
    const source = fixture.source;
    await reconcileEntityFile(
      sequencePackageEntityAdapter,
      source,
      fixture.metadataPath,
      Date.now(),
      { workspaceRoot: fixture.root, workspaceId: 7 }
    );

    await expect(limsBridge.queryEntities({ id: packageId })).resolves.toEqual([
      expect.objectContaining({
        id: packageId,
        kind: 'plasmid',
        fields: expect.objectContaining({ cloningMethod: 'gibson' }),
      }),
    ]);
    await expect(
      limsBridge.queryEntities({ id: legacyId, includeArchived: true })
    ).resolves.toEqual([expect.objectContaining({ id: legacyId, tombstone: true })]);

    expect(fixture.genericWrite).not.toHaveBeenCalled();
    expect(fixture.reconstruction).toHaveBeenCalledOnce();
    expect(fixture.reconstruction.mock.calls[0][0].expectedMetadataSha256).toBe(
      await sha256Text(source)
    );
    const persisted = parseSequencePackageDocument(await readFile(fixture.metadataPath, 'utf8'));
    expect(persisted.entity.schema.name).toBe('plasmid');
    expect(persisted.id).toBe(document.id);
    expect(persisted.entity.registryId).toBeNull();
    const [projection] = await limsBridge.queryEntities({ id: document.id });
    expect(projection.registryId).toMatch(/^p\d+$/);
  });

  it('rebuilds the Registry row from package metadata, not a loose GenBank file', async () => {
    const document = buildSequencePackageDocument({
      id: 'managed-sequence-1',
      name: 'Package-authoritative name',
      product: { file: 'unrelated-physical-name.gb' },
      entity: {
        schema: BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT,
        fields: { description: 'Projected from the package.' },
        registrationStatus: 'tracked',
        domainStatus: null,
        registryId: null,
        relationships: [],
      },
    });

    const result = await reconcileEntityFile(
      sequencePackageEntityAdapter,
      serializeSequencePackageDocument(document),
      '/ws/Package/.forge/plasmid.json',
      Date.now() + 1_000,
      { workspaceRoot: '/ws', workspaceId: 7 }
    );

    expect(result).toEqual({ id: 'managed-sequence-1', outcome: 'created' });
    expect(await limsBridge.queryEntities({ id: 'managed-sequence-1' })).toEqual([
      expect.objectContaining({
        kind: 'sequence',
        name: 'Package-authoritative name',
        workspaceId: 7,
        fields: expect.objectContaining({
          description: 'Projected from the package.',
          _managedSequenceDocument: {
            kind: 'managed-sequence',
            packageId: 'managed-sequence-1',
            packageRoot: '/ws/Package',
          },
          packageKind: 'sequence',
          schemaRevisionId: BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT.schemaRevisionId,
        }),
      }),
    ]);
  });

  it('repairs a legacy null project binding even when package content is unchanged', async () => {
    const document = buildSequencePackageDocument({
      id: 'managed-sequence-owned',
      name: 'Owned package',
      product: { file: 'owned.gb' },
      entity: {
        schema: BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT,
        fields: {},
        registrationStatus: 'tracked',
        domainStatus: null,
        registryId: null,
        relationships: [],
      },
    });
    const bytes = serializeSequencePackageDocument(document);
    await reconcileEntityFile(
      sequencePackageEntityAdapter,
      bytes,
      '/ws/Owned/.forge/plasmid.json',
      0,
      { workspaceRoot: '/ws', workspaceId: 7 }
    );
    openDbs[0].prepare('UPDATE lims_entity SET workspace_id = NULL WHERE id = ?').run(document.id);

    const result = await reconcileEntityFile(
      sequencePackageEntityAdapter,
      bytes,
      '/ws/Owned/.forge/plasmid.json',
      0,
      { workspaceRoot: '/ws', workspaceId: 7 }
    );

    expect(result.outcome).toBe('updated-from-file');
    await expect(limsBridge.queryEntities({ id: document.id })).resolves.toEqual([
      expect.objectContaining({ id: document.id, workspaceId: 7 }),
    ]);
  });

  it('repairs the managed document locator after a package move without changing identity', async () => {
    const document = buildSequencePackageDocument({
      id: 'managed-sequence-moved',
      name: 'Moved package',
      product: { file: 'moved.gb' },
    });
    const bytes = serializeSequencePackageDocument(document);
    await reconcileEntityFile(
      sequencePackageEntityAdapter,
      bytes,
      '/ws/Original/.forge/plasmid.json',
      0,
      { workspaceRoot: '/ws', workspaceId: 7 }
    );

    const result = await reconcileEntityFile(
      sequencePackageEntityAdapter,
      bytes,
      '/ws/Nested/Moved/.forge/plasmid.json',
      0,
      { workspaceRoot: '/ws', workspaceId: 7 }
    );

    expect(result).toEqual({ id: document.id, outcome: 'updated-from-file' });
    await expect(limsBridge.queryEntities({ id: document.id })).resolves.toEqual([
      expect.objectContaining({
        id: document.id,
        fields: expect.objectContaining({
          _managedSequenceDocument: {
            kind: 'managed-sequence',
            packageId: document.id,
            packageRoot: '/ws/Nested/Moved',
          },
        }),
      }),
    ]);
  });

  it('refuses to create a file-authoritative Registry row without a project owner', async () => {
    const document = buildSequencePackageDocument({
      id: 'managed-sequence-unowned',
      name: 'Unowned package',
      product: { file: 'unowned.gb' },
    });

    await expect(
      reconcileEntityFile(
        sequencePackageEntityAdapter,
        serializeSequencePackageDocument(document),
        '/ws/Unowned/.forge/plasmid.json',
        0,
        { workspaceRoot: '/ws' }
      )
    ).rejects.toThrow('requires a project owner');
    await expect(limsBridge.queryEntities({ id: document.id })).resolves.toEqual([]);
  });

  it('projects a managed sequence as openable Registry content instead of missing data', async () => {
    const document = buildSequencePackageDocument({
      id: 'managed-sequence-openable',
      name: 'Openable package',
      product: {
        file: 'openable.gb',
        genBankChecksum: 'sha256:package-file',
        sequenceChecksum: 'sha256:sequence-bases',
        topology: 'circular',
      },
    });
    await reconcileEntityFile(
      sequencePackageEntityAdapter,
      serializeSequencePackageDocument(document),
      '/ws/Openable/.forge/plasmid.json',
      0,
      { workspaceRoot: '/ws', workspaceId: 7 }
    );
    const [entity] = await limsBridge.queryEntities({ id: document.id });
    const summary = buildLimsRegistrySummary(openDbs[0], entity);

    expect(summary.representation).toEqual(
      expect.objectContaining({
        kind: 'file_sequence',
        label: 'Managed DNA sequence',
        canOpen: true,
        openTarget: expect.objectContaining({
          kind: 'managed_sequence',
          entityId: document.id,
          document: {
            kind: 'managed-sequence',
            packageId: document.id,
            packageRoot: '/ws/Openable',
          },
        }),
      })
    );
    expect(summary.summary).toBe('Managed DNA sequence');
    expect(summary.sequenceSummary).toEqual({
      topology: 'circular',
      contentHash: 'sha256:sequence-bases',
      fileContentHash: 'sha256:package-file',
      normalizedSequenceHash: 'sha256:sequence-bases',
    });
    expect(registrySequenceText(summary)).toBe('Open sequence');
  });

  it('projects intrinsic sequence fields and allocates its local Registry ID without writing the package', async () => {
    const bases = 'ACGT'.repeat(3);
    const product = serializeGenBank({
      id: 'product-1',
      name: 'Product',
      sequence: bases,
      length: bases.length,
      annotations: [],
      circular: true,
      description: '',
    });
    fsBridge = {
      readTextFile: vi.fn().mockResolvedValue(product),
      stat: vi.fn().mockResolvedValue({ mtime: 20 }),
      writeWorkspaceTextFileAtomic: mockAtomicPackageWriter(),
    };
    const document = buildSequencePackageDocument({
      id: 'managed-plasmid-fields',
      name: 'Projected plasmid',
      product: { file: 'product.gb', topology: 'circular' },
      entity: {
        schema: {
          schemaId: 'schema-custom-vector',
          schemaRevisionId: 'schema-custom-vector-v1',
          name: 'custom_vector',
          displayName: 'Custom vector',
          baseKind: 'sequence',
          version: 1,
          fields: [{ key: 'purpose', label: 'Purpose', type: 'text' }],
        },
        fields: { purpose: 'Expression' },
        registrationStatus: 'registered',
        domainStatus: null,
        registryId: null,
        relationships: [],
      },
    });

    const source = serializeSequencePackageDocument(document);
    await reconcileEntityFile(
      sequencePackageEntityAdapter,
      source,
      '/ws/Projected/.forge/plasmid.json',
      10,
      { workspaceRoot: '/ws', workspaceId: 7 }
    );

    const [entity] = await limsBridge.queryEntities({ id: document.id });
    const summary = buildLimsRegistrySummary(openDbs[0], entity);
    expect(summary.schemaSnapshot).toEqual({ ...document.entity.schema, description: null });
    expect(summary.fieldValues).toEqual({
      size: 12,
      topology: 'circular',
      geneticCode: 1,
      purpose: 'Expression',
    });
    const write = vi.mocked(fsBridge.writeWorkspaceTextFileAtomic!);
    expect(write).not.toHaveBeenCalled();
    expect(entity.registryId).toEqual(expect.any(String));
    expect(serializeSequencePackageDocument(document)).toBe(source);
  });
});
