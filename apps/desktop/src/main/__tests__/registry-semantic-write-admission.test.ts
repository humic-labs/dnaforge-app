import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  root: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(channel, handler),
  },
  app: {
    getPath: (name: string) => join(state.root, name),
    getVersion: () => '1.0.0',
    exit: vi.fn(),
  },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../ipc/database', () => ({ getDb: () => state.db! }));

import { createTestDb } from './test-db';
import { ensureSchema } from '../schema';
import {
  applyLimsImportBatchInDb,
  defineLimsSchemaInDb,
  getLimsRegistryPreviewInDb,
  registerLimsEntityInDb,
  registerLimsIpcHandlers,
} from '../lims';
import { withImportSourceMetadata } from '../lims-import';
import { derivePendingRefsInDb } from '../lims-pending-refs';
import { acquireWorkspaceSyncMutationLease } from '../workspace-sync-mutation-lease';
import { workspaceMutationCapabilities } from '../ipc/workspace-mutation-capability';
import {
  ENTITY_ARTIFACT_CURRENT_SCHEMA,
  serializeEntityArtifact,
} from '../../shared/entity-artifact';
import type { LimsApplyImportBatchInput, LimsRegisterEntityInput } from '../../shared/lims';

describe('Registry semantic mutation admission at native IPC', () => {
  const sender = Object.assign(new EventEmitter(), { id: 366165 });
  let project: string;
  let target: string;
  const entity = (id: string, kind = 'strain', workspaceId = 7): LimsRegisterEntityInput => ({
    id,
    kind,
    name: id,
    workspaceId,
    fields:
      kind === 'genome'
        ? { sequence: { mode: 'inline', bases: 'ATCG', length: 4, topology: 'linear' } }
        : { genotypeCanonical: 'wt' },
  });
  const batch = (
    id: string,
    extras: Partial<LimsApplyImportBatchInput['records'][number]> = {}
  ): LimsApplyImportBatchInput => ({
    batchId: `batch-${id}`,
    sourceName: 'fixture.csv',
    sourceKind: 'csv',
    records: [
      { id, action: 'register_entity', accepted: true, entity: entity(id), source: {}, ...extras },
    ],
  });
  const invoke = (name: string, input?: unknown) =>
    Promise.resolve(state.handlers.get(`lims:${name}`)!({ sender }, input));
  const snapshot = () =>
    ['lims_entity', 'lims_link', 'lims_schema', 'lims_schema_revision', 'lims_audit'].map((table) =>
      state.db!.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
    );

  beforeEach(() => {
    state.root = mkdtempSync(join(tmpdir(), 'dnaforge-registry-admission-'));
    project = join(state.root, 'owned');
    target = join(state.root, 'reference');
    mkdirSync(project);
    mkdirSync(target);
    state.db = createTestDb();
    ensureSchema(state.db, ':memory:');
    state.db
      .prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(7,?,?,1),(8,?,?,1)')
      .run('Owned', project, 'Reference', target);
    registerLimsEntityInDb(state.db, entity('source'));
    registerLimsEntityInDb(state.db, entity('target', 'genome', 8));
    registerLimsEntityInDb(state.db, entity('hypothesis', 'genome'));
    defineLimsSchemaInDb(state.db, {
      id: 'owned-schema',
      kind: 'entity',
      name: 'owned-custom',
      displayName: 'Owned',
      fields: [{ key: 'value', type: 'text', label: 'Value' }],
      workspaceId: 7,
    });
    state.handlers.clear();
    registerLimsIpcHandlers();
  });
  afterEach(() => {
    workspaceMutationCapabilities.releaseOwner(sender.id);
    state.db?.close();
    state.db = null;
    rmSync(state.root, { recursive: true, force: true });
  });

  it.each(['reference', 'archived', 'trashed'])(
    'refuses outgoing writes from a %s source before any semantic row changes',
    async (mode) => {
      state
        .db!.prepare(
          mode === 'reference'
            ? "UPDATE workspaces SET access_mode='reference' WHERE id=7"
            : `UPDATE workspaces SET ${mode === 'archived' ? 'archived_at' : 'trashed_at'}=1 WHERE id=7`
        )
        .run();
      const before = snapshot();
      await expect(
        invoke('linkEntities', {
          fromEntityId: 'source',
          toEntityId: 'target',
          type: 'references',
          actor: 'workspace-reconcile',
          workspaceId: 8,
        })
      ).rejects.toThrow(/WORKSPACE_(READ_ONLY|INACTIVE)|REGISTRY_OWNER/);
      expect(snapshot()).toEqual(before);
    }
  );

  it.each([
    [
      'defineSchema',
      {
        kind: 'entity',
        name: 'new-custom',
        displayName: 'New',
        fields: [{ key: 'value', type: 'text', label: 'Value' }],
        workspaceId: 7,
      },
    ],
    [
      'refineSchema',
      { schemaId: 'owned-schema', fields: [{ key: 'value', type: 'text', label: 'Value' }] },
    ],
    [
      'replaceOutgoingRelationships',
      { entityId: 'source', relationships: [{ toEntityId: 'target', type: 'references' }] },
    ],
    ['recordStrainParentGenome', { strainEntityId: 'source', parentGenomeEntityId: 'target' }],
    [
      'attachGenomeHypothesis',
      {
        strainEntityId: 'source',
        hypothesisGenomeEntityId: 'hypothesis',
        parentGenomeEntityId: 'target',
      },
    ],
    ['attachVerifiedGenome', { strainEntityId: 'source', verifiedGenomeEntityId: 'target' }],
  ])('refuses reference-project %s and keeps the audit unchanged', async (name, input) => {
    state.db!.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
    const before = snapshot();
    await expect(invoke(String(name), input)).rejects.toThrow(/WORKSPACE_READ_ONLY/);
    expect(snapshot()).toEqual(before);
  });

  it('refuses accepted import and undo mutations for a reference owner', async () => {
    applyLimsImportBatchInDb(state.db!, batch('undo-source'));
    state.db!.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
    const before = snapshot();
    await expect(invoke('applyImportBatch', batch('blocked-import'))).rejects.toThrow(
      /WORKSPACE_READ_ONLY/
    );
    await expect(invoke('undoImportBatch', { batchId: 'batch-undo-source' })).rejects.toThrow(
      /WORKSPACE_READ_ONLY/
    );
    expect(snapshot()).toEqual(before);
  });

  it('admits pending-reference decisions by their referrer owner, not their candidate target', async () => {
    applyLimsImportBatchInDb(
      state.db!,
      batch('referrer', {
        unresolvedLinks: [
          {
            type: 'references',
            kind: 'genome',
            label: 'target',
            severity: 'ambiguous',
            reason: 'Multiple genome records are named target',
          },
        ],
      })
    );
    const ref = derivePendingRefsInDb(state.db!)[0]!;
    state.db!.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
    const before = snapshot();
    for (const [name, input] of [
      ['confirmPendingRef', { key: ref.key, targetEntityId: 'target' }],
      ['rejectPendingRefCandidate', { key: ref.key, rejectedEntityId: 'target' }],
      ['dismissPendingRef', { key: ref.key }],
      ['restorePendingRef', { key: ref.key }],
    ] as const)
      await expect(invoke(name, input)).rejects.toThrow(/WORKSPACE_READ_ONLY/);
    expect(snapshot()).toEqual(before);
    state.db!.prepare("UPDATE workspaces SET access_mode='writable' WHERE id=7").run();
    state.db!.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=8").run();
    await expect(
      invoke('confirmPendingRef', { key: ref.key, targetEntityId: 'target' })
    ).resolves.toBeUndefined();
  });

  it('retains writable source links to readable reference targets and global configuration', async () => {
    state.db!.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=8").run();
    await expect(
      invoke('linkEntities', { fromEntityId: 'source', toEntityId: 'target', type: 'references' })
    ).resolves.toMatchObject({ fromEntityId: 'source', toEntityId: 'target' });
    await expect(
      invoke('setIdScheme', { kind: 'strain', prefix: 'S', padWidth: 4 })
    ).resolves.toBeDefined();
    state.db!.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
    await expect(invoke('ensureSeeded')).resolves.toBeUndefined();
    await expect(
      invoke('logTelemetry', { eventType: 'badge_consulted', workspaceId: 7 })
    ).resolves.toMatchObject({ event_type: 'badge_consulted' });
  });

  it('revalidates source access after a queued relationship mutation', async () => {
    const release = await acquireWorkspaceSyncMutationLease(project);
    const pending = invoke('linkEntities', {
      fromEntityId: 'source',
      toEntityId: 'target',
      type: 'references',
    });
    await Promise.resolve();
    state.db!.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
    release();
    await expect(pending).rejects.toThrow(/WORKSPACE_READ_ONLY/);
    expect(
      state.db!.prepare("SELECT id FROM lims_link WHERE from_entity_id='source'").get()
    ).toBeUndefined();
  });

  it('refuses low-level relationship authoring for file-owned sources but admits exact file reconstruction', async () => {
    const fields = {
      genotypeCanonical: 'wt',
      artifact: { schema: ENTITY_ARTIFACT_CURRENT_SCHEMA, relativePath: 'owned.entity.json' },
    };
    const source = registerLimsEntityInDb(state.db!, { ...entity('file-source'), fields });
    const schemaSnapshot = getLimsRegistryPreviewInDb(state.db!, {
      entityId: source.id,
    })!.schemaSnapshot;
    const relationships = [
      { fromEntityId: source.id, toEntityId: 'target', type: 'references', payload: {} },
    ];
    const content = serializeEntityArtifact({
      schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
      id: source.id,
      kind: 'strain',
      name: source.name,
      fields,
      registrationStatus: source.registrationStatus,
      domainStatus: source.domainStatus,
      relationships,
      schemaRevisionId: schemaSnapshot.schemaRevisionId,
      schemaSnapshot,
      archived: false,
      source: { type: 'manual', values: {} },
    });
    const path = join(project, 'owned.entity.json');
    writeFileSync(path, content);
    await expect(
      invoke('linkEntities', { fromEntityId: source.id, toEntityId: 'target', type: 'references' })
    ).rejects.toThrow(/owning|file|authorit/i);
    await expect(
      invoke('replaceOutgoingRelationships', {
        entityId: source.id,
        relationships: [],
        actor: 'workspace-reconcile',
      })
    ).rejects.toThrow(/file|source|authorit/i);
    await expect(
      invoke('replaceOutgoingRelationships', {
        entityId: source.id,
        relationships: [{ toEntityId: 'target', type: 'references', payload: {} }],
        schemaSnapshots: [{ name: 'references', fields: [{ key: 'injected', type: 'text' }] }],
      })
    ).rejects.toThrow(/schema.*source/);
    state.db!.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
    await expect(
      invoke('replaceOutgoingRelationships', {
        entityId: source.id,
        relationships: [{ toEntityId: 'target', type: 'references', payload: {} }],
        workspaceId: 7,
      })
    ).resolves.toMatchObject({ active: [{ fromEntityId: source.id, toEntityId: 'target' }] });
    expect(readFileSync(path, 'utf8')).toBe(content);
    state.db!.prepare("UPDATE workspaces SET access_mode='writable' WHERE id=7").run();
    const legacy = batch('legacy-linked-record', {
      links: [{ fromEntityId: source.id, type: 'associated_with', payload: {} }],
    });
    applyLimsImportBatchInDb(state.db!, legacy);
    const before = snapshot();
    await expect(invoke('undoImportBatch', { batchId: legacy.batchId })).rejects.toThrow(
      /authoritative file/
    );
    expect(snapshot()).toEqual(before);
  });
  it('keeps owned file import and native Undo on the authoritative record writer', async () => {
    const schemaSnapshot = getLimsRegistryPreviewInDb(state.db!, {
      entityId: 'source',
    })!.schemaSnapshot;
    const input = batch('file-import');
    const record = input.records[0];
    record.entity = {
      ...record.entity,
      schemaRevisionId: schemaSnapshot.schemaRevisionId,
      schemaSnapshot,
      fields: {
        ...record.entity.fields,
        artifact: { schema: ENTITY_ARTIFACT_CURRENT_SCHEMA, relativePath: 'import.entity.json' },
      },
    };
    record.entity = withImportSourceMetadata(record, input);
    record.links = [{ type: 'references', toEntityId: 'target', payload: {} }];
    const content = serializeEntityArtifact({
      schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
      id: 'file-import',
      kind: 'strain',
      name: 'file-import',
      fields: record.entity.fields,
      registrationStatus: 'registered',
      domainStatus: null,
      relationships: [
        { fromEntityId: 'file-import', toEntityId: 'target', type: 'references', payload: {} },
      ],
      schemaRevisionId: schemaSnapshot.schemaRevisionId,
      schemaSnapshot,
      archived: false,
      source: { type: 'manual', values: {} },
    });
    const path = join(project, 'import.entity.json');
    writeFileSync(path, content);
    state.db!.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=8").run();
    await expect(invoke('applyImportBatch', input)).resolves.toMatchObject({
      insertedEntities: 1,
      insertedLinks: 1,
    });
    expect(readFileSync(path, 'utf8')).toBe(content);
    await expect(invoke('undoImportBatch', { batchId: input.batchId })).resolves.toMatchObject({
      tombstonedEntities: 1,
      tombstonedLinks: 1,
    });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      id: 'file-import',
      archived: true,
    });
  });
  it('refuses semantic audit injection through the telemetry maintenance route', async () => {
    state.db!.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
    const before = snapshot();
    await expect(
      invoke('logTelemetry', {
        eventType: 'pending_ref_dismissed',
        subjectTable: 'lims_pending_ref',
        subjectId: 'forged',
        payload: { refKey: 'forged' },
        workspaceId: 7,
      })
    ).rejects.toThrow(/telemetry.*semantic/);
    expect(snapshot()).toEqual(before);
  });
});
