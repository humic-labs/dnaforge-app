import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformBridge } from '../../platform';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256Text, writeWorkspaceTextFileAtomicInMain } from '../../main/primer-artifact-files';
import { setRememberedDeveloperImportSourceRootsForRenderer } from '../../shared/developer-import-sources';

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
      execute: async (sql: string, params: unknown[] = []) =>
        openDbs
          .at(-1)!
          .prepare(sql)
          .run(...params),
      select: async (sql: string, params: unknown[] = []) =>
        openDbs
          .at(-1)!
          .prepare(sql)
          .all(...params),
    },
  }),
}));

import { createLimsTestBridge } from '../../main/__tests__/lims-bridge-for-db';
import { settleProjectionSourceForTest } from '../../main/__tests__/projection-receipt-for-db';
import {
  ENTITY_ARTIFACT_CURRENT_SCHEMA,
  ENTITY_ARTIFACT_SCHEMA,
  entityArtifactSchemaSnapshot,
  serializeEntityArtifact,
  parseEntityArtifact,
  type EntityArtifactV2,
} from '../../shared/entity-artifact';
import { reconcileEntityFile } from './adapter';
import { limsEntityArtifactAdapter } from './lims-entity-adapter';

let strainSnapshot: EntityArtifactV2['schemaSnapshot'];
const openDbs: Array<ReturnType<typeof createLimsTestBridge>['db']> = [];
const temporaryRoots: string[] = [];

function artifact(input: {
  id: string;
  name: string;
  relationships?: EntityArtifactV2['relationships'];
}): EntityArtifactV2 {
  return {
    schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
    id: input.id,
    schemaRevisionId: strainSnapshot.schemaRevisionId,
    schemaSnapshot: strainSnapshot,
    archived: false,
    kind: 'strain',
    name: input.name,
    fields: {
      genotypeCanonical: 'recA1',
      artifact: {
        schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
        relativePath: `records/strain/${input.id}.entity.json`,
      },
    },
    registrationStatus: 'registered',
    domainStatus: null,
    relationships: input.relationships ?? [],
    source: {
      recordId: `row-${input.id}`,
      sourceName: 'strains.csv',
      sourceKind: 'csv',
      values: { Name: input.name },
    },
  };
}

