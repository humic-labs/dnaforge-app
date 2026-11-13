import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SourceObject } from '../../shared/benchling-migration';
import { ensureSchema } from '../schema';
import { createTestDb } from '../__tests__/test-db';
import { providerBindingRowId, upsertProviderBinding } from '../catalog-provider-bindings';
import { buildDestinationInventory, linkReviewedExactNativeMatch } from './destination-inventory';
import { dnaBasesScientificFingerprint } from './native-exact-match';

const WORKSPACE_ID = 1;

function sequence(id: string, bases: string, name = id): SourceObject {
  return {
    id,
    stableId: id,
    aliases: [],
    sourceType: 'dna_sequence',
    name,
    sourceUrl: `https://benchling.com/example/${id}`,
    sourcePath: `${name} (${id}).gb`,
    content: { moleculeType: 'DNA', bases, topology: 'linear', annotations: [] },
    attachmentHashes: [],
    memberships: [],
    relationships: [],
    metadata: {},
  };
}

describe('destination inventory', () => {
  let db: Database.Database;
  let workspacePath: string;

  beforeEach(async () => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    db.pragma('foreign_keys = ON');
    workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-destination-inventory-'));
    db.prepare(
      `INSERT INTO workspaces
         (id, name, path, created_at, last_opened_at)
       VALUES (?, 'Destination', ?, 0, 0)`
    ).run(WORKSPACE_ID, workspacePath);
    seedLimsSchema(db);
  });

  afterEach(async () => {
    db.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('classifies active, ambiguous, stale, exact-native, and unrelated destination state', async () => {
    await mkdir(join(workspacePath, 'Designs'), { recursive: true });
    const activeFilePath = join(workspacePath, 'Designs', 'Active.gb');
    await writeFile(activeFilePath, 'LOCUS active');

    seedEntity(db, {
      id: 'entity-active-file',
      name: 'Active file',
      storageType: 'file',
    });
    seedCurrentFile(db, 'entity-active-file', activeFilePath, 'Designs/Active.gb');
    seedLimsDna(db, 'entity-active-file', 'ACGT');
    bind(db, 'entity-active-file', 'seq_FILE001');

    seedEntity(db, { id: 'entity-active-catalog', name: 'Active catalog' });
    seedLimsDna(db, 'entity-active-catalog', 'CCCC');
    bind(db, 'entity-active-catalog', 'seq_CAT0001');

    for (const id of ['entity-ambiguous-a', 'entity-ambiguous-b']) {
      seedEntity(db, { id, name: id });
      seedLimsDna(db, id, 'GGGG');
    }
    bind(db, 'entity-ambiguous-a', 'seq_AMBIG01');
    expect(() => bind(db, 'entity-ambiguous-b', 'seq_AMBIG01')).toThrow(
      'Provider identity conflicts with another catalog entity in this project.'
    );
    db.prepare(
      `INSERT INTO catalog_provider_bindings
       (id,provider,stable_object_id,object_class,entity_id,binding_kind,
        provider_account_hint,canonical_url,evidence_json,created_at,updated_at)
       VALUES (?,'benchling','seq_AMBIG01','sequence','entity-ambiguous-b','observed',
               NULL,NULL,?,0,0)`
    ).run(
      providerBindingRowId('benchling', 'sequence', 'seq_AMBIG01', 'entity-ambiguous-b'),
      JSON.stringify({ source: 'historical-ambiguous-provider-binding-fixture' })
    );

    seedEntity(db, { id: 'entity-stale', name: 'Stale', status: 'missing' });
    seedLimsDna(db, 'entity-stale', 'TTTT');
    bind(db, 'entity-stale', 'seq_STALE01');

    seedEntity(db, { id: 'entity-exact-single', name: 'Local exact item' });
    seedLimsDna(db, 'entity-exact-single', 'AACCGG');

    for (const id of ['entity-exact-a', 'entity-exact-b']) {
      seedEntity(db, { id, name: id });
      seedLimsDna(db, id, 'GATTACA');
    }

    seedEntity(db, { id: 'entity-same-name-only', name: 'Incoming exact' });
    seedLimsDna(db, 'entity-same-name-only', 'AAAAAA');

    let leaseChecked = false;
    const inventory = await buildDestinationInventory({
      db,
      workspaceDbId: WORKSPACE_ID,
      workspacePath,
      sourceObjects: [
        sequence('seq_FILE001', 'acgt'),
        sequence('seq_CAT0001', 'CCCC'),
        sequence('seq_AMBIG01', 'GGGG'),
        sequence('seq_STALE01', 'TTTT'),
        sequence('seq_MATCH01', 'AACCGG', 'Incoming exact'),
        sequence('seq_MULTI01', 'GATTACA'),
      ],
      assertMutationLeaseHeld: () => {
        leaseChecked = true;
      },
    });

    expect(leaseChecked).toBe(true);
    expect(inventory.providerMatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceObjectId: 'seq_FILE001',
          state: 'matched',
          scientificComparison: 'equal',
          destination: expect.objectContaining({
            kind: 'file',
            entityId: 'entity-active-file',
            relativePath: 'Designs/Active.gb',
          }),
        }),
        expect.objectContaining({
          sourceObjectId: 'seq_CAT0001',
          state: 'matched',
          destination: expect.objectContaining({
            kind: 'catalog-record',
            entityId: 'entity-active-catalog',
          }),
        }),
        {
          sourceObjectId: 'seq_AMBIG01',
          stableId: 'seq_AMBIG01',
          state: 'ambiguous',
          candidateEntityIds: ['entity-ambiguous-a', 'entity-ambiguous-b'],
        },
        {
          sourceObjectId: 'seq_STALE01',
          stableId: 'seq_STALE01',
          state: 'stale',
          bindingEntityIds: ['entity-stale'],
        },
      ])
    );
    expect(inventory.nativeExactMatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceObjectId: 'seq_MATCH01',
          result: expect.objectContaining({
            kind: 'single',
            candidate: expect.objectContaining({ entityId: 'entity-exact-single' }),
          }),
        }),
        {
          sourceObjectId: 'seq_MULTI01',
          result: {
            kind: 'ambiguous',
            candidateEntityIds: ['entity-exact-a', 'entity-exact-b'],
          },
        },
      ])
    );
    expect(
      inventory.nativeExactMatches.some(
        (match) =>
          match.result.kind === 'single' &&
          match.result.candidate.entityId === 'entity-same-name-only'
      )
    ).toBe(false);
  });

  it('links a reviewed exact native item without renaming it and fails closed on stale authority', () => {
    seedEntity(db, { id: 'entity-native', name: 'Existing local name' });
    seedLimsDna(db, 'entity-native', 'AACCGG');
    const incoming = sequence('seq_INCOMING1', 'AACCGG', 'Benchling display name');
    const fingerprint = dnaBasesScientificFingerprint('AACCGG');
    if (!fingerprint) throw new Error('Test DNA did not produce a fingerprint.');

    linkReviewedExactNativeMatch({
      db,
      workspaceDbId: WORKSPACE_ID,
      runId: 'run-link-review',
      sourceObject: incoming,
      candidateEntityId: 'entity-native',
      expectedCandidateScientificSha256: fingerprint,
      now: 42,
    });

    expect(
      db.prepare(`SELECT name FROM catalog_entities WHERE id = 'entity-native'`).get()
    ).toEqual({ name: 'Existing local name' });
    const binding = db
      .prepare(
        `SELECT binding_kind, evidence_json
           FROM catalog_provider_bindings
          WHERE entity_id = 'entity-native'`
      )
      .get() as { binding_kind: string; evidence_json: string };
    expect(binding.binding_kind).toBe('reviewed');
    expect(JSON.parse(binding.evidence_json)).toMatchObject({
      source: 'benchling_migration_exact_native_review',
      runId: 'run-link-review',
      corroboration: {
        sourceObjectId: 'seq_INCOMING1',
        benchlingDisplayName: 'Benchling display name',
        scientificSha256: fingerprint,
      },
    });
    expect(() =>
      linkReviewedExactNativeMatch({
        db,
        workspaceDbId: WORKSPACE_ID,
        runId: 'run-link-review',
        sourceObject: incoming,
        candidateEntityId: 'entity-native',
        expectedCandidateScientificSha256: fingerprint,
        now: 43,
      })
    ).not.toThrow();
    expect(() =>
      linkReviewedExactNativeMatch({
        db,
        workspaceDbId: WORKSPACE_ID,
        runId: 'run-link-review',
        sourceObject: sequence('seq_OTHER001', 'AACCGG'),
        candidateEntityId: 'entity-native',
        expectedCandidateScientificSha256: fingerprint,
      })
    ).toThrow(/no longer active and unbound/i);
  });
});

