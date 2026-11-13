import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import type Database from 'better-sqlite3';

import { ensureSchema } from '../schema';
import { createTestDb } from './test-db';
import {
  materializeNativeWorkspaceInsideTx,
  NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
  type NativeWorkspaceEntityInput,
  type NativeWorkspaceMaterializationPlan,
} from '../native-workspace-materializer';
import { resolveStoredProviderReference } from '../provider-reference-service';
import { listProviderBindingsForEntity } from '../catalog-provider-bindings';
import type { NativeWorkspaceManifestSourceIdentity } from '../../shared/native-workspace-manifest';

const INTENDED = 'seq_DEMOSQ0005';
const TWIN = 'seq_DEMOSQ0004';
const NOTEBOOK_B = 'etr_DEMOET0004';

const WORKSPACE_ROOT = '/lab/destination';
const REPO_UUID = 'repo-destination';

let db: Database.Database;

const workspace = {
  path: WORKSPACE_ROOT,
  name: 'destination',
  repoUuid: REPO_UUID,
  createdAt: 1_700_000_000_000,
  lastOpenedAt: 1_700_000_000_000,
};

function identity(
  stableObjectId: string,
  objectClass: NativeWorkspaceManifestSourceIdentity['objectClass']
): NativeWorkspaceManifestSourceIdentity {
  return { provider: 'benchling', stableObjectId, objectClass, bindingKind: 'observed' };
}

function sequenceEntity(
  rawId: string,
  relativePath: string,
  identities: NativeWorkspaceManifestSourceIdentity[]
): NativeWorkspaceEntityInput {
  return {
    rawId,
    type: 'sequence',
    name: 'Controlled Corpus Sequence — duplicate display name',
    locator: { kind: 'file' },
    storageType: 'file',
    relativePath,
    fileKind: 'genbank',
    contentHash: 'sha256:54457839a66fcff4108686528ab2dc866b77de9e4602c8ce1d1655daae3051a9',
    sourceIdentities: identities,
  };
}

function plan(entities: NativeWorkspaceEntityInput[]): NativeWorkspaceMaterializationPlan {
  return {
    schema: NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
    entities,
    links: [],
    events: [],
  };
}

function materialize(entities: NativeWorkspaceEntityInput[]) {
  const run = db.transaction(() =>
    materializeNativeWorkspaceInsideTx(db, { workspace, plan: plan(entities) })
  );
  return run();
}

function resolve(stableObjectId: string, objectClass: 'sequence' | 'notebook' = 'sequence') {
  return resolveStoredProviderReference(db, {
    workspaceRoot: WORKSPACE_ROOT,
    reference: {
      provider: 'benchling',
      stableObjectId,
      objectClass,
      canonicalUrl: null,
      providerAccountHint: null,
    },
  });
}

beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  db.pragma('foreign_keys = ON');
});