beforeEach(async () => {
  const bridge = createLimsTestBridge();
  openDbs.push(bridge.db);
  limsBridge = {
    ...bridge.lims,
    upgradeLegacyEntityArtifact: vi.fn(bridge.lims.upgradeLegacyEntityArtifact),
  };
  fsBridge = {
    writeWorkspaceTextFileAtomic: vi.fn((input) =>
      writeWorkspaceTextFileAtomicInMain(input, { durable: true })
    ),
  };
  strainSnapshot = entityArtifactSchemaSnapshot(
    (await bridge.lims.listSchemas()).find((schema) => schema.entityKind === 'strain')!
  );
  bridge.db
    .prepare(
      `INSERT INTO workspaces (id, name, path, created_at, last_opened_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(7, 'Workspace', '/ws', 1, 1);
});

afterEach(async () => {
  while (openDbs.length > 0) openDbs.pop()?.close();
  setRememberedDeveloperImportSourceRootsForRenderer([]);
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function legacyOwnedFile(archived = false) {
  const root = await mkdtemp(join(tmpdir(), 'registry-owned-v1-'));
  temporaryRoots.push(root);
  openDbs.at(-1)!.prepare('UPDATE workspaces SET path = ? WHERE id = 7').run(root);
  const doc = artifact({ id: 'legacy-owned', name: 'Legacy owned strain' });
  doc.fields.artifact = {
    schema: ENTITY_ARTIFACT_SCHEMA,
    relativePath: 'records/strain/legacy-owned.entity.json',
  };
  await limsBridge.registerEntity({
    id: doc.id,
    kind: doc.kind,
    name: doc.name,
    schemaRevisionId: doc.schemaRevisionId,
    schemaSnapshot: doc.schemaSnapshot,
    fields: doc.fields,
    registrationStatus: doc.registrationStatus,
    domainStatus: doc.domainStatus,
    workspaceId: 7,
    actor: 'legacy-fixture',
  });
  if (archived) await limsBridge.archiveEntity({ id: doc.id, actor: 'legacy-fixture' });
  const {
    schemaRevisionId: _revision,
    schemaSnapshot: _definition,
    archived: _archived,
    ...legacy
  } = doc;
  const original = JSON.stringify({
    ...legacy,
    schema: ENTITY_ARTIFACT_SCHEMA,
    topExtension: { retained: true },
    source: { ...legacy.source, sourceExtension: ['unchanged'] },
  });
  const path = join(root, 'records/strain/legacy-owned.entity.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, original);
  const ctx = {
    workspaceRoot: root,
    workspaceId: 7,
    workspaceScope: 'ws7',
    mutationToken: 'borrowed-migration-token',
  };
  return { original, path, root, ctx, doc };
}

describe('generic LIMS entity adapter', () => {
  it.each([false, true])(
    'publishes a matching owned v1 record with its exact frozen definition and archive state (%s)',
    async (archived) => {
      const fixture = await legacyOwnedFile(archived);
      const before = await limsBridge.getRegistryPreview({ entityId: fixture.doc.id });
      const result = await reconcileEntityFile(
        limsEntityArtifactAdapter,
        fixture.original,
        fixture.path,
        100,
        fixture.ctx
      );
      expect(result.outcome).toBe('in-sync');
      expect(fsBridge.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
      const saved = JSON.parse(await readFile(fixture.path, 'utf8'));
      expect(saved).toMatchObject({
        schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
        schemaRevisionId: before!.schemaSnapshot.schemaRevisionId,
        schemaSnapshot: before!.schemaSnapshot,
        archived,
        fields: fixture.doc.fields,
        topExtension: { retained: true },
        source: { sourceExtension: ['unchanged'] },
      });
      expect(limsBridge.upgradeLegacyEntityArtifact).toHaveBeenCalledWith(
        expect.objectContaining({
          path: fixture.path,
          workspaceRoot: fixture.root,
          entityId: fixture.doc.id,
          workspaceId: fixture.ctx.workspaceId,
          expectedContentHash: await sha256Text(fixture.original),
        }),
        fixture.ctx.mutationToken
      );
      expect(await limsBridge.getRegistryPreview({ entityId: fixture.doc.id })).toEqual(before);
      if (archived) {
        await expect(
          limsEntityArtifactAdapter.reconcileRelationships!(
            parseEntityArtifact(fixture.original),
            fixture.doc.id,
            fixture.path,
            fixture.ctx
          )
        ).resolves.toBeUndefined();
      }

      const fresh = createLimsTestBridge();
      openDbs.push(fresh.db);
      limsBridge = fresh.lims;
      fresh.db
        .prepare(
          'INSERT INTO workspaces (id,name,path,created_at,last_opened_at) VALUES (7,?,?,1,1)'
        )
        .run('Fresh profile', fixture.root);
      await reconcileEntityFile(
        limsEntityArtifactAdapter,
        JSON.stringify(saved),
        fixture.path,
        100,
        fixture.ctx
      );
      const rebuilt = await limsBridge.getRegistryPreview({ entityId: fixture.doc.id });
      expect(rebuilt?.entity).toMatchObject({
        schemaRevisionId: saved.schemaRevisionId,
        tombstone: archived,
        fields: fixture.doc.fields,
        name: fixture.doc.name,
      });
      expect(rebuilt?.schemaSnapshot).toEqual(saved.schemaSnapshot);
    }
  );

  it.each([
    'unleased',
    'read-only',
    'archived-workspace',
    'developer-source',
    'divergent',
    'wrong-owner',
  ] as const)('leaves legacy source bytes unchanged for %s input', async (boundary) => {
    const fixture = await legacyOwnedFile();
    const ctx =
      boundary === 'unleased' ? { ...fixture.ctx, mutationToken: undefined } : fixture.ctx;
    if (boundary === 'read-only')
      openDbs[0].prepare("UPDATE workspaces SET access_mode = 'reference' WHERE id = 7").run();
    if (boundary === 'archived-workspace')
      openDbs[0].prepare('UPDATE workspaces SET archived_at = 1 WHERE id = 7').run();
    if (boundary === 'developer-source') {
      setRememberedDeveloperImportSourceRootsForRenderer([fixture.root]);
      openDbs[0]
        .prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,1)')
        .run('developer-import-source-roots', JSON.stringify([fixture.root]));
    }
    if (boundary === 'wrong-owner') fixture.ctx.workspaceId = 8;
    const bytes =
      boundary === 'divergent'
        ? fixture.original.replace('Legacy owned strain', 'Independent saved strain')
        : fixture.original;
    await writeFile(fixture.path, bytes);
    if (boundary === 'developer-source') {
      await reconcileEntityFile(limsEntityArtifactAdapter, bytes, fixture.path, 100, ctx);
    } else {
      await limsEntityArtifactAdapter.parseSource!(bytes, fixture.path, 100, ctx);
    }
    expect(await readFile(fixture.path, 'utf8')).toBe(bytes);
    expect(fsBridge.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
  });

  it('rejects a concurrent source change during the checked v1 publication', async () => {
    const fixture = await legacyOwnedFile();
    const newer = fixture.original.replace('Legacy owned strain', 'New external revision');
    const upgrade = limsBridge.upgradeLegacyEntityArtifact;
    limsBridge.upgradeLegacyEntityArtifact = vi.fn(async (input, token) => {
      await writeFile(input.path, newer);
      return upgrade(input, token);
    });
    await expect(
      reconcileEntityFile(
        limsEntityArtifactAdapter,
        fixture.original,
        fixture.path,
        100,
        fixture.ctx
      )
    ).rejects.toThrow(/changed|since|precondition/i);
    expect(await readFile(fixture.path, 'utf8')).toBe(newer);
    expect((await limsBridge.queryEntities({ id: fixture.doc.id }))[0].name).toBe(fixture.doc.name);
  });

  it('refuses a fresh legacy record whose lost frozen definition cannot be established', async () => {
    const fixture = await legacyOwnedFile();
    const bytes = fixture.original.replaceAll('legacy-owned', 'unknown-legacy-record');
    await expect(
      limsEntityArtifactAdapter.parseSource!(bytes, fixture.path, 100, fixture.ctx)
    ).rejects.toThrow(/no authoritative frozen schema revision/i);
    expect(fsBridge.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
  });
  it('does not replay outgoing relationships when the saved record is archived', async () => {
    const parent = artifact({ id: 'archived-links-parent', name: 'Archived links parent' });
    await reconcileEntityFile(
      limsEntityArtifactAdapter,
      serializeEntityArtifact(parent),
      '/ws/archived-links-parent.entity.json',
      1,
      { workspaceRoot: '/ws', workspaceId: 7 }
    );
    const doc = artifact({
      id: 'archived-links',
      name: 'Archived links',
      relationships: [
        {
          type: 'derives_from',
          fromEntityId: 'archived-links',
          toEntityId: parent.id,
          payload: { evidence: 'retained history' },
        },
      ],
    });
    await reconcileEntityFile(
      limsEntityArtifactAdapter,
      serializeEntityArtifact(doc),
      '/ws/archived-links.entity.json',
      1,
      { workspaceRoot: '/ws', workspaceId: 7 }
    );
    await limsEntityArtifactAdapter.reconcileRelationships!(
      doc,
      doc.id,
      '/ws/archived-links.entity.json',
      { workspaceRoot: '/ws', workspaceId: 7 }
    );
    await limsBridge.archiveEntity({ id: doc.id, actor: 'archive-regression' });
    const beforeLinks = openDbs[0].prepare('SELECT * FROM lims_link').all();
    expect(beforeLinks).toHaveLength(1);
    const beforeAudit = openDbs[0].prepare('SELECT * FROM lims_audit ORDER BY event_seq').all();

    await expect(
      limsEntityArtifactAdapter.reconcileRelationships?.(
        {
          ...doc,
          archived: true,
          relationships: [
            {
              type: 'derives_from',
              fromEntityId: doc.id,
              toEntityId: 'unavailable-parent',
              payload: { retained: true },
            },
          ],
        },
        doc.id,
        '/ws/archived-links.entity.json',
        { workspaceRoot: '/ws', workspaceId: 7 }
      )
    ).resolves.toBeUndefined();
    expect(openDbs[0].prepare('SELECT * FROM lims_link').all()).toEqual(beforeLinks);
    expect(openDbs[0].prepare('SELECT * FROM lims_audit ORDER BY event_seq').all()).toEqual(
      beforeAudit
    );
  });
  it('rebuilds an archived custom record in an empty Registry using only its frozen file definition', async () => {
    const doc = {
      ...artifact({ id: 'enzyme-a', name: 'Restriction enzyme' }),
      schema: 'waypoint.entity.v2',
      kind: 'enzyme',
      fields: { lot: 'Frozen lot' },
      archived: true,
      schemaRevisionId: 'enzyme-schema-v1',
      schemaSnapshot: {
        schemaId: 'enzyme-schema',
        schemaRevisionId: 'enzyme-schema-v1',
        name: 'enzyme',
        displayName: 'Enzyme',
        baseKind: 'record',
        version: 1,
        description: null,
        fields: [{ key: 'lot', label: 'Lot', type: 'text', required: true }],
      },
    };
    await reconcileEntityFile(
      limsEntityArtifactAdapter,
      JSON.stringify(doc),
      '/ws/enzyme.entity.json',
      1,
      { workspaceRoot: '/ws', workspaceId: 7 }
    );
    expect(await limsBridge.queryEntities({ id: doc.id })).toEqual([]);
    expect(await limsBridge.queryEntities({ id: doc.id, includeArchived: true })).toEqual([
      expect.objectContaining({
        id: doc.id,
        kind: 'enzyme',
        schemaRevisionId: 'enzyme-schema-v1',
        tombstone: true,
        fields: expect.objectContaining({ lot: 'Frozen lot' }),
      }),
    ]);
    const preview = await limsBridge.getRegistryPreview({ entityId: doc.id });
    expect(preview?.schemaSnapshot).toEqual(doc.schemaSnapshot);
  });
  it('rebuilds an absent Registry projection entirely from the managed file', async () => {
    const doc = artifact({ id: 'strain-a', name: 'DH5alpha' });
    const first = await reconcileEntityFile(
      limsEntityArtifactAdapter,
      serializeEntityArtifact(doc),
      '/ws/records/strain/DH5alpha.entity.json',
      Date.now() + 1_000,
      { workspaceRoot: '/ws', workspaceId: 7 }
    );
    expect(first.outcome).toBe('created');
    expect(await limsBridge.queryEntities({ id: 'strain-a' })).toEqual([
      expect.objectContaining({
        id: 'strain-a',
        kind: 'strain',
        name: 'DH5alpha',
        fields: expect.objectContaining({ genotypeCanonical: 'recA1' }),
        workspaceId: 7,
      }),
    ]);
  });

  it('repairs a legacy null workspace binding even when the projected content is already in sync', async () => {
    const doc = artifact({ id: 'strain-owned', name: 'Owned strain' });
    await limsBridge.registerEntity({
      id: doc.id,
      kind: doc.kind,
      name: doc.name,
      fields: doc.fields,
      registrationStatus: doc.registrationStatus,
      domainStatus: doc.domainStatus,
      workspaceId: 7,
      actor: 'legacy-projection',
    });
    openDbs[0].prepare('UPDATE lims_entity SET workspace_id = NULL WHERE id = ?').run(doc.id);

    const result = await reconcileEntityFile(
      limsEntityArtifactAdapter,
      serializeEntityArtifact(doc),
      '/ws/records/strain/Owned.entity.json',
      0,
      { workspaceRoot: '/ws', workspaceId: 7 }
    );

    expect(result.outcome).toBe('updated-from-file');
    await expect(limsBridge.queryEntities({ id: doc.id })).resolves.toEqual([
      expect.objectContaining({ id: doc.id, workspaceId: 7 }),
    ]);
  });

  it('rebinds a legacy archived projection before restoring it to the active Registry', async () => {
    const doc = artifact({ id: 'strain-archived', name: 'Archived strain' });
    await limsBridge.registerEntity({
      id: doc.id,
      kind: doc.kind,
      name: doc.name,
      fields: doc.fields,
      registrationStatus: doc.registrationStatus,
      domainStatus: doc.domainStatus,
      workspaceId: 7,
      actor: 'legacy-projection',
    });
    await limsBridge.archiveEntity({ id: doc.id, actor: 'legacy-projection' });

    openDbs[0].prepare('UPDATE lims_entity SET workspace_id = NULL WHERE id = ?').run(doc.id);

    const result = await reconcileEntityFile(
      limsEntityArtifactAdapter,
      serializeEntityArtifact(doc),
      '/ws/records/strain/Archived.entity.json',
      Date.now() + 1_000,
      { workspaceRoot: '/ws', workspaceId: 7 }
    );

    expect(result.outcome).toBe('updated-from-file');
    await expect(limsBridge.queryEntities({ id: doc.id })).resolves.toEqual([
      expect.objectContaining({ id: doc.id, workspaceId: 7, tombstone: false }),
    ]);
  });

  it('replaces outgoing relationships exactly, including payload edits and removals', async () => {
    const from = artifact({
      id: 'strain-child',
      name: 'Child',
      relationships: [
        {
          type: 'derives_from',
          fromEntityId: 'strain-child',
          toEntityId: 'strain-parent',
          payload: {},
        },
      ],
    });
    const parent = artifact({ id: 'strain-parent', name: 'Parent' });
    for (const doc of [from, parent]) {
      await reconcileEntityFile(
        limsEntityArtifactAdapter,
        serializeEntityArtifact(doc),
        `/ws/${doc.id}.entity.json`,
        Date.now() + 1_000,
        { workspaceRoot: '/ws', workspaceId: 7 }
      );
    }
    await limsEntityArtifactAdapter.reconcileRelationships?.(
      from,
      from.id,
      '/ws/strain-child.entity.json',
      { workspaceRoot: '/ws', workspaceId: 7 }
    );
    await limsEntityArtifactAdapter.reconcileRelationships?.(
      from,
      from.id,
      '/ws/strain-child.entity.json',
      { workspaceRoot: '/ws', workspaceId: 7 }
    );

    let rows = openDbs[0]
      .prepare(
        'SELECT from_entity_id, to_entity_id, type, payload FROM lims_link WHERE tombstone = 0'
      )
      .all();
    expect(rows).toEqual([
      {
        from_entity_id: 'strain-child',
        to_entity_id: 'strain-parent',
        type: 'derives_from',
        payload: '{}',
      },
    ]);

    const edited = artifact({
      id: 'strain-child',
      name: 'Child',
      relationships: [
        {
          type: 'derives_from',
          fromEntityId: 'strain-child',
          toEntityId: 'strain-parent',
          payload: { evidence: 'edited file' },
        },
      ],
    });
    await limsEntityArtifactAdapter.reconcileRelationships?.(
      edited,
      edited.id,
      '/ws/strain-child.entity.json',
      { workspaceRoot: '/ws', workspaceId: 7 }
    );
    rows = openDbs[0].prepare('SELECT payload FROM lims_link WHERE tombstone = 0').all();
    expect(rows).toEqual([{ payload: '{"evidence":"edited file"}' }]);

    const removed = artifact({ id: 'strain-child', name: 'Child' });
    await limsEntityArtifactAdapter.reconcileRelationships?.(
      removed,
      removed.id,
      '/ws/strain-child.entity.json',
      { workspaceRoot: '/ws', workspaceId: 7 }
    );
    expect(
      openDbs[0].prepare('SELECT COUNT(*) AS count FROM lims_link WHERE tombstone = 0').get()
    ).toEqual({ count: 0 });
    expect(
      openDbs[0]
        .prepare("SELECT COUNT(*) AS count FROM lims_audit WHERE event_type = 'link_updated'")
        .get()
    ).toEqual({ count: 1 });
  });
});