function seedLimsSchema(db: Database.Database): void {
  db.prepare(
    `INSERT INTO lims_schema
       (id, kind, name, display_name, fields, current_revision_id, version, builtin,
        tombstone, created_at, updated_at)
     VALUES ('schema-dna', 'entity', 'dna_sequence', 'DNA sequence', '[]',
             'revision-dna', 1, 1, 0, 0, 0)`
  ).run();
  db.prepare(
    `INSERT INTO lims_schema_revision
       (id, schema_id, version, fields, tombstone, created_at)
     VALUES ('revision-dna', 'schema-dna', 1, '[]', 0, 0)`
  ).run();
}

function seedEntity(
  db: Database.Database,
  input: {
    id: string;
    name: string;
    storageType?: 'file' | 'database';
    status?: 'active' | 'missing';
  }
): void {
  db.prepare(
    `INSERT INTO catalog_entities
       (id, type, name, locator, storage_type, status, workspace_id, metadata, created_at, updated_at)
     VALUES (?, 'sequence', ?, ?, ?, ?, ?, NULL, 0, 0)`
  ).run(
    input.id,
    input.name,
    input.storageType === 'file' ? `file://${input.id}` : `entity://lims/${input.id}`,
    input.storageType ?? 'database',
    input.status ?? 'active',
    WORKSPACE_ID
  );
  if (input.storageType !== 'file' && (input.status ?? 'active') === 'active') {
    db.prepare(
      `INSERT INTO catalog_workspace_placements
         (entity_id, workspace_id, parent_relative_path, display_name,
          normalized_sibling_name, presentation_kind, status, created_at, updated_at)
       VALUES (?, ?, 'Registry', ?, ?, 'sequence', 'active', 0, 0)`
    ).run(input.id, WORKSPACE_ID, input.name, input.name.toLowerCase());
  }
}