describe('materialization writes durable provider bindings', () => {
  it('makes an imported sequence resolvable by its Benchling stable ID', () => {
    const result = materialize([
      sequenceEntity('sequence-intended', 'Sequences/intended.gb', [
        identity(INTENDED, 'sequence'),
      ]),
    ]);
    expect(result.providerBindingsMaterialized).toBe(1);

    const view = resolve(INTENDED);
    expect(view.resolution).toMatchObject({ status: 'resolved', scope: 'workspace' });
    expect(view.target?.entityId).toBe(result.entityIdsByRawId['sequence-intended']);
  });

  it('binds the twin to its own entity and never to the intended target', () => {
    const result = materialize([
      sequenceEntity('sequence-intended', 'Sequences/intended.gb', [
        identity(INTENDED, 'sequence'),
      ]),
      sequenceEntity('sequence-twin', 'Sequences/twin.gb', [identity(TWIN, 'sequence')]),
    ]);
    expect(result.providerBindingsMaterialized).toBe(2);

    expect(resolve(INTENDED).target?.entityId).toBe(result.entityIdsByRawId['sequence-intended']);
    expect(resolve(TWIN).target?.entityId).toBe(result.entityIdsByRawId['sequence-twin']);
    expect(resolve(INTENDED).target?.entityId).not.toBe(resolve(TWIN).target?.entityId);
  });

  it('leaves a reference pending when only the twin was imported', () => {
    materialize([
      sequenceEntity('sequence-twin', 'Sequences/twin.gb', [identity(TWIN, 'sequence')]),
    ]);
    expect(resolve(INTENDED).resolution).toEqual({
      status: 'pending',
      reason: 'target_not_imported',
    });
  });

  it('records no binding for a target whose export carried no exact stable ID', () => {
    const result = materialize([sequenceEntity('sequence-stripped', 'Sequences/stripped.gb', [])]);
    expect(result.providerBindingsMaterialized).toBe(0);
    expect(result.entityIdsByRawId['sequence-stripped']).toBeTruthy();
    expect(resolve(INTENDED).resolution).toMatchObject({ status: 'pending' });
  });

  it('is idempotent across a repeated import of the same export', () => {
    const first = materialize([
      sequenceEntity('sequence-intended', 'Sequences/intended.gb', [
        identity(INTENDED, 'sequence'),
      ]),
    ]);
    const second = materialize([
      sequenceEntity('sequence-intended', 'Sequences/intended.gb', [
        identity(INTENDED, 'sequence'),
      ]),
    ]);
    expect(second.entityIdsByRawId['sequence-intended']).toBe(
      first.entityIdsByRawId['sequence-intended']
    );
    expect(
      listProviderBindingsForEntity(db, first.entityIdsByRawId['sequence-intended'])
    ).toHaveLength(1);
    expect(resolve(INTENDED).resolution).toMatchObject({ status: 'resolved' });
  });

  it('resolves a notebook-to-notebook reference to the notebook entity', () => {
    materialize([
      {
        rawId: 'notebook-b',
        type: 'notebook',
        name: 'Controlled Corpus B',
        locator: { kind: 'entity', namespace: 'page' },
        storageType: 'database',
        relativePath: 'Notebooks/corpus-b',
        fileKind: 'notebook',
        sourceIdentities: [identity(NOTEBOOK_B, 'notebook')],
      },
    ]);
    const view = resolve(NOTEBOOK_B, 'notebook');
    expect(view.resolution).toMatchObject({ status: 'resolved' });
    expect(view.target?.entityType).toBe('notebook');
  });

  it('never satisfies a sequence reference with a notebook of the same ID', () => {
    materialize([
      {
        rawId: 'notebook-b',
        type: 'notebook',
        name: 'Controlled Corpus B',
        locator: { kind: 'entity', namespace: 'page' },
        storageType: 'database',
        relativePath: 'Notebooks/corpus-b',
        fileKind: 'notebook',
        sourceIdentities: [identity(NOTEBOOK_B, 'notebook')],
      },
    ]);
    expect(resolve(NOTEBOOK_B, 'sequence').resolution).toEqual({
      status: 'pending',
      reason: 'target_not_imported',
    });
  });

  it('rolls the binding back with the entity when the transaction fails', () => {
    expect(() =>
      db.transaction(() => {
        materializeNativeWorkspaceInsideTx(db, {
          workspace,
          plan: plan([
            sequenceEntity('sequence-intended', 'Sequences/intended.gb', [
              identity(INTENDED, 'sequence'),
            ]),
          ]),
        });
        throw new Error('import failed after materialization');
      })()
    ).toThrow(/import failed/);

    expect(
      (
        db.prepare('SELECT COUNT(*) AS count FROM catalog_provider_bindings').get() as {
          count: number;
        }
      ).count
    ).toBe(0);
    expect(resolve(INTENDED).resolution).toMatchObject({ status: 'pending' });
  });
});
