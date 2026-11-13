import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import type Database from 'better-sqlite3';

import { ensureSchema } from '../schema';
import { createTestDb } from './test-db';
import {
  listProviderBindingsForEntity,
  listProviderBindingsForIdentity,
  queryProviderBindingCandidates,
  upsertProviderBinding,
} from '../catalog-provider-bindings';
import { resolveProviderReference } from '../benchling-migration/provider-reference-resolver';
import type { ProviderObjectReference } from '../../shared/provider-object-reference';

const INTENDED = 'seq_DemoSeq004';
const TWIN = 'seq_DEMOSQ0004';

const DESTINATION = 1;
const OTHER = 2;
const UNMOUNTED = 3;

let db: Database.Database;

function reference(overrides: Partial<ProviderObjectReference> = {}): ProviderObjectReference {
  return {
    provider: 'benchling',
    stableObjectId: INTENDED,
    objectClass: 'sequence',
    canonicalUrl: null,
    providerAccountHint: null,
    ...overrides,
  };
}

function seedWorkspace(id: number, name: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, path, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, name, `/lab/${name}`, 0, 0);
}

function seedEntity(id: string, workspaceId: number | null, status = 'active'): void {
  db.prepare(
    `INSERT INTO catalog_entities
       (id, type, name, locator, storage_type, status, workspace_id, metadata, created_at, updated_at)
     VALUES (?, 'sequence', ?, ?, 'file', ?, ?, NULL, 0, 0)`
  ).run(
    id,
    'Controlled Corpus Sequence — duplicate display name',
    `file:///lab/${id}.gb`,
    status,
    workspaceId
  );
}

function bind(
  entityId: string,
  overrides: {
    reference?: Partial<ProviderObjectReference>;
    bindingKind?: 'observed' | 'reviewed';
    conflict?: string;
  } = {}
): void {
  upsertProviderBinding(db, {
    reference: reference(overrides.reference),
    entityId,
    bindingKind: overrides.bindingKind ?? 'observed',
    evidence: {
      source: 'benchling_export_filename',
      ...(overrides.conflict ? { conflict: overrides.conflict } : {}),
    },
  });
}

function bindingRowCount(): number {
  return (
    db.prepare('SELECT COUNT(*) AS count FROM catalog_provider_bindings').get() as {
      count: number;
    }
  ).count;
}

function candidates(overrides: Partial<Parameters<typeof queryProviderBindingCandidates>[1]> = {}) {
  return queryProviderBindingCandidates(db, {
    provider: 'benchling',
    stableObjectId: INTENDED,
    objectClass: 'sequence',
    allowedWorkspaceIds: [DESTINATION],
    allowedRegistryEntityIds: [],
    ...overrides,
  });
}

beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  db.pragma('foreign_keys = ON');
  seedWorkspace(DESTINATION, 'destination');
  seedWorkspace(OTHER, 'other');
  seedWorkspace(UNMOUNTED, 'unmounted');
});

describe('catalog provider bindings — writes', () => {
  it('records and reads back an observed binding', () => {
    seedEntity('entity-intended', DESTINATION);
    upsertProviderBinding(db, {
      reference: reference({
        canonicalUrl: 'https://benchling.com/exampleowner/f/lib_x/seq_DemoSeq004-y/edit',
        providerAccountHint: 'pnciaccia',
      }),
      entityId: 'entity-intended',
      bindingKind: 'observed',
      evidence: { source: 'benchling_export_filename', runId: 'migration-1' },
    });

    const rows = listProviderBindingsForEntity(db, 'entity-intended');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'benchling',
      stable_object_id: INTENDED,
      object_class: 'sequence',
      binding_kind: 'observed',
      provider_account_hint: 'pnciaccia',
    });
    expect(JSON.parse(rows[0].evidence_json)).toMatchObject({
      source: 'benchling_export_filename',
      runId: 'migration-1',
    });
  });

  it('is idempotent, so a repeated import never turns one link into ambiguity', () => {
    seedEntity('entity-intended', DESTINATION);
    for (let attempt = 0; attempt < 3; attempt += 1) bind('entity-intended');
    expect(bindingRowCount()).toBe(1);
    expect(
      resolveProviderReference({
        reference: reference(),
        destinationWorkspaceId: String(DESTINATION),
        allowedWorkspaceIds: [String(DESTINATION)],
        candidates: candidates(),
      })
    ).toMatchObject({ status: 'resolved', entityId: 'entity-intended' });
  });

  it('upgrades an observed binding to reviewed without duplicating the row', () => {
    seedEntity('entity-intended', DESTINATION);
    bind('entity-intended', { bindingKind: 'observed' });
    bind('entity-intended', { bindingKind: 'reviewed' });
    expect(bindingRowCount()).toBe(1);
    expect(listProviderBindingsForEntity(db, 'entity-intended')[0].binding_kind).toBe('reviewed');
    expect(
      resolveProviderReference({
        reference: reference(),
        destinationWorkspaceId: String(DESTINATION),
        allowedWorkspaceIds: [String(DESTINATION)],
        candidates: candidates(),
      })
    ).toMatchObject({ evidence: 'reviewed_mapping' });
  });

  it('keeps one provider object bound in several workspaces', () => {
    seedEntity('entity-local', DESTINATION);
    seedEntity('entity-elsewhere', OTHER);
    bind('entity-local');
    bind('entity-elsewhere');
    expect(bindingRowCount()).toBe(2);
    expect(listProviderBindingsForIdentity(db, 'benchling', INTENDED, 'sequence')).toHaveLength(2);
  });

  it('cascades bindings away when the catalog entity is deleted', () => {
    seedEntity('entity-intended', DESTINATION);
    bind('entity-intended');
    expect(bindingRowCount()).toBe(1);
    db.prepare('DELETE FROM catalog_entities WHERE id = ?').run('entity-intended');
    expect(bindingRowCount()).toBe(0);
  });

  it('refuses a binding for something that is not an exact stable ID', () => {
    seedEntity('entity-intended', DESTINATION);
    expect(() => bind('entity-intended', { reference: { stableObjectId: 'seq_x' } })).toThrow(
      /exact provider stable object ID/i
    );
    expect(bindingRowCount()).toBe(0);
  });

  it('refuses a binding whose entity does not exist', () => {
    expect(() => bind('entity-that-never-existed')).toThrow();
  });
});

