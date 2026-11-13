import type Database from 'better-sqlite3';
import { cp, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeGenBank } from '@waypoint/sequence-utils';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

import { createFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { listLimsEntitySchemasInDb, registerLimsEntityInDb } from './lims';
import {
  NATIVE_ENTITY_PROJECTION_VERSIONS,
  settleEntityProjectionSourceInMain,
} from './entity-projection-receipts';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../db/sequence-package';
import { readSequenceProductSummary } from '../db/entity-substrate/sequence-product-summary-runtime';
import { sequenceEntityProjectionFingerprint } from '../shared/sequence-package-projection';
import {
  ENTITY_ARTIFACT_CURRENT_SCHEMA,
  entityArtifactSchemaSnapshot,
  serializeEntityArtifact,
} from '../shared/entity-artifact';
import { entityArtifactProjectionFingerprint } from '../shared/entity-artifact-projection';
import { molecularDocumentFixture } from '../test/fixtures/molecular-documents';
import { serializeMolecularDocument } from '../shared/molecular-document';
import { molecularDocumentProjectionFields } from '../shared/molecular-document-projection';
import { trackViewFixture } from '../shared/track-view-fixture';
import { parseTrackViewDocument, serializeTrackViewDocument } from '../shared/track-view';
import { trackViewProjectionFields } from '../shared/track-view-projection';
import { registerAllEntityAdapters } from '../db/entity-substrate/register';
import { listEntityAdapters } from '../db/entity-substrate/adapter';
import {
  assertFileBackedRegistryMutation,
  reconstructFileBackedRegistryEntity,
  reconstructFileBackedRegistryRelationships,
} from './file-backed-registry-mutation';
import { relocateWorkspaceFileRefsInDb } from './workspace-relocate';
import { projectManagedSequenceRegistry } from '../shared/managed-sequence-registry-projection';
import {
  limsEntityFromRow,
  type LimsEntityRow,
  type LimsRegisterEntityInput,
  type LimsUpdateEntityInput,
} from '../shared/lims';
import { readEntitySchemaSnapshotInDb } from './entity-schema-snapshot';
import { MANAGED_SEQUENCE_DOCUMENT_FIELD } from '../shared/managed-sequence-document';

let fixture: ReturnType<typeof createFileTestDb>;
let db: Database.Database;
let workspaceRoot: string;

beforeEach(async () => {
  fixture = createFileTestDb('entity-equality-authority');
  db = fixture.db;
  ensureSchema(db, fixture.dbPath);
  workspaceRoot = await mkdtemp(join(tmpdir(), 'fixture-native-receipts-'));
  db.prepare('INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(7,?,?,?,1)').run(
    'Project',
    workspaceRoot,
    'receipt-project'
  );
});

afterEach(async () => {
  fixture.cleanup();
  await rm(workspaceRoot, { recursive: true, force: true });
});

async function publish(relativePath: string, bytes: string): Promise<string> {
  const path = join(workspaceRoot, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

function bind(
  id: string,
  kind: string,
  name: string,
  path: string,
  metadata: Record<string, unknown>
) {
  db.prepare(
    `INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,metadata,created_at,updated_at)
    VALUES(?,?,?,?,'file',7,?,1,1)`
  ).run(id, kind, name, `entity://${kind}/${id}`, JSON.stringify(metadata));
  db.prepare(
    `INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at)
    VALUES(?,?,7,?,?,'current',1,1)`
  ).run(`binding-${id}`, id, path, `dnaforge-${kind}`);
}

type FixtureProjectionState = 'registered' | 'unregistered';

const factories = {
  async sequence(projectionState: FixtureProjectionState = 'registered') {
    const document = buildSequencePackageDocument({
      id: 'receipt-sequence',
      name: 'Sequence receipt',
      product: { file: 'product.gb' },
    });
    const product = serializeGenBank({
      id: 'product',
      name: 'Product',
      sequence: 'ACGTACGT',
      length: 8,
      annotations: [],
      circular: true,
      description: '',
    });
    const path = await publish(
      'Sequence/.forge/plasmid.json',
      serializeSequencePackageDocument(document)
    );
    await publish('Sequence/product.gb', product);
    const summary = await readSequenceProductSummary(product);
    const projection = await projectManagedSequenceRegistry(
      document,
      summary,
      undefined,
      await readFile(path, 'utf8')
    );
    const registration: LimsRegisterEntityInput = {
      ...projection,
      fields: {
        ...projection.fields,
        [MANAGED_SEQUENCE_DOCUMENT_FIELD]: {
          kind: 'managed-sequence',
          packageId: document.id,
          packageRoot: join(workspaceRoot, 'Sequence'),
        },
      },
      workspaceId: 7,
    };
    if (projectionState === 'registered') registerLimsEntityInDb(db, registration);
    return {
      id: document.id,
      path,
      fingerprint: sequenceEntityProjectionFingerprint(projection),
      registration,
    };
  },
  async 'lims-entity'(projectionState: FixtureProjectionState = 'registered') {
    const snapshot = entityArtifactSchemaSnapshot(
      listLimsEntitySchemasInDb(db).find((schema) => schema.entityKind === 'strain')!
    );
    const document = {
      schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
      id: 'receipt-record',
      kind: 'strain',
      name: 'Registry receipt',
      schemaRevisionId: snapshot.schemaRevisionId,
      schemaSnapshot: snapshot,
      archived: false,
      fields: {
        genotypeCanonical: 'recA1',
        artifact: { schema: ENTITY_ARTIFACT_CURRENT_SCHEMA, relativePath: 'Record.entity.json' },
      },
      registrationStatus: 'registered' as const,
      domainStatus: null,
      relationships: [],
      source: { type: 'manual' as const, values: {} },
    };
    const path = await publish('Record.entity.json', serializeEntityArtifact(document));
    const registration: LimsRegisterEntityInput = {
      id: document.id,
      kind: document.kind,
      name: document.name,
      fields: document.fields,
      schemaRevisionId: snapshot.schemaRevisionId,
      schemaSnapshot: snapshot,
      registrationStatus: 'registered',
      domainStatus: null,
      workspaceId: 7,
    };
    if (projectionState === 'registered') registerLimsEntityInDb(db, registration);
    return {
      id: document.id,
      path,
      fingerprint: entityArtifactProjectionFingerprint(document),
      registration,
    };
  },
  async 'molecular-document'(projectionState: FixtureProjectionState = 'registered') {
    const document = await molecularDocumentFixture();
    const id = `receipt-project::${document.id}`;
    const fields = molecularDocumentProjectionFields(document);
    const path = await publish(
      'Pocket.dnaforge-molecular.json',
      serializeMolecularDocument(document)
    );
    bind(id, 'molecular-document', document.name, path, fields);
    const registration: LimsRegisterEntityInput = {
      id,
      kind: 'molecular-document',
      name: document.name,
      fields,
      registrationStatus: 'registered',
      domainStatus: null,
      workspaceId: 7,
    };
    if (projectionState === 'registered') registerLimsEntityInDb(db, registration);
    return { id, path, fingerprint: fields.artifactFingerprint as string, registration };
  },
  async 'track-view'(projectionState: FixtureProjectionState = 'registered') {
    const document = parseTrackViewDocument(JSON.stringify(trackViewFixture()));
    const fields = trackViewProjectionFields(document);
    const path = await publish(
      'View.dnaforge-track-view.json',
      serializeTrackViewDocument(document)
    );
    bind(document.id, 'track-view', document.name, path, {
      fingerprint: fields.artifactFingerprint,
      referenceId: document.reference.assemblyId,
      referenceName: document.reference.name,
      trackCount: fields.trackCount,
    });
    const registration: LimsRegisterEntityInput = {
      id: document.id,
      kind: 'track-view',
      name: document.name,
      fields,
      registrationStatus: 'registered',
      domainStatus: null,
      workspaceId: 7,
    };
    if (projectionState === 'registered') registerLimsEntityInDb(db, registration);
    return {
      id: document.id,
      path,
      fingerprint: fields.artifactFingerprint as string,
      registration,
    };
  },
};

describe('native projection equality receipt admission', () => {
  it('covers every actually registered adapter kind and its exact fingerprint version', () => {
    registerAllEntityAdapters();
    expect(
      Object.fromEntries(
        listEntityAdapters().map((adapter) => [adapter.kind, adapter.projectionVersion ?? 1])
      )
    ).toEqual(NATIVE_ENTITY_PROJECTION_VERSIONS);
  });

  it.each(Object.entries(factories))(
    'settles checked %s files and rejects later database divergence',
    async (kind, create) => {
      const source = await create();
      const input = {
        key: {
          adapterKind: kind,
          entityId: source.id,
          workspaceKey: 'scope:receipt-project',
          relativePath: relative(workspaceRoot, source.path),
          projectionVersion:
            NATIVE_ENTITY_PROJECTION_VERSIONS[
              kind as keyof typeof NATIVE_ENTITY_PROJECTION_VERSIONS
            ],
        },
        fingerprint: source.fingerprint,
      };
      await settleEntityProjectionSourceInMain(db, input);
      const before = db.prepare('SELECT * FROM entity_projection_sources').all();
      expect(before).toMatchObject([
        { adapter_kind: kind, entity_id: source.id, synchronized_fingerprint: source.fingerprint },
      ]);
      db.prepare('UPDATE lims_entity SET name=? WHERE id=?').run(
        'unpublished database edit',
        source.id
      );
      await expect(settleEntityProjectionSourceInMain(db, input)).rejects.toThrow('differs');
      expect(db.prepare('SELECT * FROM entity_projection_sources').all()).toEqual(before);
    }
  );
});

describe('actual-file admission for Registry semantic mutations', () => {
  const entity = (id: string) =>
    limsEntityFromRow(db.prepare('SELECT * FROM lims_entity WHERE id=?').get(id) as LimsEntityRow);
  const update = (id: string): LimsUpdateEntityInput => {
    const row = entity(id);
    return {
      id,
      name: row.name,
      fields: row.fields,
      replaceFields: true,
      registrationStatus: row.registrationStatus,
      domainStatus: row.domainStatus,
      workspaceId: row.workspaceId,
    };
  };

  it.each(Object.entries(factories))(
    'admits the actual initial %s projection before a Registry row exists',
    async (kind, create) => {
      const source = await create('unregistered');
      const row = { ...source.registration, id: source.id };
      const request: LimsRegisterEntityInput = {
        ...row,
        actor: 'untrusted-label',
      };
      await expect(assertFileBackedRegistryMutation(db, 'register', request)).resolves.toBe(true);
      expect(db.prepare('SELECT * FROM lims_entity WHERE id=?').get(row.id)).toBeUndefined();
      await expect(
        assertFileBackedRegistryMutation(db, 'register', {
          ...request,
          name: 'forged source',
          actor: 'workspace-reconcile',
        })
      ).rejects.toThrow('canonical file');
      registerLimsEntityInDb(db, request);
      await settleEntityProjectionSourceInMain(db, {
        key: {
          adapterKind: kind,
          entityId: source.id,
          workspaceKey: 'scope:receipt-project',
          relativePath: relative(workspaceRoot, source.path),
          projectionVersion:
            NATIVE_ENTITY_PROJECTION_VERSIONS[
              kind as keyof typeof NATIVE_ENTITY_PROJECTION_VERSIONS
            ],
        },
        fingerprint: source.fingerprint,
      });
    }
  );

  it.each(Object.entries(factories).filter(([kind]) => kind !== 'lims-entity'))(
    'admits exact %s reconstruction and refuses semantic/lifecycle bypasses',
    async (_kind, create) => {
      const source = await create();
      const request = update(source.id);
      db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
      await expect(assertFileBackedRegistryMutation(db, 'update', request)).resolves.toBe(true);
      for (const patch of [
        { name: 'direct edit' },
        { fields: { ...request.fields, forged: 'field' } },
        { fields: {}, replaceFields: true },
        { workspaceId: 99 },
      ])
        await expect(
          assertFileBackedRegistryMutation(db, 'update', {
            ...request,
            ...patch,
            actor: 'workspace-reconcile',
          })
        ).rejects.toThrow();
      for (const action of ['archive', 'revert'] as const)
        await expect(
          assertFileBackedRegistryMutation(db, action, {
            id: source.id,
            actor: 'workspace-reconcile',
          })
        ).rejects.toThrow('owning file operation');
      db.prepare('UPDATE lims_entity SET tombstone=1 WHERE id=?').run(source.id);
      await expect(
        assertFileBackedRegistryMutation(db, 'restore', { id: source.id, actor: 'arbitrary' })
      ).resolves.toBe(true);
      db.prepare('UPDATE lims_entity SET name=? WHERE id=?').run('unpublished edit', source.id);
      await expect(
        assertFileBackedRegistryMutation(db, 'restore', { id: source.id })
      ).rejects.toThrow('canonical file');
    }
  );

  it.each(Object.entries(factories))(
    'reconstructs the verified %s cache without rewriting its legacy export',
    async (kind, create) => {
      const source = await create();
      const row = entity(source.id);
      const schemaSnapshot = ['sequence', 'lims-entity'].includes(kind)
        ? readEntitySchemaSnapshotInDb(db, source.id)
        : null;
      const request: LimsRegisterEntityInput = {
        id: row.id,
        kind: row.kind,
        name: row.name,
        fields: row.fields,
        registrationStatus: row.registrationStatus,
        domainStatus: row.domainStatus,
        workspaceId: row.workspaceId,
        ...(schemaSnapshot
          ? { schemaSnapshot, schemaRevisionId: schemaSnapshot.schemaRevisionId }
          : {}),
        actor: 'untrusted-label',
      };
      db.prepare('DELETE FROM lims_entity WHERE id=?').run(row.id);
      const auditCount = db.prepare('SELECT COUNT(*) AS count FROM lims_audit').get();
      const manifestPath = join(workspaceRoot, '.waypoint', 'lims', 'manifest.json');
      const manifest = await readFile(manifestPath);
      const bytes = await readFile(source.path);
      await expect(
        reconstructFileBackedRegistryEntity(
          db,
          {
            action: 'register',
            input: { ...request, name: 'forged source', actor: 'workspace-reconcile' },
          },
          (work) => work()
        )
      ).rejects.toThrow('canonical file');
      expect(db.prepare('SELECT * FROM lims_entity WHERE id=?').get(row.id)).toBeUndefined();
      expect(db.prepare('SELECT COUNT(*) AS count FROM lims_audit').get()).toEqual(auditCount);
      await expect(
        reconstructFileBackedRegistryEntity(db, { action: 'register', input: request }, (work) =>
          work()
        )
      ).resolves.toMatchObject({ id: row.id, name: row.name });
      expect(await readFile(manifestPath)).toEqual(manifest);
      expect(await readFile(source.path)).toEqual(bytes);
    }
  );

  it('leaves database-owned registration to the authoring owner', async () => {
    const before = db.prepare('SELECT COUNT(*) AS count FROM lims_audit').get();
    await expect(
      reconstructFileBackedRegistryEntity(
        db,
        {
          action: 'register',
          input: {
            id: 'database-owned',
            kind: 'strain',
            name: 'Database-owned',
            fields: { genotypeCanonical: 'recA1' },
            workspaceId: 7,
            actor: 'workspace-reconcile',
          },
        },
        (work) => work()
      )
    ).resolves.toBeNull();
    expect(
      db.prepare('SELECT * FROM lims_entity WHERE id=?').get('database-owned')
    ).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS count FROM lims_audit').get()).toEqual(before);
  });

  it('checks the saved relationships before reconstructing the local cache', async () => {
    const source = await factories.sequence();
    const before = db.prepare('SELECT COUNT(*) AS count FROM lims_audit').get();
    await expect(
      reconstructFileBackedRegistryRelationships(
        db,
        {
          entityId: source.id,
          workspaceId: 7,
          relationships: [{ toEntityId: 'forged-target', type: 'derives_from' }],
          actor: 'workspace-reconcile',
        },
        (work) => work()
      )
    ).rejects.toThrow('authoritative file');
    expect(db.prepare('SELECT COUNT(*) AS count FROM lims_audit').get()).toEqual(before);
    await expect(
      reconstructFileBackedRegistryRelationships(
        db,
        {
          entityId: source.id,
          workspaceId: 7,
          relationships: [],
          actor: 'untrusted-label',
        },
        (work) => work()
      )
    ).resolves.toEqual({ active: [], tombstoned: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM lims_audit').get()).toEqual(before);
  });

  it('reads saved relationships from a Registry record file at its moved location', async () => {
    const source = await factories['lims-entity']();
    db.prepare(
      `INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at)
      VALUES(?,?,7,?,'waypoint-entity','current',1,1)`
    ).run(`binding-${source.id}`, source.id, source.path);
    const moved = join(workspaceRoot, 'Reviewed records', 'Record.entity.json');
    await mkdir(dirname(moved), { recursive: true });
    await rename(source.path, moved);
    db.transaction(() =>
      relocateWorkspaceFileRefsInDb(db, { workspaceRoot, oldPath: source.path, newPath: moved })
    )();
    await expect(
      reconstructFileBackedRegistryRelationships(
        db,
        {
          entityId: source.id,
          workspaceId: 7,
          relationships: [],
          actor: 'workspace-reconcile',
        },
        (work) => work()
      )
    ).resolves.toEqual({ active: [], tombstoned: 0 });
  });

  it('keeps genuinely database-owned registration distinct from phantom file claims', async () => {
    await expect(
      assertFileBackedRegistryMutation(db, 'register', {
        kind: 'strain',
        name: 'Database-owned',
        fields: { genotypeCanonical: 'recA1' },
        workspaceId: 7,
        actor: 'workspace-reconcile',
      })
    ).resolves.toBe(false);
    await expect(
      assertFileBackedRegistryMutation(db, 'register', {
        id: 'phantom',
        kind: 'track-view',
        name: 'Phantom',
        fields: {},
        workspaceId: 7,
        actor: 'workspace-reconcile',
      })
    ).rejects.toThrow('actual current file binding');
    await expect(
      assertFileBackedRegistryMutation(db, 'register', {
        id: 'phantom',
        kind: 'strain',
        name: 'Phantom',
        fields: {
          artifact: { schema: ENTITY_ARTIFACT_CURRENT_SCHEMA, relativePath: 'missing.entity.json' },
        },
        workspaceId: 7,
        actor: 'workspace-reconcile',
      })
    ).rejects.toThrow();
  });

  it('refuses a project visualization being relabeled as an unbound profile projection', async () => {
    const source = await factories['track-view']();
    db.prepare('UPDATE catalog_entities SET workspace_id=NULL WHERE id=?').run(source.id);
    db.prepare('UPDATE catalog_entity_files SET workspace_id=NULL WHERE entity_id=?').run(
      source.id
    );
    db.prepare('UPDATE lims_entity SET workspace_id=NULL WHERE id=?').run(source.id);
    await expect(assertFileBackedRegistryMutation(db, 'update', update(source.id))).rejects.toThrow(
      'exact workspace owner'
    );
    expect(db.prepare('SELECT * FROM entity_projection_sources').all()).toEqual([]);
  });

  it('repairs a managed sequence location only after its former actual source moved', async () => {
    const source = await factories.sequence();
    const request = update(source.id);
    const previousRoot = join(workspaceRoot, 'Sequence');
    const nextRoot = join(workspaceRoot, 'Moved sequence');
    await cp(previousRoot, nextRoot, { recursive: true });
    const moved = {
      ...request,
      fields: {
        ...request.fields,
        [MANAGED_SEQUENCE_DOCUMENT_FIELD]: {
          kind: 'managed-sequence',
          packageId: source.id,
          packageRoot: nextRoot,
        },
      },
    };
    await expect(assertFileBackedRegistryMutation(db, 'update', moved)).rejects.toThrow(
      'canonical file'
    );
    await rm(nextRoot, { recursive: true });
    await rename(previousRoot, nextRoot);
    await expect(assertFileBackedRegistryMutation(db, 'update', moved)).resolves.toBe(true);
  });

  it('permits canonical repair of a legacy null sequence project binding', async () => {
    const source = await factories.sequence();
    const request = update(source.id);
    db.prepare('UPDATE lims_entity SET workspace_id=NULL WHERE id=?').run(source.id);
    await expect(assertFileBackedRegistryMutation(db, 'update', request)).resolves.toBe(true);
  });

  it('refuses a source edit that no longer matches the requested sequence projection', async () => {
    const source = await factories.sequence();
    const request = update(source.id);
    const document = JSON.parse(await readFile(source.path, 'utf8'));
    await writeFile(
      source.path,
      JSON.stringify({ ...document, name: 'externally changed source' })
    );
    await expect(assertFileBackedRegistryMutation(db, 'update', request)).rejects.toThrow(
      'canonical file'
    );
    expect(entity(source.id).name).toBe(request.name);
  });
});
