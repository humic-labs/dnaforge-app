import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import type Database from 'better-sqlite3';

import { ensureSchema } from '../schema';
import { createTestDb } from './test-db';
import { upsertProviderBinding } from '../catalog-provider-bindings';
import {
  allowedWorkspaceIds,
  destinationWorkspaceId,
  resolveStoredProviderReference,
  visibleRegistryEntityIds,
} from '../provider-reference-service';
import type { ProviderObjectReference } from '../../shared/provider-object-reference';

const INTENDED = 'seq_DemoSeq004';
const TWIN = 'seq_DEMOSQ0004';
const NOTEBOOK_B = 'etr_DEMOET0004';

const DESTINATION_ROOT = '/lab/destination';
const OTHER_ROOT = '/lab/other';
const TRASHED_ROOT = '/lab/trashed';

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

function seedWorkspace(
  id: number,
  path: string,
  options: { archived?: boolean; trashed?: boolean } = {}
): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, path, created_at, last_opened_at, archived_at, trashed_at)
     VALUES (?, ?, ?, 0, 0, ?, ?)`
  ).run(id, path, path, options.archived ? 1 : null, options.trashed ? 1 : null);
}

function seedEntity(
  id: string,
  workspaceId: number | null,
  options: { name?: string; type?: string; status?: string } = {}
): void {
  db.prepare(
    `INSERT INTO catalog_entities
       (id, type, name, locator, storage_type, status, workspace_id, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'file', ?, ?, NULL, 0, 0)`
  ).run(
    id,
    options.type ?? 'sequence',
    options.name ?? 'Controlled Corpus Sequence — duplicate display name',
    `file:///lab/${id}.gb`,
    options.status ?? 'active',
    workspaceId
  );
}

function bind(entityId: string, stableObjectId = INTENDED, objectClass = 'sequence'): void {
  upsertProviderBinding(db, {
    reference: reference({
      stableObjectId,
      objectClass: objectClass as ProviderObjectReference['objectClass'],
    }),
    entityId,
    bindingKind: 'observed',
    evidence: { source: 'benchling_export_filename' },
  });
}

function resolve(overrides: Partial<Parameters<typeof resolveStoredProviderReference>[1]> = {}) {
  return resolveStoredProviderReference(db, {
    workspaceRoot: DESTINATION_ROOT,
    reference: reference(),
    ...overrides,
  });
}

beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  db.pragma('foreign_keys = ON');
  seedWorkspace(1, DESTINATION_ROOT);
  seedWorkspace(2, OTHER_ROOT);
  seedWorkspace(3, TRASHED_ROOT, { trashed: true });
});

describe('allowed scopes', () => {
  it('excludes trashed and archived workspaces', () => {
    seedWorkspace(4, '/lab/archived', { archived: true });
    expect(allowedWorkspaceIds(db)).toEqual([1, 2]);
  });

  it('does not treat a trashed workspace root as a destination', () => {
    expect(destinationWorkspaceId(db, TRASHED_ROOT)).toBeNull();
  });

  it('does not treat an unknown root as a destination', () => {
    expect(destinationWorkspaceId(db, '/lab/forged')).toBeNull();
  });

  it('counts only active registry entities as visible', () => {
    seedEntity('registry-active', null);
    seedEntity('registry-archived', null, { status: 'archived' });
    expect(visibleRegistryEntityIds(db)).toEqual(['registry-active']);
  });
});