describe('catalog provider bindings — bounded lookup', () => {
  it('never returns an entity in a workspace the caller did not allow', () => {
    seedEntity('entity-unmounted', UNMOUNTED);
    bind('entity-unmounted');
    expect(candidates({ allowedWorkspaceIds: [DESTINATION, OTHER] })).toEqual([]);
  });

  it.each(['archived', 'missing', 'conflict'])('never returns a %s entity', (status) => {
    seedEntity('entity-inactive', DESTINATION, status);
    bind('entity-inactive');
    expect(candidates()).toEqual([]);
  });

  it('returns nothing when no scope is allowed, rather than everything', () => {
    seedEntity('entity-intended', DESTINATION);
    bind('entity-intended');
    expect(candidates({ allowedWorkspaceIds: [], allowedRegistryEntityIds: [] })).toEqual([]);
  });

  it('never matches across object classes', () => {
    seedEntity('entity-intended', DESTINATION);
    bind('entity-intended');
    expect(candidates({ objectClass: 'notebook' })).toEqual([]);
  });

  it('never matches another provider', () => {
    seedEntity('entity-intended', DESTINATION);
    bind('entity-intended');
    expect(candidates({ provider: 'notion' })).toEqual([]);
  });

  it('returns a registry candidate only when its entity is currently visible', () => {
    seedEntity('registry-entity', null);
    bind('registry-entity');
    expect(candidates()).toEqual([]);

    const visible = candidates({ allowedRegistryEntityIds: ['registry-entity'] });
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ entityId: 'registry-entity', scope: 'registry' });
  });

  it('returns every allowed candidate so the caller sees ambiguity, not the first row', () => {
    seedEntity('entity-a', DESTINATION);
    seedEntity('entity-b', OTHER);
    bind('entity-b');
    bind('entity-a');
    const rows = candidates({ allowedWorkspaceIds: [DESTINATION, OTHER] });
    expect(rows.map((row) => row.entityId)).toEqual(['entity-a', 'entity-b']);
    expect(
      resolveProviderReference({
        reference: reference(),
        allowedWorkspaceIds: [String(DESTINATION), String(OTHER)],
        candidates: rows,
      })
    ).toMatchObject({ status: 'ambiguous', reason: 'multiple_exact_candidates' });
  });

  it('surfaces a recorded corroboration conflict as a conflict rather than a match', () => {
    seedEntity('entity-intended', DESTINATION);
    bind('entity-intended', {
      conflict: 'The exported content hash disagrees with the previously bound object.',
    });
    const rows = candidates();
    expect(rows[0]).toMatchObject({ corroborationConflict: true });
    expect(
      resolveProviderReference({
        reference: reference(),
        destinationWorkspaceId: String(DESTINATION),
        allowedWorkspaceIds: [String(DESTINATION)],
        candidates: rows,
      })
    ).toMatchObject({ status: 'ambiguous', reason: 'identity_conflict' });
  });

  it('survives unreadable evidence instead of dropping the binding', () => {
    seedEntity('entity-intended', DESTINATION);
    bind('entity-intended');
    db.prepare('UPDATE catalog_provider_bindings SET evidence_json = ?').run('not json');
    expect(candidates()).toHaveLength(1);
  });

  it('keeps the twin and the intended target on separate identities end to end', () => {
    seedEntity('entity-intended', DESTINATION);
    seedEntity('entity-twin', DESTINATION);
    bind('entity-intended');
    bind('entity-twin', { reference: { stableObjectId: TWIN } });

    for (const [stableObjectId, expected] of [
      [INTENDED, 'entity-intended'],
      [TWIN, 'entity-twin'],
    ] as const) {
      expect(candidates({ stableObjectId }).map((row) => row.entityId)).toEqual([expected]);
    }
  });

  it('uses the identity index rather than scanning every binding', () => {
    seedEntity('entity-intended', DESTINATION);
    bind('entity-intended');
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT b.* FROM catalog_provider_bindings b
          JOIN catalog_entities e ON e.id = b.entity_id
          WHERE b.provider = ? AND b.stable_object_id = ? AND b.object_class = ?`
      )
      .all('benchling', INTENDED, 'sequence') as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(' ')).toContain(
      'idx_catalog_provider_bindings_identity'
    );
  });
});