function seedCurrentFile(
  db: Database.Database,
  entityId: string,
  path: string,
  relativePath: string
): void {
  db.prepare(
    `INSERT INTO catalog_entity_files
       (id, entity_id, workspace_id, path, relative_path, file_kind, content_hash,
        size_bytes, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'genbank', 'sha256:serialized-bytes', 12, 'current', 0, 0)`
  ).run(`file-${entityId}`, entityId, WORKSPACE_ID, path, relativePath);
}

function seedLimsDna(db: Database.Database, entityId: string, bases: string): void {
  db.prepare(
    `INSERT INTO lims_entity
       (id, kind, schema_id, schema_revision_id, name, fields, registration_status,
        workspace_id, tombstone, created_at, updated_at)
     VALUES (?, 'dna_sequence', 'schema-dna', 'revision-dna', ?, ?, 'tracked', ?, 0, 0, 0)`
  ).run(
    entityId,
    entityId,
    JSON.stringify({
      sequence: { mode: 'inline', bases, topology: 'linear', length: bases.length },
    }),
    WORKSPACE_ID
  );
}

function bind(db: Database.Database, entityId: string, stableObjectId: string): void {
  upsertProviderBinding(db, {
    reference: {
      provider: 'benchling',
      stableObjectId,
      objectClass: 'sequence',
      canonicalUrl: null,
      providerAccountHint: null,
    },
    entityId,
    bindingKind: 'observed',
    evidence: { source: 'destination-inventory-test' },
  });
}