describe('resolveStoredProviderReference', () => {
  it('resolves to the destination-workspace entity and describes it safely', () => {
    seedEntity('entity-intended', 1, { name: 'Corpus sequence', type: 'sequence' });
    bind('entity-intended');

    const view = resolve();
    expect(view.resolution).toMatchObject({ status: 'resolved', entityId: 'entity-intended' });
    expect(view.target).toEqual({
      entityId: 'entity-intended',
      title: 'Corpus sequence',
      entityType: 'sequence',
      scope: 'workspace',
    });
  });

  it('reuses an exact target that lives in another mounted workspace', () => {
    seedEntity('entity-elsewhere', 2);
    bind('entity-elsewhere');
    expect(resolve().resolution).toMatchObject({
      status: 'resolved',
      entityId: 'entity-elsewhere',
    });
  });

  it('stays pending when the only match is in a trashed workspace', () => {
    seedEntity('entity-trashed', 3);
    bind('entity-trashed');
    expect(resolve().resolution).toEqual({ status: 'pending', reason: 'target_not_imported' });
  });

  it('stays pending when nothing has been imported yet', () => {
    expect(resolve().resolution).toEqual({ status: 'pending', reason: 'target_not_imported' });
  });

  it('is review-required when the stored reference carries no usable identity', () => {
    seedEntity('entity-intended', 1);
    bind('entity-intended');
    expect(
      resolve({ reference: { provider: 'benchling', stableObjectId: 'seq_x' } }).resolution
    ).toEqual({ status: 'pending', reason: 'identity_missing' });
  });

  it('never resolves the intended target to its byte-identical twin', () => {
    seedEntity('entity-twin', 1);
    bind('entity-twin', TWIN);
    expect(resolve().resolution).toEqual({ status: 'pending', reason: 'target_not_imported' });
  });

  it('resolves a notebook-to-notebook reference', () => {
    seedEntity('entity-notebook-b', 1, { name: 'Corpus B', type: 'notebook' });
    bind('entity-notebook-b', NOTEBOOK_B, 'notebook');
    const view = resolve({
      reference: reference({ stableObjectId: NOTEBOOK_B, objectClass: 'notebook' }),
    });
    expect(view.resolution).toMatchObject({ status: 'resolved', entityId: 'entity-notebook-b' });
    expect(view.target).toMatchObject({ entityType: 'notebook', title: 'Corpus B' });
  });

  it('reports ambiguity rather than choosing between two allowed entities', () => {
    seedEntity('entity-a', 1);
    seedEntity('entity-b', 2);
    bind('entity-b');
    bind('entity-a');
    db.prepare('UPDATE catalog_entities SET workspace_id = 2 WHERE id = ?').run('entity-a');
    expect(resolve().resolution).toMatchObject({
      status: 'ambiguous',
      reason: 'multiple_exact_candidates',
    });
  });

  it('returns to an honest unavailable state when the resolved entity is hidden', () => {
    seedEntity('entity-intended', 1);
    bind('entity-intended');
    expect(resolve().resolution).toMatchObject({ status: 'resolved' });

    db.prepare('UPDATE catalog_entities SET status = ? WHERE id = ?').run(
      'archived',
      'entity-intended'
    );
    const view = resolve();
    expect(view.resolution).toEqual({ status: 'pending', reason: 'target_not_imported' });
    expect(view.target).toBeNull();
  });

  it('preserves an external reference without consulting the catalog', () => {
    seedEntity('entity-intended', 1);
    bind('entity-intended');
    const view = resolve({
      disposition: 'external',
      sourceUrl: 'https://benchling.com/exampleowner/f/lib_x/ent_DemoEnt1-person/edit',
    });
    expect(view.resolution).toMatchObject({ status: 'external' });
    expect(view.target).toBeNull();
  });

  it('refuses an unsafe external URL from a hand-edited notebook', () => {
    const view = resolve({
      disposition: 'external',
      sourceUrl: 'javascript:alert(document.domain)',
    });
    expect(view.resolution).toEqual({ status: 'pending', reason: 'identity_missing' });
    expect(view.target).toBeNull();
  });

  it('preserves a source-broken reference', () => {
    const view = resolve({
      disposition: 'source_broken',
      brokenReason: 'The export recorded a broken link.',
    });
    expect(view.resolution).toEqual({
      status: 'source_broken',
      reason: 'The export recorded a broken link.',
    });
  });

  it('refuses to widen scope from an unknown workspace root', () => {
    seedEntity('entity-intended', 1);
    bind('entity-intended');
    seedEntity('entity-trashed', 3, { name: 'Trashed twin' });
    bind('entity-trashed');
    const view = resolveStoredProviderReference(db, {
      workspaceRoot: '/lab/forged',
      reference: reference(),
    });
    expect(view.resolution).toMatchObject({ status: 'resolved', entityId: 'entity-intended' });
  });
});
