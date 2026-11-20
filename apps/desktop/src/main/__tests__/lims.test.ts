import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/session-store', () => ({
  getActiveStoredSession: vi.fn(async () => null),
}));
import { parseGenBankFull, serializeGenBank } from '@waypoint/sequence-utils';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    ipcMain: { handle: vi.fn() },
    dialog: { showErrorBox: vi.fn() },
    app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
    BrowserWindow: class extends EventEmitter {},
  };
});

import type Database from 'better-sqlite3';
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { ensureSchema } from '../schema';
import { createFileTestDb, createTestDb, openFileTestDb } from './test-db';
import {
  seedOriginalProjectFixture,
  type OriginalProjectFixture,
} from './original-project-fixture';
import {
  applyLimsImportBatchInDb,
  attachGenomeHypothesisInDb,
  archiveLimsEntityInDb,
  attachVerifiedLimsGenomeInDb,
  backfillLimsRegistryIdsInDb,
  getAllLimsPrimersInDb,
  getLimsIdSchemesInDb,
  setLimsIdSchemeInDb,
  getLimsEntityHistoryInDb,
  getLimsRegistrationBadgeCandidatesInDb,
  getLimsRegistryPreviewInDb,
  countLimsEntitiesByKindInDb,
  defineLimsSchemaInDb,
  refineLimsSchemaInDb,
  getLimsStrainGenomeSummariesInDb,
  getLimsStrainGenomeSummaryInDb,
  linkLimsEntitiesInDb,
  logLimsTelemetryInDb,
  queryLimsEntitiesInDb,
  queryLimsRegistrySummariesInDb,
  recordLimsStrainParentGenomeInDb,
  registerLimsIpcHandlers,
  registerLimsEntityInDb,
  resetLimsRegistryInDb,
  restoreLimsEntityInDb,
  revertLimsEntityInDb,
  seedLimsBuiltinsInDb,
  seedLimsDemoDatasetInDb,
  seedLimsMockDemoInDb,
  seedLimsPracticeDemoInDb,
  seedLimsStarterRegistryInDb,
  undoLimsImportBatchInDb,
  updateLimsEntityInDb,
} from '../lims';
import {
  clearLimsRegistryInsideTx,
  listLimsEntitySchemasInDb,
  registerLimsEntityInsideTx,
} from '../lims-engine-core';
import {
  BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT,
  SEQUENCE_SCHEMA_FIELD_DEFINITIONS,
} from '../../shared/sequence-entity-schema';
import { weaveProportional } from '../lims-demo-seed';

const REPO_ROOT = join(__dirname, '../../../../..');
const ECOLI_REGION = join(REPO_ROOT, 'test-fixtures/sequences/linear/ecoli-mg1655-region.gb');
const ECOLI_COMPLETE = join(REPO_ROOT, 'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb');

let db: Database.Database;
let originalProject: OriginalProjectFixture;

beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  originalProject = seedOriginalProjectFixture(db);
});

afterEach(() => {
  if (db.open) db.close();
});

describe('LIMS main-process operations', () => {
  it('seeds the revised DNA sequence field list as v3 without reusing either frozen revision', () => {
    seedLimsBuiltinsInDb(db);
    const sequence = listLimsEntitySchemasInDb(db).find(
      (schema) => schema.entityKind === 'sequence'
    );
    expect(sequence).toMatchObject({
      baseKind: 'sequence',
      currentRevisionId: 'schema-entity-sequence-v3',
      version: 3,
    });
    expect(sequence?.fields.map((field) => field.key)).toEqual(['description']);
  });

  it('retains an installed DNA sequence v1 while advancing its current schema to v3', () => {
    defineLimsSchemaInDb(db, {
      id: 'schema-entity-sequence',
      kind: 'entity',
      name: 'sequence',
      displayName: 'DNA sequence',
      baseKind: 'sequence',
      builtin: true,
      fields: [
        { key: 'locus', label: 'Locus', type: 'text', suggested: true },
        { key: 'description', label: 'Description', type: 'long_text', suggested: true },
      ],
    });

    seedLimsBuiltinsInDb(db);

    const sequence = listLimsEntitySchemasInDb(db).find(
      (schema) => schema.entityKind === 'sequence'
    );
    expect(sequence?.currentRevisionId).toBe('schema-entity-sequence-v3');
    const legacy = db
      .prepare('SELECT fields FROM lims_schema_revision WHERE id = ?')
      .get('schema-entity-sequence-v1') as { fields: string };
    expect(legacy.fields).toContain('locus');
  });

  it('seeds new Plasmid schemas at v2 so legacy v1 retains its original meaning', () => {
    seedLimsBuiltinsInDb(db);

    const plasmid = listLimsEntitySchemasInDb(db).find((schema) => schema.entityKind === 'plasmid');
    expect(plasmid).toMatchObject({
      baseKind: 'sequence',
      currentRevisionId: 'schema-entity-plasmid-v2',
      version: 2,
    });
    expect(plasmid?.fields.map((field) => field.key)).toEqual([
      'markers',
      'ori',
      'hostClass',
      'cloningMethod',
      'accessions',
      'notes',
    ]);
  });

  it('migrates a user-refined legacy Plasmid schema onto the sequence primitive without losing custom fields', () => {
    defineLimsSchemaInDb(db, {
      id: 'schema-entity-plasmid',
      kind: 'entity',
      name: 'plasmid',
      displayName: 'Plasmid',
      baseKind: 'plasmid',
      builtin: true,
      fields: [
        { key: 'sequence', label: 'Sequence', type: 'dna_sequence', required: true },
        { key: 'type', label: 'Type', type: 'text' },
        { key: 'markers', label: 'Markers', type: 'string_array' },
      ],
    });
    refineLimsSchemaInDb(db, {
      schemaId: 'schema-entity-plasmid',
      fields: [
        { key: 'sequence', label: 'Sequence', type: 'dna_sequence', required: true },
        { key: 'type', label: 'Type', type: 'text' },
        { key: 'markers', label: 'Markers', type: 'string_array' },
        { key: 'projectCode', label: 'Project code', type: 'text' },
      ],
    });

    seedLimsBuiltinsInDb(db);

    const plasmid = listLimsEntitySchemasInDb(db).find((schema) => schema.entityKind === 'plasmid');
    expect(plasmid).toMatchObject({
      baseKind: 'sequence',
      currentRevisionId: 'schema-entity-plasmid-v3',
      version: 3,
    });
    expect(plasmid?.fields.map((field) => field.key)).toEqual(['markers', 'projectCode']);
  });

  it('seeds all sequence revisions without changing the immutable v1 revision', () => {
    seedLimsBuiltinsInDb(db);
    const v1 = db
      .prepare(`SELECT fields FROM lims_schema_revision WHERE id = 'schema-entity-sequence-v1'`)
      .get() as { fields: string };
    expect(JSON.parse(v1.fields).fields.map((field: { key: string }) => field.key)).toEqual([
      'description',
    ]);

    const entity = registerLimsEntityInDb(db, {
      id: 'accepted-assembly-product',
      kind: 'sequence',
      name: 'Accepted assembly',
      fields: { locus: 'pBR322' },
      schemaRevisionId: BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT.schemaRevisionId,
      schemaSnapshot: BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT,
    });
    expect(entity.schemaRevisionId).toBe(BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT.schemaRevisionId);
    expect(
      listLimsEntitySchemasInDb(db).find((schema) => schema.entityKind === 'sequence')
        ?.currentRevisionId
    ).toBe(BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT.schemaRevisionId);
    expect(
      (
        db
          .prepare(`SELECT fields FROM lims_schema_revision WHERE id = 'schema-entity-sequence-v1'`)
          .get() as { fields: string }
      ).fields
    ).toBe(v1.fields);
  });

  it('adds sequence v2 and v3 to an existing v1 Registry', () => {
    const fixture = createFileTestDb('legacy-sequence-schema');
    try {
      ensureSchema(fixture.db, fixture.dbPath);
      seedOriginalProjectFixture(fixture.db, originalProject);
      seedLimsBuiltinsInDb(fixture.db);
      const v1 = fixture.db
        .prepare(`SELECT fields FROM lims_schema_revision WHERE id = 'schema-entity-sequence-v1'`)
        .get() as { fields: string };
      fixture.db
        .prepare(
          `UPDATE lims_schema SET current_revision_id = 'schema-entity-sequence-v1',
             version = 1, fields = ? WHERE id = 'schema-entity-sequence'`
        )
        .run(v1.fields);
      fixture.db
        .prepare(
          `DELETE FROM lims_schema_revision WHERE id IN ('schema-entity-sequence-v2', 'schema-entity-sequence-v3')`
        )
        .run();
      fixture.db.close();

      const reopened = openFileTestDb(fixture.dbPath);
      try {
        seedLimsBuiltinsInDb(reopened);
        const sequence = listLimsEntitySchemasInDb(reopened).find(
          (schema) => schema.entityKind === 'sequence'
        );
        expect(sequence?.currentRevisionId).toBe('schema-entity-sequence-v3');
        expect(
          (
            reopened
              .prepare(
                `SELECT fields FROM lims_schema_revision WHERE id = 'schema-entity-sequence-v1'`
              )
              .get() as { fields: string }
          ).fields
        ).toBe(v1.fields);
        expect(() =>
          registerLimsEntityInDb(reopened, {
            id: 'legacy-accepted-product',
            kind: 'sequence',
            name: 'Accepted assembly',
            fields: { locus: 'pBR322' },
            schemaRevisionId: BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT.schemaRevisionId,
            schemaSnapshot: BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT,
          })
        ).not.toThrow();
      } finally {
        reopened.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    {
      fields: [
        { key: 'locus', label: 'Locus', type: 'text' as const, suggested: true },
        ...SEQUENCE_SCHEMA_FIELD_DEFINITIONS,
      ],
    },
    { fields: SEQUENCE_SCHEMA_FIELD_DEFINITIONS },
  ])('preserves an installed sequence v2 definition exactly while adding v3: %j', ({ fields }) => {
    defineLimsSchemaInDb(db, {
      id: 'schema-entity-sequence',
      kind: 'entity',
      name: 'sequence',
      displayName: 'DNA sequence',
      baseKind: 'sequence',
      builtin: true,
      fields: [],
    });
    refineLimsSchemaInDb(db, { schemaId: 'schema-entity-sequence', fields: [...fields] });
    const before = db
      .prepare('SELECT * FROM lims_schema_revision WHERE id = ?')
      .get('schema-entity-sequence-v2');
    seedLimsBuiltinsInDb(db);
    expect(
      db.prepare('SELECT * FROM lims_schema_revision WHERE id = ?').get('schema-entity-sequence-v2')
    ).toEqual(before);
    expect(
      listLimsEntitySchemasInDb(db).find((schema) => schema.entityKind === 'sequence')
    ).toMatchObject({ currentRevisionId: 'schema-entity-sequence-v3', version: 3 });
  });

  it.each([2, 3])(
    'preserves user-refined sequence v%d on startup without consuming the next revision',
    (version) => {
      defineLimsSchemaInDb(db, {
        id: 'schema-entity-sequence',
        kind: 'entity',
        name: 'sequence',
        displayName: 'DNA sequence',
        baseKind: 'sequence',
        builtin: true,
        fields: [],
      });
      for (let next = 2; next <= version; next += 1) {
        refineLimsSchemaInDb(db, {
          schemaId: 'schema-entity-sequence',
          fields: [{ key: 'projectCode', label: 'Project code', type: 'text' }],
        });
      }
      const before = db
        .prepare('SELECT * FROM lims_schema WHERE id = ?')
        .get('schema-entity-sequence');
      const revisions = db
        .prepare('SELECT * FROM lims_schema_revision WHERE schema_id = ? ORDER BY version')
        .all('schema-entity-sequence');
      expect(() => seedLimsBuiltinsInDb(db)).not.toThrow();
      expect(
        db.prepare('SELECT * FROM lims_schema WHERE id = ?').get('schema-entity-sequence')
      ).toEqual(before);
      expect(
        db
          .prepare('SELECT * FROM lims_schema_revision WHERE schema_id = ? ORDER BY version')
          .all('schema-entity-sequence')
      ).toEqual(revisions);
    }
  );

  it('stores one-level schema lineage and exposes the immutable current revision', () => {
    seedLimsBuiltinsInDb(db);
    const oligo = listLimsEntitySchemasInDb(db).find((schema) => schema.entityKind === 'oligo');
    expect(oligo).toMatchObject({
      baseKind: 'oligo',
      currentRevisionId: 'schema-entity-oligo-v1',
    });

    defineLimsSchemaInDb(db, {
      id: 'schema-qpcr-primer',
      kind: 'entity',
      name: 'qpcr_primer',
      displayName: 'qPCR primer',
      baseKind: 'primer',
      fields: [
        ...oligo!.fields,
        { key: 'assayId', label: 'Assay ID', type: 'text', required: true },
      ],
    });

    const defined = listLimsEntitySchemasInDb(db).find(
      (schema) => schema.entityKind === 'qpcr_primer'
    );
    expect(defined).toMatchObject({
      schemaId: 'schema-qpcr-primer',
      currentRevisionId: 'schema-qpcr-primer-v1',
      baseKind: 'primer',
      version: 1,
    });

    refineLimsSchemaInDb(db, {
      schemaId: defined!.schemaId,
      fields: [...defined!.fields, { key: 'plate', label: 'Plate', type: 'text' }],
    });
    expect(
      listLimsEntitySchemasInDb(db).find((schema) => schema.entityKind === 'qpcr_primer')
    ).toMatchObject({
      currentRevisionId: 'schema-qpcr-primer-v2',
      baseKind: 'primer',
      version: 2,
    });
  });

  it('rejects duplicate user schema names instead of silently reusing an existing definition', () => {
    seedLimsBuiltinsInDb(db);
    expect(() =>
      defineLimsSchemaInDb(db, {
        kind: 'entity',
        name: 'plasmid',
        displayName: 'Another plasmid',
        baseKind: 'sequence',
        fields: [{ key: 'note', label: 'Note', type: 'text' }],
        existingPolicy: 'reject',
      })
    ).toThrow('Schema name already exists: plasmid');
  });

  it('rejects a stale schema revision without creating a new revision', () => {
    seedLimsBuiltinsInDb(db);
    const current = listLimsEntitySchemasInDb(db).find(
      (schema) => schema.entityKind === 'plasmid'
    )!;
    refineLimsSchemaInDb(db, {
      schemaId: current.schemaId,
      expectedRevisionId: current.currentRevisionId,
      fields: [...current.fields, { key: 'plate', label: 'Plate', type: 'text' }],
    });
    expect(() =>
      refineLimsSchemaInDb(db, {
        schemaId: current.schemaId,
        expectedRevisionId: current.currentRevisionId,
        fields: [...current.fields, { key: 'source', label: 'Source', type: 'text' }],
      })
    ).toThrow('Schema changed elsewhere');
    expect(
      listLimsEntitySchemasInDb(db).find((schema) => schema.schemaId === current.schemaId)?.version
    ).toBe(current.version + 1);
  });

  it('revising a schema can clear its description', () => {
    const row = defineLimsSchemaInDb(db, {
      kind: 'entity',
      name: 'reagent_batch',
      displayName: 'Reagent batch',
      description: 'Old description',
      fields: [{ key: 'batch', label: 'Batch', type: 'text' }],
    });
    refineLimsSchemaInDb(db, {
      schemaId: row.id,
      expectedRevisionId: row.current_revision_id ?? `${row.id}-v1`,
      description: null,
      fields: [{ key: 'batch', label: 'Batch', type: 'text' }],
    });
    expect(
      listLimsEntitySchemasInDb(db).find((schema) => schema.schemaId === row.id)?.description
    ).toBeNull();
  });

  it('allows a sequence-backed schema to use only inherited sequence fields', () => {
    defineLimsSchemaInDb(db, {
      kind: 'entity',
      name: 'custom_sequence',
      displayName: 'Custom sequence',
      baseKind: 'sequence',
      fields: [],
      existingPolicy: 'reject',
    });
    const schema = listLimsEntitySchemasInDb(db).find(
      (candidate) => candidate.entityKind === 'custom_sequence'
    );
    expect(schema?.fields).toEqual([]);
    expect(schema?.baseKind).toBe('sequence');
  });

  it('rejects sequence property fields in authored schemas while preserving older snapshots', () => {
    const sizeField = { key: 'size', label: 'Size', type: 'number' as const };
    expect(() =>
      defineLimsSchemaInDb(db, {
        kind: 'entity',
        name: 'invalid_sequence_size',
        displayName: 'Invalid sequence size',
        baseKind: 'sequence',
        fields: [sizeField],
      })
    ).toThrow('Sequence property keys cannot be schema fields');

    const authored = defineLimsSchemaInDb(db, {
      kind: 'entity',
      name: 'custom_sequence_size',
      displayName: 'Custom sequence size',
      baseKind: 'sequence',
      fields: [],
    });
    expect(() =>
      refineLimsSchemaInDb(db, {
        schemaId: authored.id,
        expectedRevisionId: authored.current_revision_id ?? undefined,
        fields: [sizeField],
      })
    ).toThrow('Sequence property keys cannot be schema fields');

    const ordinary = defineLimsSchemaInDb(db, {
      kind: 'entity',
      name: 'container_size',
      displayName: 'Container size',
      baseKind: 'record',
      fields: [sizeField],
    });
    expect(ordinary.name).toBe('container_size');

    const schemaSnapshot = {
      schemaId: 'schema-legacy-sequence-size',
      schemaRevisionId: 'schema-legacy-sequence-size-v1',
      name: 'legacy_sequence_size',
      displayName: 'Legacy sequence size',
      baseKind: 'sequence',
      version: 1,
      fields: [{ ...sizeField, intrinsic: 'sequence.length' as const, readOnly: true }],
    };
    const entity = registerLimsEntityInDb(db, {
      id: 'legacy-size-package',
      kind: schemaSnapshot.name,
      name: 'Legacy sequence',
      fields: { size: 999 },
      schemaRevisionId: schemaSnapshot.schemaRevisionId,
      schemaSnapshot,
    });
    expect(entity.fields.size).toBe(999);
    expect(
      listLimsEntitySchemasInDb(db).find((schema) => schema.schemaId === schemaSnapshot.schemaId)
        ?.fields
    ).toEqual(schemaSnapshot.fields);
  });

  it('atomically materializes an exact file-authoritative schema revision with its entity', () => {
    seedLimsBuiltinsInDb(db);
    const schemaSnapshot = {
      schemaId: 'schema-qpcr-primer',
      schemaRevisionId: 'schema-qpcr-primer-v3',
      name: 'qpcr_primer',
      displayName: 'qPCR primer',
      baseKind: 'primer',
      version: 3,
      fields: [{ key: 'assayId', label: 'Assay ID', type: 'text' as const, required: true }],
    };

    expect(() =>
      registerLimsEntityInDb(db, {
        id: 'primer-invalid-projection',
        kind: 'qpcr_primer',
        name: 'Invalid primer',
        fields: { assayId: 42 },
        schemaRevisionId: schemaSnapshot.schemaRevisionId,
        schemaSnapshot,
      })
    ).toThrow('assayId must be a string');
    expect(
      listLimsEntitySchemasInDb(db).some((schema) => schema.schemaId === schemaSnapshot.schemaId)
    ).toBe(false);

    const entity = registerLimsEntityInDb(db, {
      id: 'primer-schema-projection',
      kind: 'qpcr_primer',
      name: 'qPCR_F1',
      fields: { assayId: 'ASSAY-42' },
      schemaRevisionId: schemaSnapshot.schemaRevisionId,
      schemaSnapshot,
    });

    expect(entity).toMatchObject({
      schemaId: schemaSnapshot.schemaId,
      schemaRevisionId: schemaSnapshot.schemaRevisionId,
      fields: { assayId: 'ASSAY-42' },
    });
    expect(
      listLimsEntitySchemasInDb(db).find((schema) => schema.schemaId === schemaSnapshot.schemaId)
    ).toMatchObject({ currentRevisionId: schemaSnapshot.schemaRevisionId, baseKind: 'primer' });
  });

  it('uses the active file-sequence path index for duplicate-owner checks', () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id, name FROM lims_entity
         WHERE tombstone = 0
           AND archived_at IS NULL
           AND id != ?
           AND json_extract(fields, '$.sequence.mode') = 'file'
           AND json_type(fields, '$.sequence.relPath') = 'text'
           AND trim(json_extract(fields, '$.sequence.relPath')) = ?
         LIMIT 1`
      )
      .all('candidate-id', '/tmp/candidate.gb') as Array<{ detail: string }>;

    expect(plan.map((row) => row.detail).join('\n')).toContain(
      'idx_lims_entity_active_file_sequence_path'
    );
  });

  it('edits custom fields named sequence and sourceMetadata according to their pinned schema', () => {
    const schemaSnapshot = {
      schemaId: 'schema-custom-field-names',
      schemaRevisionId: 'schema-custom-field-names-v1',
      name: 'custom_field_names',
      displayName: 'Custom field names',
      baseKind: 'record',
      version: 1,
      fields: [
        { key: 'sequence', label: 'Sequence number', type: 'number' },
        { key: 'sourceMetadata', label: 'Source description', type: 'text' },
      ],
    };
    const entity = registerLimsEntityInDb(db, {
      kind: schemaSnapshot.name,
      name: 'Record',
      fields: { sequence: 1, sourceMetadata: 'one' },
      schemaRevisionId: schemaSnapshot.schemaRevisionId,
      schemaSnapshot,
    });
    expect(
      updateLimsEntityInDb(db, { id: entity.id, fields: { sequence: 2, sourceMetadata: 'two' } })
        .fields
    ).toEqual({ sequence: 2, sourceMetadata: 'two' });
  });

  it('reconstructs a built-in sequence package whose snapshot omits the optional description', async () => {
    const { BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT } =
      await import('../../shared/sequence-entity-schema');
    const entity = registerLimsEntityInDb(db, {
      kind: 'sequence',
      name: 'Portable sequence',
      fields: {},
      schemaRevisionId: BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT.schemaRevisionId,
      schemaSnapshot: BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT,
    });
    expect(entity.schemaRevisionId).toBe(BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT.schemaRevisionId);
  });

  it.each(['displayName', 'description'] as const)(
    'rejects a reused schema identity with changed %s',
    (property) => {
      const schemaSnapshot = {
        schemaId: 'schema-record-label',
        schemaRevisionId: 'schema-record-label-v1',
        name: 'record_label',
        displayName: 'Original label',
        description: 'Original description',
        baseKind: 'record',
        version: 1,
        fields: [{ key: 'value', label: 'Value', type: 'text' }],
      };
      const register = (name: string, snapshot = schemaSnapshot) =>
        registerLimsEntityInDb(db, {
          kind: snapshot.name,
          name,
          fields: { value: name },
          schemaRevisionId: snapshot.schemaRevisionId,
          schemaSnapshot: snapshot,
        });
      register('First');
      expect(() => register('Second', { ...schemaSnapshot, [property]: 'Changed label' })).toThrow(
        /Schema identity collision/
      );
    }
  );

  it(': lists entity schemas, reflects a builtin refine, and the edit SURVIVES a reboot re-seed', () => {
    const fixture = createFileTestDb('schema-configurator');
    try {
      ensureSchema(fixture.db, fixture.dbPath);
      seedOriginalProjectFixture(fixture.db, originalProject);
      seedLimsBuiltinsInDb(fixture.db);

      const strain = listLimsEntitySchemasInDb(fixture.db).find((s) => s.entityKind === 'strain');
      expect(strain).toBeDefined();
      expect(strain!.fields.some((f) => f.key === 'genotypeCanonical')).toBe(true);
      expect(strain!.fields.some((f) => f.key === 'externalId')).toBe(false);

      refineLimsSchemaInDb(fixture.db, {
        schemaId: strain!.schemaId,
        fields: [...strain!.fields, { key: 'externalId', label: 'External ID', type: 'text' }],
      });
      const afterEdit = listLimsEntitySchemasInDb(fixture.db).find(
        (s) => s.entityKind === 'strain'
      )!;
      expect(afterEdit.fields.some((f) => f.key === 'externalId')).toBe(true);
      expect(afterEdit.version).toBe(2);
      fixture.db.close();

      const reopened = openFileTestDb(fixture.dbPath);
      try {
        ensureSchema(reopened, fixture.dbPath);
        seedLimsBuiltinsInDb(reopened);
        const afterReboot = listLimsEntitySchemasInDb(reopened).find(
          (s) => s.entityKind === 'strain'
        )!;
        expect(afterReboot.fields.some((f) => f.key === 'externalId')).toBe(true);
        expect(afterReboot.version).toBe(2);
      } finally {
        reopened.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('seeds built-in entity and relationship schemas as data rows', () => {
    seedLimsBuiltinsInDb(db);

    const counts = db
      .prepare(`SELECT kind, COUNT(*) as count FROM lims_schema GROUP BY kind ORDER BY kind`)
      .all() as Array<{ kind: string; count: number }>;

    expect(counts).toEqual([
      { kind: 'entity', count: 21 },
      { kind: 'relationship_type', count: 17 },
    ]);
    const association = db
      .prepare(`SELECT display_name FROM lims_schema WHERE kind = 'relationship_type' AND name = ?`)
      .get('associated_with') as { display_name: string } | undefined;
    expect(association).toEqual({ display_name: 'Associated with' });

    const chromosome = db
      .prepare(`SELECT display_name FROM lims_schema WHERE kind = 'entity' AND name = ?`)
      .get('chromosome') as { display_name: string } | undefined;
    expect(chromosome).toEqual({ display_name: 'Chromosome' });
    const rnaOligo = listLimsEntitySchemasInDb(db).find(
      (schema) => schema.entityKind === 'rna_oligo'
    );
    expect(rnaOligo).toMatchObject({
      displayName: 'RNA Oligo',
      fields: expect.arrayContaining([
        expect.objectContaining({ key: 'sequence', type: 'rna_sequence', required: true }),
      ]),
    });
    const auditCount = db.prepare(`SELECT COUNT(*) as count FROM lims_audit`).get() as {
      count: number;
    };

    expect(auditCount.count).toBe(40);
  });

  it('re-seeds builtins after a surrounding transaction rolls back', () => {
    db.exec('BEGIN IMMEDIATE');
    seedLimsBuiltinsInDb(db);
    expect(db.prepare('SELECT COUNT(*) AS count FROM lims_schema').get()).toEqual({ count: 38 });
    db.exec('ROLLBACK');

    expect(db.prepare('SELECT COUNT(*) AS count FROM lims_schema').get()).toEqual({ count: 0 });
    seedLimsBuiltinsInDb(db);
    expect(db.prepare('SELECT COUNT(*) AS count FROM lims_schema').get()).toEqual({ count: 38 });
  });

  it('registers a notebook with a caller-supplied id and no sequence', () => {
    seedLimsBuiltinsInDb(db);
    const notebook = registerLimsEntityInDb(db, {
      id: 'ws1::page-miniprep',
      kind: 'notebook',
      name: 'Miniprep',
      fields: { packagePath: '/lab/Miniprep' },
    });
    expect(notebook).toMatchObject({
      id: 'ws1::page-miniprep',
      kind: 'notebook',
      name: 'Miniprep',
      registrationStatus: 'registered',
    });
    expect(notebook.registryId).toMatch(/^nb\d+$/);
    const summaries = queryLimsRegistrySummariesInDb(db, { kind: 'notebook' });
    expect(summaries.summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'ws1::page-miniprep',
          kind: 'notebook',
          representation: expect.objectContaining({ kind: 'notebook', canOpen: true }),
        }),
      ])
    );
  });

  it('projects a saved Track view as an openable Registry row', () => {
    const view = registerLimsEntityInDb(db, {
      id: 'track-view-1',
      kind: 'track-view',
      name: 'Yeast detail',
      fields: {
        referenceAssemblyId: 'sacCer3',
        referenceName: 'S. cerevisiae',
        trackCount: 2,
        artifactFingerprint: 'track-view-fingerprint',
      },
      actor: 'track-view-file',
    });

    expect(view).toMatchObject({
      id: 'track-view-1',
      kind: 'track-view',
      name: 'Yeast detail',
      registrationStatus: 'registered',
      actor: 'track-view-file',
    });
    expect(view.registryId).toMatch(/^tv\d+$/);
    expect(queryLimsRegistrySummariesInDb(db, { kind: 'track-view' }).summaries).toEqual([
      expect.objectContaining({
        id: 'track-view-1',
        kind: 'track-view',
        summary: 'S. cerevisiae · 2 tracks',
        representation: {
          kind: 'track_view',
          label: 'Saved Track view',
          canOpen: true,
          openTarget: {
            kind: 'track_view',
            entityId: 'track-view-1',
            entityKind: 'track-view',
            label: 'Yeast detail',
          },
        },
      }),
    ]);
  });

  it('registers entities with audit and rolls back both row and audit on forced failure', () => {
    const good = registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'M13-F',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
        use: 'primer',
      },
      actor: 'test',
    });
    expect(good.id).toBeTruthy();

    const audit = db
      .prepare(
        `SELECT event_type, subject_id FROM lims_audit WHERE event_type = 'entity_registered'`
      )
      .all() as Array<{ event_type: string; subject_id: string }>;
    expect(audit.some((event) => event.subject_id === good.id)).toBe(true);

    expect(() =>
      registerLimsEntityInDb(db, {
        kind: 'oligo',
        name: 'rollback-me',
        fields: {
          sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
          use: 'primer',
        },
        failAfterEntityInsert: true,
      })
    ).toThrow(/Forced LIMS entity rollback/);

    const rows = queryLimsEntitiesInDb(db, { nameLike: 'rollback-me' });
    expect(rows).toEqual([]);
  });

  it('rejects lineage cycles', () => {
    const parent = registerLimsEntityInDb(db, {
      kind: 'genome',
      name: 'parent',
      fields: { sequence: { mode: 'unresolved' } },
      registrationStatus: 'unresolved',
    });
    const child = registerLimsEntityInDb(db, {
      kind: 'genome',
      name: 'child',
      fields: { sequence: { mode: 'unresolved' } },
      registrationStatus: 'unresolved',
    });

    linkLimsEntitiesInDb(db, {
      fromEntityId: child.id,
      toEntityId: parent.id,
      type: 'derives_from',
    });
    expect(() =>
      linkLimsEntitiesInDb(db, {
        fromEntityId: parent.id,
        toEntityId: child.id,
        type: 'derives_from',
      })
    ).toThrow(/cycle/);
  });

  it('applies import batches with entity fields and link payloads', () => {
    const plasmid = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'pUC19',
      fields: {
        sequence: {
          mode: 'file',
          documentId: 'sequence-document-puc19',
          relPath: '/tmp/pUC19.gb',
          topology: 'circular',
          length: 2686,
          contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          sourceFormat: 'gb',
        },
      },
    });

    const result = applyLimsImportBatchInDb(db, {
      sourceName: 'primers.csv',
      sourceKind: 'csv',
      records: [
        {
          id: 'row-1',
          action: 'register_entity',
          accepted: true,
          entity: {
            kind: 'oligo',
            name: 'M13-Reverse',
            fields: {
              sequence: {
                mode: 'inline',
                bases: 'CAGGAAACAGCTATGAC',
                topology: 'linear',
                length: 17,
              },
              use: 'primer',
            },
          },
          links: [
            {
              type: 'associated_with',
              toEntityLookup: { kind: 'plasmid', name: 'pUC19' },
              payload: {
                orientation: 'reverse',
                role: 'intended_target',
                bindingStart: 12,
                bindingEnd: 29,
              },
            },
          ],
          sourceRow: 12,
          source: { Direction: 'Reverse', Target: 'pUC19' },
        },
      ],
      oracle: { ok: true, source: 'csv:primers.csv', invariants: [] },
    });

    expect(result).toMatchObject({
      insertedEntities: 1,
      insertedLinks: 1,
      skipped: 0,
      insertedEntityIds: [expect.objectContaining({ recordId: 'row-1' })],
      insertedLinkIds: [expect.objectContaining({ recordId: 'row-1' })],
      skippedRecordIds: [],
      unresolvedLinks: [],
    });
    const link = db.prepare(`SELECT * FROM lims_link WHERE to_entity_id = ?`).get(plasmid.id) as {
      payload: string;
    };
    expect(JSON.parse(link.payload)).toMatchObject({
      orientation: 'reverse',
      role: 'intended_target',
      bindingStart: 12,
      bindingEnd: 29,
    });
    const imported = queryLimsEntitiesInDb(db, { kind: 'oligo', nameLike: 'M13-Reverse' })[0];
    expect(imported.fields.sourceMetadata).toEqual({
      schemaVersion: 1,
      origin: {
        type: 'file_import',
        sourceName: 'primers.csv',
        sourceKind: 'csv',
      },
      importRecordId: 'row-1',
      row: { index: 12 },
      values: { Direction: 'Reverse', Target: 'pUC19' },
    });
    expect(result.insertedEntityIds[0].entityId).toBeTruthy();
    expect(result.insertedLinkIds[0].linkId).toBeTruthy();
  });

  it('returns skipped records and advisory unresolved links in import batch results', () => {
    const result = applyLimsImportBatchInDb(db, {
      sourceName: 'primers.csv',
      sourceKind: 'csv',
      records: [
        {
          id: 'row-1',
          action: 'register_entity',
          accepted: true,
          entity: {
            kind: 'oligo',
            name: 'Primer with unresolved advisory target',
            fields: {
              sequence: {
                mode: 'inline',
                bases: 'GTAAAACGACGGCCAGT',
                topology: 'linear',
                length: 17,
              },
              use: 'primer',
            },
          },
          links: [],
          unresolvedLinks: [
            {
              label: 'Missing plasmid',
              kind: 'plasmid',
              type: 'associated_with',
              severity: 'advisory',
              reason: 'No exact registry match for associated target.',
            },
          ],
          source: { Target: 'Missing plasmid' },
        },
        {
          id: 'row-2',
          action: 'register_entity',
          accepted: false,
          entity: {
            kind: 'oligo',
            name: 'Skipped primer',
            fields: {
              sequence: {
                mode: 'inline',
                bases: 'CAGGAAACAGCTATGAC',
                topology: 'linear',
                length: 17,
              },
              use: 'primer',
            },
          },
          source: {},
        },
      ],
    });

    expect(result).toMatchObject({
      insertedEntities: 1,
      insertedLinks: 0,
      skipped: 1,
      insertedEntityIds: [expect.objectContaining({ recordId: 'row-1' })],
      insertedLinkIds: [],
      skippedRecordIds: ['row-2'],
      unresolvedLinks: [
        expect.objectContaining({
          recordId: 'row-1',
          link: expect.objectContaining({ label: 'Missing plasmid', severity: 'advisory' }),
        }),
      ],
    });
  });

  it('rejects accepted records with blocking unresolved links before inserting entities', () => {
    expect(() =>
      applyLimsImportBatchInDb(db, {
        sourceName: 'strains.csv',
        sourceKind: 'csv',
        records: [
          {
            id: 'row-1',
            action: 'register_entity',
            accepted: true,
            entity: {
              kind: 'strain',
              name: 'Unresolved evidence strain',
              fields: { genotypeCanonical: 'argFΔ' },
            },
            links: [],
            unresolvedLinks: [
              {
                label: 'Missing WGS',
                kind: 'genome',
                type: 'has_genome',
                severity: 'blocking',
                reason: 'No exact registry match for has genome WGS.',
              },
            ],
            source: { 'Verified WGS Genome': 'Missing WGS' },
          },
        ],
      })
    ).toThrow(/Blocking unresolved has_genome reference Missing WGS/);

    expect(
      queryLimsEntitiesInDb(db, { kind: 'strain', nameLike: 'Unresolved evidence strain' })
    ).toHaveLength(0);
  });

  it('rejects stale import link lookups before inserting entities', () => {
    expect(() =>
      applyLimsImportBatchInDb(db, {
        sourceName: 'primers.csv',
        sourceKind: 'csv',
        records: [
          {
            id: 'row-1',
            action: 'register_entity',
            accepted: true,
            entity: {
              kind: 'oligo',
              name: 'Primer with stale target',
              fields: {
                sequence: {
                  mode: 'inline',
                  bases: 'GTAAAACGACGGCCAGT',
                  topology: 'linear',
                  length: 17,
                },
                use: 'primer',
              },
            },
            links: [
              {
                type: 'associated_with',
                toEntityLookup: { kind: 'plasmid', name: 'Missing pUC19' },
                payload: { role: 'intended_target' },
              },
            ],
            unresolvedLinks: [],
            source: { Target: 'Missing pUC19' },
          },
        ],
      })
    ).toThrow(/Import link associated_with to endpoint not found: plasmid Missing pUC19/);

    expect(
      queryLimsEntitiesInDb(db, { kind: 'oligo', nameLike: 'Primer with stale target' })
    ).toHaveLength(0);
  });

  it('ALLOWS a sequence match at apply time but still refuses a whole-file re-drop ', () => {
    const ctx = createFileTestDb('lims-import-stale-duplicate');
    try {
      ensureSchema(ctx.db, ctx.dbPath);
      seedOriginalProjectFixture(ctx.db, originalProject);
      const existingPath = join(ctx.tmpDir, 'existing.gb');
      const incomingPath = join(ctx.tmpDir, 'incoming.gb');
      writeFileSync(
        existingPath,
        'LOCUS       EXISTING                  20 bp    DNA     linear\n//\n'
      );
      writeFileSync(
        incomingPath,
        'LOCUS       INCOMING                  20 bp    DNA     linear\n//\n'
      );
      const normalizedSequenceHash =
        'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

      registerLimsEntityInDb(ctx.db, {
        kind: 'genome',
        name: 'Existing normalized source',
        fields: {
          sequence: {
            mode: 'file',
            relPath: existingPath,
            topology: 'linear',
            length: 20,
            contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            fileContentHash:
              'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            normalizedSequenceHash,
            sourceFormat: 'gb',
          },
          source: 'reference',
        },
      });

      applyLimsImportBatchInDb(ctx.db, {
        sourceName: 'incoming.gb',
        sourceKind: 'genbank',
        records: [
          {
            id: 'row-1',
            action: 'register_entity',
            accepted: true,
            entity: {
              kind: 'genome',
              name: 'Incoming normalized duplicate',
              fields: {
                sequence: {
                  mode: 'file',
                  relPath: incomingPath,
                  topology: 'linear',
                  length: 20,
                  contentHash:
                    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                  fileContentHash:
                    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                  normalizedSequenceHash,
                  sourceFormat: 'gb',
                },
                source: 'other',
              },
            },
            links: [],
            unresolvedLinks: [],
            source: { file: incomingPath },
          },
        ],
      });
      expect(
        queryLimsEntitiesInDb(ctx.db, { kind: 'genome', nameLike: 'Incoming normalized duplicate' })
      ).toHaveLength(1);

      expect(() =>
        applyLimsImportBatchInDb(ctx.db, {
          sourceName: 'existing-redrop.gb',
          sourceKind: 'genbank',
          records: [
            {
              id: 'row-redrop',
              action: 'register_entity',
              accepted: true,
              entity: {
                kind: 'genome',
                name: 'A re-dropped identical file',
                fields: {
                  sequence: {
                    mode: 'file',
                    relPath: existingPath,
                    topology: 'linear',
                    length: 20,
                    contentHash:
                      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    fileContentHash:
                      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    normalizedSequenceHash,
                    sourceFormat: 'gb',
                  },
                  source: 'other',
                },
              },
              links: [],
              unresolvedLinks: [],
              source: { file: existingPath },
            },
          ],
        })
      ).toThrow(/file-byte hash/);
    } finally {
      ctx.cleanup();
    }
  });

  it('undoes an import batch by tombstoning only records created by that batch', () => {
    const plasmid = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'pUC19',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
      },
    });

    const result = applyLimsImportBatchInDb(db, {
      batchId: 'import-batch-undo-1',
      sourceName: 'primers.csv',
      sourceKind: 'csv',
      records: [
        {
          id: 'row-1',
          action: 'register_entity',
          accepted: true,
          entity: {
            kind: 'oligo',
            name: 'Undoable primer',
            fields: {
              sequence: {
                mode: 'inline',
                bases: 'GTAAAACGACGGCCAGT',
                topology: 'linear',
                length: 17,
              },
              use: 'primer',
            },
          },
          links: [
            {
              type: 'associated_with',
              toEntityId: plasmid.id,
              payload: { role: 'intended_target' },
            },
          ],
          source: { Name: 'Undoable primer', Target: 'pUC19' },
        },
      ],
    });

    expect(result).toMatchObject({ batchId: 'import-batch-undo-1', insertedEntities: 1 });
    expect(queryLimsEntitiesInDb(db, { kind: 'oligo', nameLike: 'Undoable primer' })).toHaveLength(
      1
    );

    const undo = undoLimsImportBatchInDb(db, {
      batchId: 'import-batch-undo-1',
      actor: 'tester',
    });

    expect(undo).toEqual({
      batchId: 'import-batch-undo-1',
      tombstonedEntities: 1,
      tombstonedLinks: 1,
      skippedEntities: 0,
      skippedLinks: 0,
    });
    expect(queryLimsEntitiesInDb(db, { kind: 'oligo', nameLike: 'Undoable primer' })).toEqual([]);
    expect(queryLimsEntitiesInDb(db, { id: plasmid.id })).toHaveLength(1);

    const archived = queryLimsEntitiesInDb(db, {
      kind: 'oligo',
      nameLike: 'Undoable primer',
      includeArchived: true,
    });
    expect(archived).toHaveLength(1);
    expect(archived[0].tombstone).toBe(true);

    const activeLink = db
      .prepare(`SELECT * FROM lims_link WHERE to_entity_id = ? AND tombstone = 0`)
      .get(plasmid.id);
    expect(activeLink).toBeUndefined();
    const undoAudit = db
      .prepare(`SELECT event_type, actor FROM lims_audit WHERE event_type = 'import_batch_undone'`)
      .get() as { event_type: string; actor: string };
    expect(undoAudit).toEqual({ event_type: 'import_batch_undone', actor: 'tester' });
  });

  it('refuses to undo non-import batches or an import batch that was already undone', () => {
    const entity = registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'Manual batch entity',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
        use: 'primer',
      },
      batchId: 'manual-batch',
    });

    expect(() => undoLimsImportBatchInDb(db, { batchId: 'manual-batch' })).toThrow(
      /No applied LIMS import batch found/
    );

    applyLimsImportBatchInDb(db, {
      batchId: 'import-batch-modified',
      sourceName: 'primers.csv',
      sourceKind: 'csv',
      records: [
        {
          id: 'row-1',
          action: 'register_entity',
          accepted: true,
          entity: {
            kind: 'oligo',
            name: 'Modified imported primer',
            fields: {
              sequence: {
                mode: 'inline',
                bases: 'CAGGAAACAGCTATGAC',
                topology: 'linear',
                length: 17,
              },
              use: 'primer',
            },
          },
          source: { Name: 'Modified imported primer' },
        },
      ],
    });
    const imported = queryLimsEntitiesInDb(db, {
      kind: 'oligo',
      nameLike: 'Modified imported primer',
    })[0];
    expect(imported).toBeTruthy();

    expect(entity.name).toBe('Manual batch entity');
    registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'Unrelated active primer',
      fields: {
        sequence: { mode: 'inline', bases: 'AAAAAAAAAAAAAAAAA', topology: 'linear', length: 17 },
        use: 'primer',
      },
    });
    expect(() => undoLimsImportBatchInDb(db, { batchId: 'import-batch-modified' })).not.toThrow();
    expect(() => undoLimsImportBatchInDb(db, { batchId: 'import-batch-modified' })).toThrow(
      /already been undone/
    );
  });

  it('refuses to undo imported entities that were modified after import', () => {
    applyLimsImportBatchInDb(db, {
      batchId: 'import-batch-modified-after-import',
      sourceName: 'primers.csv',
      sourceKind: 'csv',
      records: [
        {
          id: 'row-1',
          action: 'register_entity',
          accepted: true,
          entity: {
            kind: 'oligo',
            name: 'Modified imported primer',
            fields: {
              sequence: {
                mode: 'inline',
                bases: 'CAGGAAACAGCTATGAC',
                topology: 'linear',
                length: 17,
              },
              use: 'primer',
            },
          },
          source: { Name: 'Modified imported primer' },
        },
      ],
    });
    const imported = queryLimsEntitiesInDb(db, {
      kind: 'oligo',
      nameLike: 'Modified imported primer',
    })[0];
    expect(imported).toBeTruthy();

    updateLimsEntityInDb(db, {
      id: imported.id,
      fields: { notes: 'reviewed after import' },
    });

    expect(() =>
      undoLimsImportBatchInDb(db, { batchId: 'import-batch-modified-after-import' })
    ).toThrow(/modified since import/);
  });

  it('applies import links from existing source entities to newly imported records', () => {
    const plasmid = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'pUC19',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
      },
    });

    const result = applyLimsImportBatchInDb(db, {
      sourceName: 'strains.csv',
      sourceKind: 'csv',
      records: [
        {
          id: 'row-2',
          action: 'register_entity',
          accepted: true,
          entity: {
            kind: 'strain',
            name: 'Demo strain',
            fields: {
              genotypeCanonical: 'argFΔ; g.1414A>T',
              organismName: 'Escherichia coli K-12 MG1655',
            },
          },
          links: [
            {
              type: 'carried_by',
              fromEntityId: plasmid.id,
              payload: { role: 'carried_plasmid' },
            },
          ],
          source: { 'Plasmid Carried': 'pUC19' },
        },
      ],
      oracle: { ok: true, source: 'csv:strains.csv', invariants: [] },
    });

    expect(result).toMatchObject({ insertedEntities: 1, insertedLinks: 1, skipped: 0 });
    const strain = queryLimsEntitiesInDb(db, { kind: 'strain', nameLike: 'Demo strain' })[0];
    const link = db
      .prepare(`SELECT * FROM lims_link WHERE from_entity_id = ? AND to_entity_id = ?`)
      .get(plasmid.id, strain.id) as { type: string; payload: string };
    expect(link.type).toBe('carried_by');
    expect(JSON.parse(link.payload)).toMatchObject({ role: 'carried_plasmid' });
  });

  it('rejects imported file-backed sequence records with non-resolvable display paths', () => {
    expect(() =>
      applyLimsImportBatchInDb(db, {
        sourceName: 'pUC19.gb',
        sourceKind: 'genbank',
        records: [
          {
            id: 'sequence-file-1',
            action: 'register_entity',
            accepted: true,
            entity: {
              kind: 'plasmid',
              name: 'pUC19',
              fields: {
                sequence: {
                  mode: 'file',
                  relPath: 'pUC19.gb',
                  topology: 'circular',
                  length: 2686,
                  contentHash:
                    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                  sourceFormat: 'gb',
                },
              },
              registrationStatus: 'registered',
            },
            source: { fileName: 'pUC19.gb' },
          },
        ],
      })
    ).toThrow(/durable source path|resolvable/i);

    expect(queryLimsEntitiesInDb(db, { nameLike: 'pUC19' })).toEqual([]);
  });

  it('bridges LIMS primer oligos with legacy primers without touching bindings', () => {
    const now = Date.now();
    db.prepare(`INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)`).run(
      1,
      'Test',
      '/tmp/workspace',
      now
    );
    db.prepare(
      `INSERT INTO indexed_files (id, workspace_id, path, name, extension, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(1, 1, '/tmp/workspace/ref.gb', 'ref.gb', 'gb', now);
    db.prepare(
      `INSERT INTO sequences (id, file_id, name, length, circular) VALUES (?, ?, ?, ?, ?)`
    ).run(1, 1, 'ref', 100, 1);
    db.prepare(
      `INSERT INTO primers (
        id, catalog_number, name, sequence, length, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('legacy-1', 'WP0001', 'legacy primer', 'ATGCGATCGATCGATCG', 17, now, now);
    db.prepare(
      `INSERT INTO primer_bindings (
        id, primer_id, sequence_id, binding_start, binding_end, strand, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('binding-1', 'legacy-1', 1, 1, 17, 1, 'manual', now, now);

    registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'lims primer',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
        use: 'primer',
      },
    });

    const union = getAllLimsPrimersInDb(db);
    expect(union.map((row) => row.source).sort()).toEqual(['legacy_primers', 'lims']);
    const bindingCount = db
      .prepare(`SELECT COUNT(*) as count FROM primer_bindings WHERE primer_id = 'legacy-1'`)
      .get() as { count: number };
    expect(bindingCount.count).toBe(1);
  });

  it('applies JSON field filters before limiting query results', () => {
    const matching = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'old accepted assembly product',
      fields: {
        acceptedAssemblyVersionId: 'accepted-1',
        sequence: {
          mode: 'file',
          relPath: '/tmp/old-product.gb',
          topology: 'circular',
          length: 100,
          contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          sourceFormat: 'gb',
        },
      },
    });
    const newer = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'new unrelated plasmid',
      fields: {
        sequence: {
          mode: 'file',
          relPath: '/tmp/newer.gb',
          topology: 'circular',
          length: 100,
          contentHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          sourceFormat: 'gb',
        },
      },
    });
    db.prepare(`UPDATE lims_entity SET updated_at = ? WHERE id = ?`).run(1, matching.id);
    db.prepare(`UPDATE lims_entity SET updated_at = ? WHERE id = ?`).run(2, newer.id);

    const rows = queryLimsEntitiesInDb(db, {
      kind: 'plasmid',
      fieldEquals: { acceptedAssemblyVersionId: 'accepted-1' },
      limit: 1,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(matching.id);
  });

  it('finds a file-backed protein by its logical sequence document id', () => {
    const protein = registerLimsEntityInDb(db, {
      kind: 'protein',
      name: 'Reporter',
      fields: {
        sequence: {
          mode: 'file',
          documentId: 'protein-document-reporter',
          relPath: '/workspace/proteins/reporter.faa',
          length: 4,
          contentHash: `sha256:${'a'.repeat(64)}`,
          sourceFormat: 'fasta',
        },
      },
    });
    registerLimsEntityInDb(db, {
      kind: 'protein',
      name: 'Other protein',
      fields: {
        sequence: {
          mode: 'file',
          documentId: 'protein-document-other',
          relPath: '/workspace/proteins/other.faa',
          length: 4,
          contentHash: `sha256:${'b'.repeat(64)}`,
          sourceFormat: 'fasta',
        },
      },
    });

    const rows = queryLimsEntitiesInDb(db, {
      kind: 'protein',
      sequenceDocumentId: 'protein-document-reporter',
      includeArchived: true,
      limit: 1,
    });

    expect(rows.map((row) => row.id)).toEqual([protein.id]);
  });

  it('queries a single entity by id for registry open resolution', () => {
    const plasmid = registerLimsEntityInDb(db, {
      id: 'demo-dna509-plasmid-puc19',
      kind: 'plasmid',
      name: 'pUC19',
      fields: {
        sequence: {
          mode: 'file',
          documentId: 'sequence-document-puc19',
          relPath: '/tmp/pUC19.gb',
          topology: 'circular',
          length: 2686,
          contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          sourceFormat: 'gb',
        },
      },
      registrationStatus: 'registered',
    });
    registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'other plasmid',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
      },
    });

    const rows = queryLimsEntitiesInDb(db, {
      id: 'demo-dna509-plasmid-puc19',
      kind: 'plasmid',
      limit: 1,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(plasmid.id);
    expect(rows[0].name).toBe('pUC19');
  });

  it('honors exact entity id before updated_at ordering or limit are applied', () => {
    const plasmid = registerLimsEntityInDb(db, {
      id: 'demo-dna509-plasmid-puc19',
      kind: 'plasmid',
      name: 'pUC19',
      fields: {
        sequence: {
          mode: 'file',
          relPath: '/tmp/pUC19.gb',
          topology: 'circular',
          length: 2686,
          contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          sourceFormat: 'gb',
        },
      },
      registrationStatus: 'registered',
    });
    const wgs = registerLimsEntityInDb(db, {
      id: 'demo-dna509-genome-wgs',
      kind: 'genome',
      name: 'Demo verified WGS',
      fields: {
        sequence: {
          mode: 'file',
          relPath: '/tmp/dna509-verified-wgs.gb',
          topology: 'linear',
          length: 77340,
          contentHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          sourceFormat: 'gb',
        },
      },
      registrationStatus: 'registered',
    });
    db.prepare(`UPDATE lims_entity SET updated_at = ? WHERE id = ?`).run(1, plasmid.id);
    db.prepare(`UPDATE lims_entity SET updated_at = ? WHERE id = ?`).run(2, wgs.id);

    const rows = queryLimsEntitiesInDb(db, {
      id: 'demo-dna509-plasmid-puc19',
      includeArchived: true,
      limit: 1,
    });

    expect(rows.map((row) => row.id)).toEqual(['demo-dna509-plasmid-puc19']);
    expect(rows[0].kind).toBe('plasmid');
    expect(rows[0].name).toBe('pUC19');
  });

  it('rejects a second active LIMS owner for the same file-backed sequence', () => {
    const owner = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'pUC19 sequence owner',
      fields: {
        sequence: {
          mode: 'file',
          documentId: 'sequence-document-puc19',
          relPath: '/tmp/pUC19.gb',
          topology: 'circular',
          length: 2686,
          contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          sourceFormat: 'gb',
        },
      },
    });
    const auditCountBefore = (
      db.prepare(`SELECT COUNT(*) as count FROM lims_audit`).get() as {
        count: number;
      }
    ).count;

    expect(() =>
      registerLimsEntityInDb(db, {
        kind: 'plasmid',
        name: 'duplicate pUC19 owner',
        fields: {
          sequence: {
            mode: 'file',
            documentId: 'sequence-document-puc19',
            relPath: '/tmp/pUC19.gb',
            topology: 'circular',
            length: 2687,
            contentHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            sourceFormat: 'gb',
          },
        },
      })
    ).toThrow(/already owned by active LIMS entity/);

    const candidates = getLimsRegistrationBadgeCandidatesInDb(db, {
      documentId: 'sequence-document-puc19',
    });

    expect(candidates.map((candidate) => candidate.entity.id)).toEqual([owner.id]);
    expect(
      (
        db
          .prepare(`SELECT COUNT(*) as count FROM lims_entity WHERE name = ?`)
          .get('duplicate pUC19 owner') as { count: number }
      ).count
    ).toBe(0);
    expect(
      (db.prepare(`SELECT COUNT(*) as count FROM lims_audit`).get() as { count: number }).count
    ).toBe(auditCountBefore);
  });

  it('allows separate active file owners for identical sequence content at different paths', () => {
    const contentHash = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const first = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'pUC19 design copy A',
      fields: {
        sequence: {
          mode: 'file',
          relPath: '/tmp/pUC19-copy-a.gb',
          topology: 'circular',
          length: 2686,
          contentHash,
          normalizedSequenceHash: contentHash,
          sourceFormat: 'gb',
        },
      },
    });
    const second = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'pUC19 design copy B',
      fields: {
        sequence: {
          mode: 'file',
          relPath: '/tmp/pUC19-copy-b.gb',
          topology: 'circular',
          length: 2686,
          contentHash,
          normalizedSequenceHash: contentHash,
          sourceFormat: 'gb',
        },
      },
    });

    expect(first.fields.sequence).toMatchObject({ relPath: '/tmp/pUC19-copy-a.gb' });
    expect(second.fields.sequence).toMatchObject({ relPath: '/tmp/pUC19-copy-b.gb' });
  });

  it('allows a file-backed sequence path to be reused after the old owner is archived', () => {
    const archived = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'archived pUC19 owner',
      fields: {
        sequence: {
          mode: 'file',
          documentId: 'sequence-document-puc19',
          relPath: '/tmp/pUC19.gb',
          topology: 'circular',
          length: 2686,
          contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          sourceFormat: 'gb',
        },
      },
    });
    archiveLimsEntityInDb(db, { id: archived.id });

    const replacement = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'replacement pUC19 owner',
      fields: {
        sequence: {
          mode: 'file',
          documentId: 'sequence-document-puc19',
          relPath: '/tmp/pUC19.gb',
          topology: 'circular',
          length: 2687,
          contentHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          sourceFormat: 'gb',
        },
      },
    });

    const candidates = getLimsRegistrationBadgeCandidatesInDb(db, {
      documentId: 'sequence-document-puc19',
    });

    expect(candidates.map((candidate) => candidate.entity.id)).toEqual([replacement.id]);
  });

  it('rejects updating an entity onto another active file-backed sequence owner', () => {
    const owner = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'pUC19 owner',
      fields: {
        sequence: {
          mode: 'file',
          documentId: 'sequence-document-puc19',
          relPath: '/tmp/pUC19.gb',
          topology: 'circular',
          length: 2686,
          contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          sourceFormat: 'gb',
        },
      },
    });
    const mover = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'different sequence owner',
      fields: {
        sequence: {
          mode: 'file',
          documentId: 'sequence-document-different',
          relPath: '/tmp/different.gb',
          topology: 'circular',
          length: 2686,
          contentHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          sourceFormat: 'gb',
        },
      },
    });

    expect(() =>
      updateLimsEntityInDb(db, {
        id: mover.id,
        fields: {
          sequence: {
            mode: 'file',
            documentId: 'sequence-document-puc19',
            relPath: '/tmp/pUC19.gb',
            topology: 'circular',
            length: 2686,
            contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            sourceFormat: 'gb',
          },
        },
      })
    ).toThrow(/already owned by active LIMS entity/);

    const moverAfter = queryLimsEntitiesInDb(db, { id: mover.id, limit: 1 })[0];
    expect(moverAfter.fields.sequence).toMatchObject({ relPath: '/tmp/different.gb' });
    expect(
      getLimsRegistrationBadgeCandidatesInDb(db, { documentId: 'sequence-document-puc19' })
    ).toHaveLength(1);
    expect(
      getLimsRegistrationBadgeCandidatesInDb(db, { documentId: 'sequence-document-puc19' })[0]
        .entity.id
    ).toBe(owner.id);
  });

  it('allows updating the current active owner without changing its file-backed sequence path', () => {
    const owner = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'pUC19 owner',
      fields: {
        sequence: {
          mode: 'file',
          relPath: '/tmp/pUC19.gb',
          topology: 'circular',
          length: 2686,
          contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          sourceFormat: 'gb',
        },
      },
    });

    const updated = updateLimsEntityInDb(db, {
      id: owner.id,
      name: 'pUC19 owner with reviewed annotations',
    });

    expect(updated.name).toBe('pUC19 owner with reviewed annotations');
    expect(updated.fields.sequence).toMatchObject({ relPath: '/tmp/pUC19.gb' });
  });

  it('includes chromosome entities in registration badge candidates for file-backed linear sequences', () => {
    const chromosome = registerLimsEntityInDb(db, {
      kind: 'chromosome',
      name: 'E. coli MG1655 region',
      fields: {
        sequence: {
          mode: 'file',
          documentId: 'sequence-document-mg1655-region',
          relPath: '/tmp/ecoli-mg1655-region.gb',
          topology: 'linear',
          length: 77340,
          contentHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          sourceFormat: 'gb',
        },
        moleculeType: 'chromosome',
      },
    });

    const candidates = getLimsRegistrationBadgeCandidatesInDb(db, {
      documentId: 'sequence-document-mg1655-region',
    });

    expect(candidates.map((candidate) => candidate.entity.id)).toEqual([chromosome.id]);
    expect(candidates[0].entity.kind).toBe('chromosome');
  });

  it('finds base DNA sequence registrations without treating protein files as DNA', () => {
    const sequence = registerLimsEntityInDb(db, {
      kind: 'sequence',
      name: 'Base DNA sequence',
      fields: {
        sequence: {
          mode: 'file',
          documentId: 'sequence-document-base',
          relPath: '/tmp/base-sequence.gb',
          topology: 'linear',
          length: 42,
          contentHash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
          sourceFormat: 'gb',
        },
      },
      registrationStatus: 'registered',
    });
    registerLimsEntityInDb(db, {
      kind: 'protein',
      name: 'Protein file',
      fields: {
        sequence: {
          mode: 'file',
          documentId: 'protein-document',
          relPath: '/tmp/protein.faa',
          length: 14,
          contentHash: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          sourceFormat: 'fasta',
        },
      },
      registrationStatus: 'registered',
    });

    const candidates = getLimsRegistrationBadgeCandidatesInDb(db, {
      documentId: 'sequence-document-base',
    });

    expect(candidates.map((candidate) => candidate.entity.id)).toEqual([sequence.id]);
    expect(getLimsRegistrationBadgeCandidatesInDb(db, { documentId: 'protein-document' })).toEqual(
      []
    );
  });

  it('records parent and supplied genome hypothesis evidence, then surfaces WGS disagreement', () => {
    const ctx = createFileTestDb('lims-genome-evidence');
    try {
      ensureSchema(ctx.db, ctx.dbPath);
      seedOriginalProjectFixture(ctx.db, originalProject);
      const parentPath = join(ctx.tmpDir, 'ecoli-mg1655-region.gb');
      const hypothesisPath = join(ctx.tmpDir, 'dna509-genome-hypothesis.gb');
      const verifiedPath = join(ctx.tmpDir, 'dna509-verified.gb');
      copyFileSync(ECOLI_REGION, parentPath);
      const parentSequence = parseGenBankFull(readFileSync(parentPath, 'utf8'));
      const hypothesisBases = deleteRange(parentSequence.sequence, 5320, 6324);
      const hypothesisSequence = {
        ...parentSequence,
        id: 'hypothesis-dna509',
        name: 'Demo supplied genome hypothesis',
        sequence: hypothesisBases,
        length: hypothesisBases.length,
        annotations: [],
      };
      writeFileSync(hypothesisPath, serializeGenBank(hypothesisSequence), 'utf8');

      const parent = registerLimsEntityInDb(ctx.db, {
        kind: 'genome',
        name: 'E. coli K-12 MG1655 region',
        fields: {
          sequence: fileSequenceRef(parentPath),
          source: 'reference',
          assemblyLevel: 'contig',
        },
      });
      const strain = registerLimsEntityInDb(ctx.db, {
        kind: 'strain',
        name: 'Demo argF deletion strain',
        fields: {
          genotypeCanonical: 'argFΔ; g.1414A>T',
          source: 'fixture',
        },
      });
      const hypothesis = registerLimsEntityInDb(ctx.db, {
        kind: 'genome',
        name: 'Demo supplied genome hypothesis',
        fields: {
          sequence: fileSequenceRef(hypothesisPath),
          source: 'other',
          assemblyLevel: 'contig',
          notes: 'Externally supplied genome hypothesis fixture, not WGS verified.',
        },
      });

      const parentEvidence = recordLimsStrainParentGenomeInDb(ctx.db, {
        strainEntityId: strain.id,
        parentGenomeEntityId: parent.id,
      });
      expect(parentEvidence.link).toMatchObject({
        fromEntityId: strain.id,
        toEntityId: parent.id,
        type: 'references',
      });
      expect(parentEvidence.link.payload).toMatchObject({
        role: 'parent_genome',
        confidence: 'genotype_parent_reference',
        genotype: 'argFΔ; g.1414A>T',
      });

      const attachedHypothesis = attachGenomeHypothesisInDb(ctx.db, {
        strainEntityId: strain.id,
        hypothesisGenomeEntityId: hypothesis.id,
        parentGenomeEntityId: parent.id,
        method: 'supplied_genome_hypothesis',
      });
      expect(attachedHypothesis.hasGenomeLink.payload).toMatchObject({
        confidence: 'hypothesis_supplied',
        method: 'supplied_genome_hypothesis',
      });
      expect(attachedHypothesis.derivesFromLink).toMatchObject({
        fromEntityId: hypothesis.id,
        toEntityId: parent.id,
        type: 'derives_from',
      });
      expect(attachedHypothesis.gap).toMatchObject({
        status: 'no_verified',
        hypothesisGenomeId: hypothesis.id,
      });

      const verifiedSequence = {
        ...hypothesisSequence,
        id: 'verified-dna509',
        name: 'Demo verified WGS',
        sequence: replaceBase(hypothesisSequence.sequence, 10, 'A'),
      };
      writeFileSync(verifiedPath, serializeGenBank(verifiedSequence), 'utf8');
      const verified = registerLimsEntityInDb(ctx.db, {
        kind: 'genome',
        name: 'Demo verified WGS',
        fields: {
          sequence: fileSequenceRef(verifiedPath),
          source: 'WGS',
          assemblyLevel: 'contig',
        },
      });

      const attached = attachVerifiedLimsGenomeInDb(ctx.db, {
        strainEntityId: strain.id,
        hypothesisGenomeEntityId: hypothesis.id,
        verifiedGenomeEntityId: verified.id,
        method: 'WGS',
        coverage: 94,
      });

      expect(attached.hasGenomeLink.payload).toMatchObject({
        confidence: 'WGS_verified',
        method: 'WGS',
        coverage: 94,
      });
      expect(attached.verifiedByLink?.type).toBe('verified_by');
      expect(attached.gap).toMatchObject({
        status: 'mismatch',
        hypothesisGenomeId: hypothesis.id,
        verifiedGenomeId: verified.id,
        mismatchCount: 1,
        lengthDelta: 0,
      });
      expect(attached.gap.firstDifferences?.[0]).toMatchObject({
        position: 10,
        hypothesisBase: expect.any(String),
        verifiedBase: expect.any(String),
      });

      const summary = getLimsStrainGenomeSummaryInDb(ctx.db, { strainEntityId: strain.id });
      expect(summary.parentGenome?.id).toBe(parent.id);
      expect(summary.hypothesisGenome?.id).toBe(hypothesis.id);
      expect(summary.verifiedGenome?.id).toBe(verified.id);
      expect(summary.gap.status).toBe('mismatch');
    } finally {
      ctx.cleanup();
    }
  });

  it('reports clean WGS verification when the supplied hypothesis and verified genome match', () => {
    const ctx = createFileTestDb('lims-genome-evidence-match');
    try {
      ensureSchema(ctx.db, ctx.dbPath);
      seedOriginalProjectFixture(ctx.db, originalProject);
      const parentPath = join(ctx.tmpDir, 'ecoli-mg1655-region.gb');
      const hypothesisPath = join(ctx.tmpDir, 'dna509-genome-hypothesis.gb');
      const verifiedPath = join(ctx.tmpDir, 'dna509-verified-match.gb');
      copyFileSync(ECOLI_REGION, parentPath);
      const parentSequence = parseGenBankFull(readFileSync(parentPath, 'utf8'));
      const hypothesisBases = deleteRange(parentSequence.sequence, 5320, 6324);
      const hypothesisSequence = {
        ...parentSequence,
        id: 'hypothesis-dna509-match',
        name: 'Demo supplied genome hypothesis',
        sequence: hypothesisBases,
        length: hypothesisBases.length,
        annotations: [],
      };
      writeFileSync(hypothesisPath, serializeGenBank(hypothesisSequence), 'utf8');
      writeFileSync(
        verifiedPath,
        serializeGenBank({
          ...hypothesisSequence,
          id: 'verified-dna509-match',
          name: 'Demo verified WGS',
        }),
        'utf8'
      );

      const parent = registerLimsEntityInDb(ctx.db, {
        kind: 'genome',
        name: 'E. coli K-12 MG1655 region',
        fields: {
          sequence: fileSequenceRef(parentPath),
          source: 'reference',
          assemblyLevel: 'contig',
        },
      });
      const strain = registerLimsEntityInDb(ctx.db, {
        kind: 'strain',
        name: 'Demo exact-match strain',
        fields: {
          genotypeCanonical: 'argFΔ',
          source: 'fixture',
        },
      });
      const hypothesis = registerLimsEntityInDb(ctx.db, {
        kind: 'genome',
        name: 'Demo supplied genome hypothesis',
        fields: {
          sequence: fileSequenceRef(hypothesisPath),
          source: 'other',
          assemblyLevel: 'contig',
        },
      });
      const verified = registerLimsEntityInDb(ctx.db, {
        kind: 'genome',
        name: 'Demo verified WGS',
        fields: {
          sequence: fileSequenceRef(verifiedPath),
          source: 'WGS',
          assemblyLevel: 'contig',
        },
      });

      recordLimsStrainParentGenomeInDb(ctx.db, {
        strainEntityId: strain.id,
        parentGenomeEntityId: parent.id,
      });
      attachGenomeHypothesisInDb(ctx.db, {
        strainEntityId: strain.id,
        hypothesisGenomeEntityId: hypothesis.id,
        parentGenomeEntityId: parent.id,
        method: 'supplied_genome_hypothesis',
      });
      const attached = attachVerifiedLimsGenomeInDb(ctx.db, {
        strainEntityId: strain.id,
        hypothesisGenomeEntityId: hypothesis.id,
        verifiedGenomeEntityId: verified.id,
        method: 'WGS',
        coverage: 98,
      });

      expect(attached.gap).toMatchObject({
        status: 'match',
        hypothesisGenomeId: hypothesis.id,
        verifiedGenomeId: verified.id,
        mismatchCount: 0,
        lengthDelta: 0,
        firstDifferences: [],
        message: 'Genome hypothesis matches the WGS-verified genome exactly.',
      });

      const summary = getLimsStrainGenomeSummaryInDb(ctx.db, { strainEntityId: strain.id });
      expect(summary.parentGenome?.id).toBe(parent.id);
      expect(summary.hypothesisGenome?.id).toBe(hypothesis.id);
      expect(summary.verifiedGenome?.id).toBe(verified.id);
      expect(summary.gap).toMatchObject({
        status: 'match',
        mismatchCount: 0,
        lengthDelta: 0,
      });
      expect(summary.gap.message).not.toContain('disagrees');
    } finally {
      ctx.cleanup();
    }
  });

  it('seeds an idempotent Demo demo dataset from real fixtures and surfaces the WGS gap', () => {
    const ctx = createFileTestDb('lims-demo-dataset');
    try {
      ensureSchema(ctx.db, ctx.dbPath);
      seedOriginalProjectFixture(ctx.db, originalProject);
      const outputDir = join(ctx.tmpDir, 'demo-output');

      const seeded = seedLimsDemoDatasetInDb(ctx.db, { outputDir, actor: 'test' });

      expect(seeded).toMatchObject({
        insertedEntities: 10,
        existingEntities: 0,
        insertedLinks: 8,
        existingLinks: 0,
      });
      expect(seeded.assetSources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'parent genome', used: true }),
          expect.objectContaining({ role: 'plasmid', used: true }),
          expect.objectContaining({ role: 'primer table' }),
        ])
      );
      expect(seeded.strainSummary.strain.name).toBe('Demo argF deletion strain');
      expect(seeded.strainSummary.parentGenome?.name).toBe('MG1655 parent region');
      expect(seeded.strainSummary.hypothesisGenome?.name).toBe(
        'Demo supplied genome hypothesis'
      );
      expect(seeded.strainSummary.verifiedGenome?.name).toBe('Demo verified WGS');
      expect(seeded.strainSummary.gap).toMatchObject({
        status: 'mismatch',
        mismatchCount: 1,
        lengthDelta: 0,
      });
      expect(seeded.strainSummary.gap.firstDifferences?.[0]).toMatchObject({
        position: 10,
        hypothesisBase: expect.any(String),
        verifiedBase: expect.any(String),
      });

      const genomes = queryLimsEntitiesInDb(ctx.db, { kind: 'genome', limit: 20 });
      expect(genomes.map((genome) => genome.name).sort()).toEqual([
        'Demo supplied genome hypothesis',
        'Demo verified WGS',
        'MG1655 parent region',
      ]);
      const oligos = queryLimsEntitiesInDb(ctx.db, { kind: 'oligo', limit: 20 });
      expect(oligos.map((oligo) => oligo.name).sort()).toEqual([
        'M13-Forward',
        'M13-Reverse',
        'SP6-Promoter',
        'T7-Promoter',
      ]);
      const hypothesisSequence = seeded.strainSummary.hypothesisGenome?.fields.sequence as {
        mode?: string;
        relPath?: string;
      };
      const verifiedSequence = seeded.strainSummary.verifiedGenome?.fields.sequence as {
        mode?: string;
        relPath?: string;
      };
      expect(hypothesisSequence).toMatchObject({ mode: 'file' });
      expect(verifiedSequence).toMatchObject({ mode: 'file' });
      expect(readFileSync(hypothesisSequence.relPath ?? '', 'utf8')).toContain('LOCUS');
      expect(readFileSync(verifiedSequence.relPath ?? '', 'utf8')).toContain('LOCUS');

      const seededAgain = seedLimsDemoDatasetInDb(ctx.db, { outputDir, actor: 'test' });
      expect(seededAgain).toMatchObject({
        insertedEntities: 0,
        existingEntities: 10,
        insertedLinks: 0,
        existingLinks: 8,
      });
      const activeEntityCount = ctx.db
        .prepare(`SELECT COUNT(*) as count FROM lims_entity WHERE tombstone = 0`)
        .get() as { count: number };
      const activeLinkCount = ctx.db
        .prepare(`SELECT COUNT(*) as count FROM lims_link WHERE tombstone = 0`)
        .get() as { count: number };
      expect(activeEntityCount.count).toBe(10);
      expect(activeLinkCount.count).toBe(8);
    } finally {
      ctx.cleanup();
    }
  });

  it('returns registry summaries for direct pUC19 search without promoting linked primers into rows', () => {
    const ctx = createFileTestDb('lims-registry-summary-search');
    try {
      ensureSchema(ctx.db, ctx.dbPath);
      seedOriginalProjectFixture(ctx.db, originalProject);
      seedLimsDemoDatasetInDb(ctx.db, { outputDir: join(ctx.tmpDir, 'demo-output') });

      const page = queryLimsRegistrySummariesInDb(ctx.db, {
        search: 'pUC19',
        limit: 20,
        offset: 0,
        sort: 'name_asc',
      });

      expect(page).toMatchObject({
        totalCount: 1,
        limit: 20,
        offset: 0,
      });
      expect(page.summaries.map((summary) => summary.id)).toEqual(['demo-dna509-plasmid-puc19']);
      const pUc19 = page.summaries[0];
      expect(pUc19).toMatchObject({
        id: 'demo-dna509-plasmid-puc19',
        kind: 'plasmid',
        name: 'pUC19',
        registrationStatus: 'registered',
        representation: {
          kind: 'file_sequence',
          canOpen: true,
          openTarget: {
            kind: 'sequence_file',
            entityId: 'demo-dna509-plasmid-puc19',
            entityKind: 'plasmid',
            label: 'pUC19',
            registrationStatus: 'registered',
          },
        },
        sequenceSummary: {
          topology: 'circular',
          length: 2686,
          sourceFormat: 'gb',
        },
      });
      const pUc19OpenTarget = pUc19.representation.openTarget;
      expect(pUc19OpenTarget?.kind).toBe('sequence_file');
      if (pUc19OpenTarget?.kind === 'sequence_file') {
        expect(pUc19OpenTarget.sequence).toMatchObject({
          topology: 'circular',
          length: 2686,
          sourceFormat: 'gb',
        });
      }
      expect(pUc19.linkSummary.notable).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'associated_with', label: 'M13-Forward' }),
          expect.objectContaining({ type: 'associated_with', label: 'M13-Reverse' }),
        ])
      );
      expect(page.summaries.some((summary) => summary.kind === 'oligo')).toBe(false);
    } finally {
      ctx.cleanup();
    }
  });

  it('returns inline oligo bases in registry summaries for primer rows', () => {
    const ctx = createFileTestDb('lims-registry-summary-oligo-bases');
    try {
      ensureSchema(ctx.db, ctx.dbPath);
      seedOriginalProjectFixture(ctx.db, originalProject);
      seedLimsDemoDatasetInDb(ctx.db, { outputDir: join(ctx.tmpDir, 'demo-output') });

      const page = queryLimsRegistrySummariesInDb(ctx.db, {
        kind: 'oligo',
        search: 'M13-Forward',
        limit: 20,
        offset: 0,
        sort: 'name_asc',
      });

      expect(page).toMatchObject({ totalCount: 1 });
      expect(page.summaries[0]).toMatchObject({
        id: 'demo-dna509-oligo-m13-forward',
        kind: 'oligo',
        name: 'M13-Forward',
        representation: {
          kind: 'inline_sequence',
          label: 'Oligo sequence',
          canOpen: false,
        },
        sequenceSummary: {
          topology: 'linear',
          length: 17,
          inlineBases: 'GTAAAACGACGGCCAGT',
        },
      });
    } finally {
      ctx.cleanup();
    }
  });

  it('summarizes Demo strain evidence through the registry read model and batched API', () => {
    const ctx = createFileTestDb('lims-registry-summary-strain');
    try {
      ensureSchema(ctx.db, ctx.dbPath);
      seedOriginalProjectFixture(ctx.db, originalProject);
      seedLimsDemoDatasetInDb(ctx.db, { outputDir: join(ctx.tmpDir, 'demo-output') });

      const page = queryLimsRegistrySummariesInDb(ctx.db, {
        kind: 'strain',
        limit: 10,
        offset: 0,
      });
      const strain = page.summaries.find((summary) => summary.id === 'demo-dna509-strain-argf');

      expect(strain).toMatchObject({
        id: 'demo-dna509-strain-argf',
        kind: 'strain',
        name: 'Demo argF deletion strain',
        representation: {
          kind: 'strain_evidence',
          canOpen: false,
        },
        evidenceSummary: {
          confidenceLabel: 'WGS verified with mismatch',
          gapStatus: 'mismatch',
          parentGenomeName: 'MG1655 parent region',
          hypothesisGenomeName: 'Demo supplied genome hypothesis',
          verifiedGenomeName: 'Demo verified WGS',
        },
      });
      expect(strain?.summary).toContain('argF');

      const batched = getLimsStrainGenomeSummariesInDb(ctx.db, {
        strainEntityIds: ['demo-dna509-strain-argf'],
      });
      expect(batched.summaries['demo-dna509-strain-argf']).toMatchObject({
        parentGenome: { name: 'MG1655 parent region' },
        hypothesisGenome: { name: 'Demo supplied genome hypothesis' },
        verifiedGenome: { name: 'Demo verified WGS' },
        gap: { status: 'mismatch' },
      });
    } finally {
      ctx.cleanup();
    }
  });

  it('paginates, filters, and sorts registry summaries with stable counts', () => {
    const ctx = createFileTestDb('lims-registry-summary-pagination');
    try {
      ensureSchema(ctx.db, ctx.dbPath);
      seedOriginalProjectFixture(ctx.db, originalProject);
      seedLimsDemoDatasetInDb(ctx.db, { outputDir: join(ctx.tmpDir, 'demo-output') });

      const firstPage = queryLimsRegistrySummariesInDb(ctx.db, {
        limit: 3,
        offset: 0,
        sort: 'name_asc',
      });
      const secondPage = queryLimsRegistrySummariesInDb(ctx.db, {
        limit: 3,
        offset: 3,
        sort: 'name_asc',
      });
      const fileBacked = queryLimsRegistrySummariesInDb(ctx.db, {
        representationKind: 'file_sequence',
        sort: 'name_asc',
        limit: 20,
      });

      expect(firstPage.totalCount).toBe(10);
      expect(secondPage.totalCount).toBe(10);
      expect(new Set(firstPage.summaries.map((summary) => summary.id)).size).toBe(3);
      expect(
        firstPage.summaries.some((summary) =>
          secondPage.summaries.map((second) => second.id).includes(summary.id)
        )
      ).toBe(false);
      expect(fileBacked.summaries.map((summary) => summary.id).sort()).toEqual([
        'demo-dna509-genome-mg1655-region',
        'demo-dna509-genome-supplied-hypothesis',
        'demo-dna509-genome-wgs',
        'demo-dna509-plasmid-puc19',
      ]);
    } finally {
      ctx.cleanup();
    }
  });

  it('projects a registered file sequence using its saved genetic code', () => {
    seedLimsBuiltinsInDb(db);
    const sequence = {
      mode: 'file',
      documentId: 'sequence-mitochondrial',
      relPath: '/workspace/mitochondrial.gb',
      topology: 'linear',
      length: 30,
      geneticCode: 3,
      contentHash: `sha256:${'a'.repeat(64)}`,
      sourceFormat: 'gb',
    };
    const entity = registerLimsEntityInDb(db, {
      kind: 'sequence',
      name: 'Mitochondrial sequence',
      fields: { sequence },
      registrationStatus: 'registered',
    });

    const preview = getLimsRegistryPreviewInDb(db, { entityId: entity.id });

    expect(preview.entity.fields.sequence).toEqual(sequence);
    expect(preview.summary.fieldValues).toMatchObject({
      topology: 'linear',
      size: 30,
      geneticCode: 3,
    });
  });

  it('returns registry preview data with linked entity labels for pUC19', () => {
    const ctx = createFileTestDb('lims-registry-preview');
    try {
      ensureSchema(ctx.db, ctx.dbPath);
      seedOriginalProjectFixture(ctx.db, originalProject);
      seedLimsDemoDatasetInDb(ctx.db, { outputDir: join(ctx.tmpDir, 'demo-output') });

      const preview = getLimsRegistryPreviewInDb(ctx.db, {
        entityId: 'demo-dna509-plasmid-puc19',
      });

      expect(preview.entity.id).toBe('demo-dna509-plasmid-puc19');
      expect(preview.summary.representation).toMatchObject({
        kind: 'file_sequence',
        canOpen: true,
      });
      expect(preview.summary.sequenceSummary).toMatchObject({
        contentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        fileContentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        normalizedSequenceHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
      expect(preview.summary.sequenceSummary?.fileContentHash).toBe(
        preview.summary.sequenceSummary?.contentHash
      );
      expect(preview.incomingLinks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            link: expect.objectContaining({ type: 'associated_with' }),
            entity: expect.objectContaining({ name: 'M13-Forward' }),
            summary: expect.objectContaining({
              representation: expect.objectContaining({
                kind: 'inline_sequence',
                canOpen: false,
              }),
            }),
          }),
          expect.objectContaining({
            link: expect.objectContaining({ type: 'associated_with' }),
            entity: expect.objectContaining({ name: 'M13-Reverse' }),
            summary: expect.objectContaining({
              representation: expect.objectContaining({
                kind: 'inline_sequence',
                canOpen: false,
              }),
            }),
          }),
        ])
      );

      const primerPreview = getLimsRegistryPreviewInDb(ctx.db, {
        entityId: 'demo-dna509-oligo-m13-forward',
      });
      expect(primerPreview.entity).toMatchObject({
        id: 'demo-dna509-oligo-m13-forward',
        kind: 'oligo',
        name: 'M13-Forward',
      });
      expect(primerPreview.entity.fields.sequence).toMatchObject({
        mode: 'inline',
        bases: 'GTAAAACGACGGCCAGT',
        topology: 'linear',
        length: 17,
        contentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
      expect(primerPreview.summary.representation).toMatchObject({
        kind: 'inline_sequence',
        label: 'Oligo sequence',
        canOpen: false,
      });
      expect(primerPreview.summary.summary).toBe('Oligo sequence');
      expect(primerPreview.outgoingLinks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            link: expect.objectContaining({ type: 'associated_with' }),
            entity: expect.objectContaining({ id: 'demo-dna509-plasmid-puc19', name: 'pUC19' }),
          }),
        ])
      );
    } finally {
      ctx.cleanup();
    }
  });

  it('seeds the mock primer demo with hero links to BOTH a plasmid and a chromosome, carrying binding coordinates', () => {
    const ctx = createFileTestDb('lims-mock-demo');
    try {
      ensureSchema(ctx.db, ctx.dbPath);
      seedOriginalProjectFixture(ctx.db, originalProject);
      const result = seedLimsMockDemoInDb(ctx.db, { actor: 'test' });

      expect(result.insertedOligos).toBeGreaterThanOrEqual(1000);
      expect(result.plasmidId).toBe('mock-dna509-plasmid-puc19');
      expect(result.genomeId).toBe('mock-dna509-genome-scerevisiae-chr4');
      expect(result.heroOligoIds.length).toBeGreaterThanOrEqual(2);

      expect(result.insertedLinks).toBe(result.heroOligoIds.length);

      for (const targetId of [result.plasmidId, result.genomeId]) {
        const preview = getLimsRegistryPreviewInDb(ctx.db, { entityId: targetId });
        expect(preview.summary.representation, `${targetId} must be openable`).toMatchObject({
          kind: 'file_sequence',
          canOpen: true,
        });
        const catalogBinding = ctx.db
          .prepare(
            `SELECT catalog_entity_files.path, catalog_entity_files.status
             FROM catalog_entity_files
             WHERE catalog_entity_files.entity_id = ?`
          )
          .get(targetId) as { path: string; status: string } | undefined;
        expect(
          catalogBinding,
          `${targetId} must resolve its logical document id to a current file binding`
        ).toMatchObject({ status: 'current' });
        expect(catalogBinding?.path).toBeTruthy();
      }

      const genomePreview = getLimsRegistryPreviewInDb(ctx.db, { entityId: result.genomeId });
      expect(genomePreview.entity.kind).toBe('chromosome');
      expect(genomePreview.entity.fields.species).toBe('Saccharomyces cerevisiae');
      expect(queryLimsEntitiesInDb(ctx.db, { kind: 'organism', nameLike: 'cerevisiae' })).toEqual(
        []
      );

      const TARGET_LENGTHS: Record<string, number> = {
        [result.plasmidId]: 2686,
        [result.genomeId]: 1531933,
      };
      const linkedTargets = new Set<string>();
      for (const heroId of result.heroOligoIds) {
        const preview = getLimsRegistryPreviewInDb(ctx.db, { entityId: heroId });
        const link = preview.outgoingLinks.find((entry) => entry.link.type === 'amplifies');
        expect(link, `hero ${heroId} must have an amplifies link`).toBeTruthy();
        const targetId = link!.entity.id;
        expect(TARGET_LENGTHS[targetId], `hero ${heroId} links to a known target`).toBeTruthy();
        linkedTargets.add(targetId);
        const payload = link!.link.payload as {
          bindingStart?: number;
          bindingEnd?: number;
          orientation?: string;
        };
        expect(typeof payload.bindingStart).toBe('number');
        expect(typeof payload.bindingEnd).toBe('number');
        expect(payload.bindingStart!).toBeGreaterThanOrEqual(1);
        expect(payload.bindingEnd!).toBeLessThanOrEqual(TARGET_LENGTHS[targetId]);
        expect(payload.bindingStart!).toBeLessThanOrEqual(payload.bindingEnd!);
        expect(['forward', 'reverse']).toContain(payload.orientation);
      }

      expect(linkedTargets.has(result.genomeId), 'a hero must bind the yeast chromosome').toBe(
        true
      );
      expect(linkedTargets.has(result.plasmidId), 'a hero must bind pUC19').toBe(true);

      const again = seedLimsMockDemoInDb(ctx.db, { actor: 'test' });
      expect(again.insertedOligos).toBe(0);
      expect(again.insertedLinks).toBe(0);
    } finally {
      ctx.cleanup();
    }
  });

  it('weaveProportional interleaves two lists in proportion (not concatenated)', () => {
    const woven = weaveProportional(['P1', 'P2'], ['a', 'b', 'c', 'd', 'e', 'f']);
    expect(woven).toHaveLength(8);
    expect(woven.filter((x) => x.startsWith('P'))).toEqual(['P1', 'P2']);
    const plasmidPositions = woven
      .map((x, i) => (x.startsWith('P') ? i : -1))
      .filter((i) => i >= 0);

    expect(plasmidPositions[0]).toBeLessThan(4);
    expect(plasmidPositions[1]).toBeGreaterThanOrEqual(4);
  });

  it('seeds the practice registry: 500 file-backed circular synthetic plasmids + primers, interleaved by time', () => {
    const ctx = createFileTestDb('lims-practice-demo');
    try {
      ensureSchema(ctx.db, ctx.dbPath);
      seedOriginalProjectFixture(ctx.db, originalProject);
      const result = seedLimsPracticeDemoInDb(ctx.db, { actor: 'test', reset: true });

      expect(result.insertedPlasmids).toBe(500);
      expect(result.insertedOligos).toBeGreaterThanOrEqual(500);

      const plasmids = queryLimsEntitiesInDb(ctx.db, { kind: 'plasmid', limit: 1000 });
      expect(plasmids).toHaveLength(500);
      for (const p of plasmids) {
        const seq = p.fields.sequence as { mode?: string; topology?: string; relPath?: string };
        expect(seq.mode, `${p.name} must be file-backed`).toBe('file');
        expect(seq.topology).toBe('circular');
        expect(p.registrationStatus).toBe('registered');
        expect(p.name).toMatch(/^pSYN-\d{4}$/);
        expect(String(p.fields.notes)).toMatch(/^Synthetic practice plasmid: /);
        expect(JSON.stringify(p)).not.toMatch(/addgene/i);
      }

      const all = queryLimsEntitiesInDb(ctx.db, { limit: 5000 }).sort(
        (a, b) => a.createdAt - b.createdAt
      );
      const firstFifty = all.slice(0, 50).map((e) => e.kind);
      expect(firstFifty).toContain('plasmid');
      expect(firstFifty).toContain('oligo');
      const spanMs = all[all.length - 1].createdAt - all[0].createdAt;
      expect(spanMs).toBeGreaterThan(60 * 24 * 60 * 60 * 1000);

      expect(result.insertedGenomeEntities).toBe(10);
      const strains = queryLimsEntitiesInDb(ctx.db, { kind: 'strain', limit: 100 });
      expect(strains).toHaveLength(3);
      expect(strains.map((s) => s.fields.speciesTaxid).sort()).toEqual(['562', '562', '666']);
      const chromosomes = queryLimsEntitiesInDb(ctx.db, { kind: 'chromosome', limit: 100 });
      expect(chromosomes).toHaveLength(4);
      for (const chr of chromosomes) {
        const seq = chr.fields.sequence as { mode?: string; topology?: string };
        expect(seq.mode, `${chr.name} chromosome must be file-backed`).toBe('file');
        expect(seq.topology).toBe('circular');
        expect(chr.registrationStatus).toBe('registered');
      }

      const vc = strains.find((s) => s.id === 'practice-dna509-strain-vcholerae-n16961');
      expect(vc).toBeTruthy();
      const strainPreview = getLimsRegistryPreviewInDb(ctx.db, { entityId: vc!.id });
      const hasGenome = strainPreview.outgoingLinks.find((l) => l.link.type === 'has_genome');
      expect(hasGenome, 'V. cholerae strain must have a has_genome link').toBeTruthy();
      const genomePreview = getLimsRegistryPreviewInDb(ctx.db, { entityId: hasGenome!.entity.id });

      expect((genomePreview.entity.fields.sequence as { mode?: string }).mode).toBe('unresolved');
      const parts = genomePreview.outgoingLinks.filter((l) => l.link.type === 'has_part');
      expect(parts).toHaveLength(2);

      const mg1655Preview = getLimsRegistryPreviewInDb(ctx.db, {
        entityId: 'practice-dna509-strain-ecoli-mg1655',
      });
      const harbored = mg1655Preview.outgoingLinks.find(
        (l) => l.link.type === 'has_part' && l.entity.kind === 'plasmid'
      );
      expect(harbored, 'MG1655 strain must harbor a pGEX-4T-1 practice plasmid').toBeTruthy();
      expect(plasmids.find((p) => p.id === harbored!.entity.id)?.fields.type).toBe('pGEX-4T-1');
      expect(harbored!.summary.representation.canOpen).toBe(true);

      const chr2 = parseGenBankFull(
        readFileSync(
          join(REPO_ROOT, 'test-fixtures/genomes/vibrio-cholerae-N16961/NC_002506.1.gb'),
          'utf8'
        )
      );
      expect(chr2.sequence.length).toBe(1072315);
      expect(chr2.circular).toBe(true);
      expect(chr2.annotations.length).toBeGreaterThan(500);

      const again = seedLimsPracticeDemoInDb(ctx.db, { actor: 'test', reset: true });
      expect(again.insertedPlasmids).toBe(500);
      expect(again.insertedGenomeEntities).toBe(10);
      expect(queryLimsEntitiesInDb(ctx.db, { kind: 'plasmid', limit: 1000 })).toHaveLength(500);
    } finally {
      ctx.cleanup();
    }
  }, 30000);

  it('seeds the starter registry as a strain → genome assembly → chromosome graph with lineage (Model A)', () => {
    const ctx = createFileTestDb('lims-starter-registry');
    try {
      ensureSchema(ctx.db, ctx.dbPath);
      seedOriginalProjectFixture(ctx.db, originalProject);
      const result = seedLimsStarterRegistryInDb(ctx.db, { actor: 'test' });

      expect(result.strainIds.length).toBeGreaterThanOrEqual(6);
      expect(result.genomeIds.length).toBeGreaterThanOrEqual(2);

      expect(result.oligoIds.length).toBeGreaterThanOrEqual(60);

      const thrBFwd = getLimsRegistryPreviewInDb(ctx.db, {
        entityId: 'starter-oligo-eco-thrb-f',
      });
      expect(thrBFwd.entity.kind).toBe('oligo');
      const thrBBases = (thrBFwd.entity.fields.sequence as { bases: string }).bases;
      expect(thrBBases).toMatch(/^[ACGT]{18,28}$/);
      const ampLink = thrBFwd.outgoingLinks.find((e) => e.link.type === 'amplifies');
      expect(ampLink?.entity.id).toBe('starter-chr-ecoli-mg1655');
      expect(ampLink?.link.payload).toMatchObject({
        orientation: 'forward',
        coordsOrigin: 'reference_genome',
        gene: 'thrB',
      });

      expect(ampLink?.link.payload).toMatchObject({ bindingStart: 2801 });

      const payload = ampLink?.link.payload as { bindingStart: number; bindingEnd: number };
      expect(payload.bindingEnd - payload.bindingStart + 1).toBe(thrBBases.length);
      const mg1655Seq = readFileSync(ECOLI_COMPLETE, 'utf8')
        .split(/^ORIGIN/m)[1]
        .replace(/[^acgtACGT]/g, '')
        .toUpperCase();
      expect(
        mg1655Seq.slice(payload.bindingStart - 1, payload.bindingStart - 1 + thrBBases.length)
      ).toBe(thrBBases);

      const oligoEntities = result.oligoIds
        .map((id) => queryLimsEntitiesInDb(ctx.db, { id })[0])
        .filter((e): e is NonNullable<typeof e> => Boolean(e));
      const lengths = oligoEntities.map((e) => (e.fields.sequence as { length: number }).length);
      expect(new Set(lengths).size).toBeGreaterThan(6);
      expect(Math.max(...lengths)).toBeGreaterThanOrEqual(80);
      const uses = new Set(oligoEntities.map((e) => e.fields.use));

      expect(uses.has('mutagenesis')).toBe(true);
      expect(uses.has('gBlock')).toBe(true);
      expect(uses.has('sequencing')).toBe(true);

      const gibF = queryLimsEntitiesInDb(ctx.db, { id: 'starter-oligo-eco-thra-gib-f' })[0];
      expect((gibF?.fields.sequence as { length: number }).length).toBeGreaterThanOrEqual(45);

      expect(queryLimsEntitiesInDb(ctx.db, { kind: 'organism', nameLike: 'Escherichia' })).toEqual(
        []
      );

      const mg1655 = getLimsRegistryPreviewInDb(ctx.db, {
        entityId: 'starter-strain-ecoli-mg1655',
      });
      expect(mg1655.entity.kind).toBe('strain');
      expect(mg1655.entity.fields.species).toBe('Escherichia coli');
      expect(mg1655.outgoingLinks.some((e) => e.link.type === 'strain_of')).toBe(false);
      const hasGenome = mg1655.outgoingLinks.find((e) => e.link.type === 'has_genome');
      expect(hasGenome?.entity.id).toBe('starter-genome-ecoli-mg1655');
      const ecoliGenome = getLimsRegistryPreviewInDb(ctx.db, {
        entityId: 'starter-genome-ecoli-mg1655',
      });
      expect(ecoliGenome.entity.kind).toBe('genome');
      expect(ecoliGenome.summary.representation).toMatchObject({
        kind: 'genome_assembly',
        canOpen: false,
      });

      const ecoliChrLink = ecoliGenome.outgoingLinks.find((e) => e.link.type === 'has_part');
      expect(ecoliChrLink?.entity.kind).toBe('chromosome');
      const ecoliChr = getLimsRegistryPreviewInDb(ctx.db, { entityId: 'starter-chr-ecoli-mg1655' });
      expect(ecoliChr.summary.representation).toMatchObject({
        kind: 'file_sequence',
        canOpen: true,
      });

      const s288cGenome = getLimsRegistryPreviewInDb(ctx.db, {
        entityId: 'starter-genome-scerevisiae-s288c',
      });
      const chromosomeParts = s288cGenome.outgoingLinks.filter((e) => e.link.type === 'has_part');
      expect(chromosomeParts.length).toBe(16);
      expect(chromosomeParts.every((e) => e.entity.kind === 'chromosome')).toBe(true);

      expect(chromosomeParts.every((e) => e.summary.representation.canOpen === true)).toBe(true);
      const chrIV = getLimsRegistryPreviewInDb(ctx.db, { entityId: 'starter-chr-scerevisiae-iv' });
      expect(chrIV.entity.kind).toBe('chromosome');
      expect(chrIV.summary.representation).toMatchObject({ kind: 'file_sequence', canOpen: true });

      const by4741 = getLimsRegistryPreviewInDb(ctx.db, {
        entityId: 'starter-strain-scerevisiae-by4741',
      });
      const derivesFrom = by4741.outgoingLinks.find((e) => e.link.type === 'derives_from');
      expect(derivesFrom?.entity.id).toBe('starter-strain-scerevisiae-s288c');
      expect(derivesFrom?.link.payload).toMatchObject({
        provenance: 'literature',
        sequenceDiff: 'not_computed',
      });
      expect(String(derivesFrom?.link.payload.reference)).toContain('Brachmann');

      const w3110 = getLimsRegistryPreviewInDb(ctx.db, { entityId: 'starter-strain-ecoli-w3110' });
      const w3110Parent = w3110.outgoingLinks.find((e) => e.link.type === 'derives_from');
      expect(w3110Parent?.entity.id).toBe('starter-strain-ecoli-w1485');

      const bl21 = getLimsRegistryPreviewInDb(ctx.db, { entityId: 'starter-strain-ecoli-bl21' });
      expect(bl21.outgoingLinks.some((e) => e.link.type === 'derives_from')).toBe(false);

      const again = seedLimsStarterRegistryInDb(ctx.db, { actor: 'test' });
      expect(again.insertedEntities).toBe(0);
      expect(again.insertedLinks).toBe(0);
    } finally {
      ctx.cleanup();
    }
  }, 30000);

  it('persists registered LIMS entities and audit events across database reopen', () => {
    const ctx = createFileTestDb('lims-persistence');
    try {
      ensureSchema(ctx.db, ctx.dbPath);
      seedOriginalProjectFixture(ctx.db, originalProject);
      const entity = registerLimsEntityInDb(ctx.db, {
        kind: 'genome',
        name: 'persisted genome',
        fields: { sequence: { mode: 'unresolved' } },
        registrationStatus: 'unresolved',
      });
      ctx.db.close();

      const reopened = openFileTestDb(ctx.dbPath);
      try {
        ensureSchema(reopened, ctx.dbPath);
        const rows = queryLimsEntitiesInDb(reopened, { kind: 'genome', nameLike: 'persisted' });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          id: entity.id,
          name: 'persisted genome',
          registrationStatus: 'unresolved',
        });
        const audit = reopened
          .prepare(
            `SELECT event_type, subject_id FROM lims_audit WHERE event_type = 'entity_registered' AND subject_id = ?`
          )
          .get(entity.id) as { event_type: string; subject_id: string } | undefined;
        expect(audit).toEqual({ event_type: 'entity_registered', subject_id: entity.id });
      } finally {
        reopened.close();
      }
    } finally {
      ctx.cleanup();
    }
  });

  it('records badge-consult telemetry in the LIMS audit log', () => {
    const event = logLimsTelemetryInDb(db, {
      eventType: 'badge_consulted',
      subjectTable: 'lims_entity',
      subjectId: 'entity-1',
      payload: { filePath: '/tmp/pUC19.gb', status: 'registered' },
      actor: 'test',
    });

    const row = db.prepare(`SELECT * FROM lims_audit WHERE id = ?`).get(event.id) as {
      event_type: string;
      subject_table: string | null;
      subject_id: string | null;
      payload: string;
    };
    expect(row).toMatchObject({
      event_type: 'badge_consulted',
      subject_table: 'lims_entity',
      subject_id: 'entity-1',
    });
    expect(JSON.parse(row.payload)).toEqual({ filePath: '/tmp/pUC19.gb', status: 'registered' });
  });

  it('registers the complete LIMS IPC surface', () => {
    vi.mocked(ipcMain.handle).mockClear();

    registerLimsIpcHandlers();

    expect(
      vi
        .mocked(ipcMain.handle)
        .mock.calls.map(([channel]) => channel)
        .sort()
    ).toEqual([
      'lims:applyClassification',
      'lims:applyImportBatch',
      'lims:archiveEntity',
      'lims:attachGenomeHypothesis',
      'lims:attachVerifiedGenome',
      'lims:backfillRegistryIds',
      'lims:confirmPendingRef',
      'lims:countEntitiesByKind',
      'lims:defineSchema',
      'lims:dismissPendingRef',
      'lims:ensureSeeded',
      'lims:getAllPrimers',
      'lims:getEntityHistory',
      'lims:getIdSchemes',
      'lims:getRegistrationBadgeCandidates',
      'lims:getRegistryPreview',
      'lims:getStrainGenomeSummaries',
      'lims:getStrainGenomeSummary',
      'lims:linkEntities',
      'lims:listSchemas',
      'lims:logTelemetry',
      'lims:pendingRefs',
      'lims:queryEntities',
      'lims:queryRecordRelationshipTargets',
      'lims:queryRegistrySummaries',
      'lims:readCommittedPrimerSource',
      'lims:readPrimerArtifactRevisionState',
      'lims:reconstructLegacyAcceptedPlasmid',
      'lims:recordStrainParentGenome',
      'lims:refineSchema',
      'lims:registerEntity',
      'lims:rejectPendingRefCandidate',
      'lims:repairEntityProjectionFromAudit',
      'lims:replaceOutgoingRelationships',
      'lims:resetRegistry',
      'lims:restoreEntity',
      'lims:restorePendingRef',
      'lims:resumePrimerArtifactPublication',
      'lims:revertEntity',
      'lims:reviewClassification',
      'lims:revisePrimerArtifact',
      'lims:seedDemoDataset',
      'lims:seedMockDemo',
      'lims:seedPracticeDemo',
      'lims:seedStarterRegistry',
      'lims:setIdScheme',
      'lims:undoImportBatch',
      'lims:updateEntity',
      'lims:upgradeLegacyEntityArtifact',
    ]);
  });

  it('blocks destructive LIMS scenario IPC in primary runtime profiles', async () => {
    const originalArgv = process.argv;
    const originalWaypointTest = process.env.WAYPOINT_TEST;
    const originalScenarioLease = process.env.DNAFORGE_ALLOW_SCENARIO_MUTATION;
    process.argv = ['electron', 'main.js'];
    delete process.env.WAYPOINT_TEST;
    delete process.env.DNAFORGE_ALLOW_SCENARIO_MUTATION;
    vi.mocked(ipcMain.handle).mockClear();

    try {
      registerLimsIpcHandlers();
      const handlers = new Map(vi.mocked(ipcMain.handle).mock.calls);
      const seedDemo = handlers.get('lims:seedDemoDataset');
      const resetRegistry = handlers.get('lims:resetRegistry');
      const event = () =>
        ({
          sender: Object.assign(new BrowserWindow(), { webContents: new EventEmitter() })
            .webContents,
          senderFrame: null,
          type: 'frame',
          frameId: 0,
          processId: 0,
          preventDefault: vi.fn(),
          defaultPrevented: false,
        }) satisfies IpcMainInvokeEvent;

      expect(seedDemo).toBeDefined();
      expect(resetRegistry).toBeDefined();
      await expect(
        Promise.resolve().then(() => seedDemo?.(event(), { reset: true }))
      ).rejects.toThrow(/disposable LIMS scenario profile/);
      await expect(Promise.resolve().then(() => resetRegistry?.(event()))).rejects.toThrow(
        /disposable LIMS scenario profile/
      );
    } finally {
      process.argv = originalArgv;
      if (originalWaypointTest === undefined) delete process.env.WAYPOINT_TEST;
      else process.env.WAYPOINT_TEST = originalWaypointTest;
      if (originalScenarioLease === undefined) delete process.env.DNAFORGE_ALLOW_SCENARIO_MUTATION;
      else process.env.DNAFORGE_ALLOW_SCENARIO_MUTATION = originalScenarioLease;
    }
  });

  it('rejects a batch with two accepted duplicate rows before inserting either (intra-batch)', () => {
    const duplicateOligo = {
      kind: 'oligo' as const,
      name: 'Dup-Primer',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
        use: 'primer',
      },
    };
    expect(() =>
      applyLimsImportBatchInDb(db, {
        sourceName: 'dupe.csv',
        sourceKind: 'csv',
        records: [
          {
            id: 'row-1',
            action: 'register_entity',
            accepted: true,
            entity: duplicateOligo,
            source: {},
          },
          {
            id: 'row-2',
            action: 'register_entity',
            accepted: true,
            entity: duplicateOligo,
            source: {},
          },
        ],
        oracle: { ok: true, source: 'csv:dupe.csv', invariants: [] },
      })
    ).toThrow(/Duplicate within import batch/);

    expect(queryLimsEntitiesInDb(db, { kind: 'oligo', nameLike: 'Dup-Primer' })).toHaveLength(0);
  });

  it('rejects a non-genome hypothesis id when attaching a verified genome', () => {
    const strain = registerLimsEntityInDb(db, {
      kind: 'strain',
      name: 'argF strain',
      fields: { genotypeCanonical: 'argF::kanR' },
    });
    const verified = registerLimsEntityInDb(db, {
      kind: 'genome',
      name: 'verified WGS',
      fields: { sequence: { mode: 'unresolved' } },
    });
    const notAGenome = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'pUC19 decoy',
      fields: {
        sequence: {
          mode: 'file',
          relPath: '/tmp/decoy.gb',
          topology: 'circular',
          length: 10,
          contentHash: `sha256:${'a'.repeat(64)}`,
          sourceFormat: 'gb',
        },
      },
    });
    expect(() =>
      attachVerifiedLimsGenomeInDb(db, {
        strainEntityId: strain.id,
        verifiedGenomeEntityId: verified.id,
        hypothesisGenomeEntityId: notAGenome.id,
      })
    ).toThrow(/is not a genome/);
  });
});

function fileSequenceRef(filePath: string) {
  const content = readFileSync(filePath, 'utf8');
  const parsed = parseGenBankFull(content);
  return {
    mode: 'file' as const,
    relPath: filePath,
    topology: parsed.circular ? ('circular' as const) : ('linear' as const),
    length: parsed.length,
    contentHash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    sourceFormat: 'gb' as const,
  };
}

function replaceBase(sequence: string, position: number, preferredAlt: string): string {
  const index = position - 1;
  const current = sequence[index]?.toUpperCase();
  const alt = current === preferredAlt ? 'C' : preferredAlt;
  return `${sequence.slice(0, index)}${alt}${sequence.slice(index + 1)}`;
}

function deleteRange(sequence: string, start: number, end: number): string {
  return `${sequence.slice(0, start - 1)}${sequence.slice(end)}`;
}

describe('LIMS registry IDs', () => {
  function registerOligo(name: string, bases: string) {
    return registerLimsEntityInDb(db, {
      kind: 'oligo',
      name,
      fields: {
        sequence: { mode: 'inline', bases, topology: 'linear', length: bases.length },
        use: 'primer',
      },
      actor: 'test',
    });
  }

  it('registers a CUSTOM kind defined through the schema factory — the 5 builtins are not privileged', () => {
    defineLimsSchemaInDb(db, {
      kind: 'entity',
      name: 'reagent',
      displayName: 'Reagent',
      fields: [
        { key: 'vendor', label: 'Vendor', type: 'text', required: true },
        { key: 'catalogNumber', label: 'Catalog #', type: 'text' },
      ],
      actor: 'test',
    });

    const r = registerLimsEntityInDb(db, {
      kind: 'reagent',
      name: 'Q5 Polymerase',
      fields: { vendor: 'NEB', catalogNumber: 'M0491' },
      actor: 'test',
    });
    expect(r.kind).toBe('reagent');
    expect(r.registryId).toBe('rea000001');
    expect(r.fields.vendor).toBe('NEB');

    const page = queryLimsRegistrySummariesInDb(db, { kind: 'reagent' });
    expect(page.summaries.map((s) => s.name)).toContain('Q5 Polymerase');
    expect(page.summaries[0]?.registryId).toBe('rea000001');

    const incomplete = registerLimsEntityInDb(db, {
      kind: 'reagent',
      name: 'no-vendor',
      fields: {},
      actor: 'test',
    });
    expect(incomplete.registrationStatus).toBe('unresolved');

    setLimsIdSchemeInDb(db, { kind: 'reagent', prefix: 'RGT-', padWidth: 4, enabled: true });
    expect(() => setLimsIdSchemeInDb(db, { kind: 'reagnt', prefix: 'x', padWidth: 4 })).toThrow();
  });

  it('assigns sequential, per-kind registry IDs at registration', () => {
    const a = registerOligo('o-a', 'GTAAAACGACGGCCAGT');
    const b = registerOligo('o-b', 'CAGGAAACAGCTATGAC');
    const plasmid = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'p-a',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
      },
      actor: 'test',
    });
    expect(a.registryId).toBe('o000001');
    expect(b.registryId).toBe('o000002');

    expect(plasmid.registryId).toBe('p000001');
  });

  it('exposes registryId on registry summaries and sorts by it', () => {
    registerOligo('z-last', 'GTAAAACGACGGCCAGT');
    registerOligo('a-first', 'CAGGAAACAGCTATGAC');
    const page = queryLimsRegistrySummariesInDb(db, { kind: 'oligo', sort: 'registry_id_asc' });
    expect(page.summaries.map((s) => s.registryId)).toEqual(['o000001', 'o000002']);
  });

  it('finds an entity by its registry ID via the global search box, tolerating case + zero-padding', () => {
    registerOligo('alpha', 'GTAAAACGACGGCCAGT');
    const beta = registerOligo('beta', 'CAGGAAACAGCTATGAC');
    expect(beta.registryId).toBe('o000002');

    const byExactId = queryLimsRegistrySummariesInDb(db, { search: 'o000002' });
    expect(byExactId.summaries.map((s) => s.name)).toEqual(['beta']);

    const byPaddedUpper = queryLimsRegistrySummariesInDb(db, { search: 'O0000002' });
    expect(byPaddedUpper.summaries.map((s) => s.name)).toEqual(['beta']);

    const byUnpadded = queryLimsRegistrySummariesInDb(db, { search: 'o2' });
    expect(byUnpadded.summaries.map((s) => s.name)).toEqual(['beta']);
  });

  it('honors a reconfigured prefix/padding and rejects a colliding prefix', () => {
    setLimsIdSchemeInDb(db, { kind: 'oligo', prefix: 'OLG-', padWidth: 4 });
    const a = registerOligo('reconf', 'GTAAAACGACGGCCAGT');
    expect(a.registryId).toBe('OLG-0001');

    expect(() => setLimsIdSchemeInDb(db, { kind: 'oligo', prefix: 'p' })).toThrow(/already used/i);
  });

  it('skips ID assignment when the scheme is disabled', () => {
    setLimsIdSchemeInDb(db, { kind: 'oligo', enabled: false });
    const a = registerOligo('no-id', 'GTAAAACGACGGCCAGT');
    expect(a.registryId).toBeNull();
  });

  it('backfills missing IDs idempotently in stable creation order', () => {
    setLimsIdSchemeInDb(db, { kind: 'oligo', enabled: false });
    const first = registerOligo('first', 'GTAAAACGACGGCCAGT');
    registerOligo('second', 'CAGGAAACAGCTATGAC');
    expect(first.registryId).toBeNull();

    setLimsIdSchemeInDb(db, { kind: 'oligo', enabled: true });
    const result = backfillLimsRegistryIdsInDb(db, { kind: 'oligo' });
    expect(result.assigned).toBe(2);

    const summaries = queryLimsRegistrySummariesInDb(db, {
      kind: 'oligo',
      sort: 'registry_id_asc',
    }).summaries;
    expect(summaries.map((s) => s.name)).toEqual(['first', 'second']);
    expect(summaries.map((s) => s.registryId)).toEqual(['o000001', 'o000002']);

    expect(backfillLimsRegistryIdsInDb(db, { kind: 'oligo' }).assigned).toBe(0);
  });

  it('seeds default, enabled schemes for every entity kind', () => {
    const schemes = getLimsIdSchemesInDb(db);
    expect(schemes.map((s) => s.kind).sort()).toEqual([
      'allele',
      'chromosome',
      'dna_sequence',
      'external_ref',
      'fragment',
      'genome',
      'guide_rna',
      'locus',
      'marker',
      'molecular-document',
      'notebook',
      'oligo',
      'organism',
      'part',
      'plasmid',
      'protein',
      'rna_oligo',
      'rna_sequence',
      'sequence',
      'strain',
      'track-view',
    ]);
    expect(schemes.every((s) => s.enabled)).toBe(true);
  });
});

describe('LIMS durability: per-entity undo + archive/restore', () => {
  const makeOligo = (name: string, bases: string) =>
    registerLimsEntityInDb(db, {
      kind: 'oligo',
      name,
      fields: {
        sequence: { mode: 'inline', bases, topology: 'linear', length: bases.length },
        use: 'primer',
      },
      actor: 'test',
    });

  it('reverts the most recent edit, restoring prior name and fields', () => {
    const entity = makeOligo('Primer-A', 'GTAAAACGACGGCCAGT');
    updateLimsEntityInDb(db, {
      id: entity.id,
      name: 'Primer-A-renamed',
      fields: { use: 'sequencing' },
      actor: 'test',
    });

    const before = queryLimsEntitiesInDb(db, { id: entity.id })[0];
    expect(before.name).toBe('Primer-A-renamed');
    expect(before.fields.use).toBe('sequencing');

    const result = revertLimsEntityInDb(db, { id: entity.id });
    expect(result.reverted).toBe(true);
    expect(result.entity.name).toBe('Primer-A');
    expect(result.entity.fields.use).toBe('primer');

    const after = queryLimsEntitiesInDb(db, { id: entity.id })[0];
    expect(after.name).toBe('Primer-A');
    expect(after.fields.use).toBe('primer');
  });

  it('records the revert as its own audit event so undo is itself reversible', () => {
    const entity = makeOligo('Primer-B', 'GTAAAACGACGGCCAGT');
    updateLimsEntityInDb(db, { id: entity.id, name: 'Primer-B-v2', actor: 'test' });
    revertLimsEntityInDb(db, { id: entity.id });

    const reverted = db
      .prepare(`SELECT COUNT(*) as count FROM lims_audit WHERE event_type = 'entity_reverted'`)
      .get() as { count: number };
    expect(reverted.count).toBe(1);

    const second = revertLimsEntityInDb(db, { id: entity.id });
    expect(second.reverted).toBe(true);
    expect(second.entity.name).toBe('Primer-B-v2');
  });

  it('is a no-op when the entity has never been edited', () => {
    const entity = makeOligo('Primer-C', 'GTAAAACGACGGCCAGT');
    const result = revertLimsEntityInDb(db, { id: entity.id });
    expect(result.reverted).toBe(false);
    expect(result.reason).toBe('no-prior-edit');
    expect(result.entity.name).toBe('Primer-C');
  });

  it('revert after edit→archive→restore undoes the RESTORE (re-archives), not the older edit', () => {
    const entity = makeOligo('Primer-R', 'GTAAAACGACGGCCAGT');
    updateLimsEntityInDb(db, { id: entity.id, name: 'Primer-R-v2', actor: 'test' });
    archiveLimsEntityInDb(db, { id: entity.id });
    restoreLimsEntityInDb(db, { id: entity.id });

    const result = revertLimsEntityInDb(db, { id: entity.id });
    expect(result.reverted).toBe(true);
    expect(result.entity.tombstone).toBe(true);
    expect(result.entity.name).toBe('Primer-R-v2');

    expect(queryLimsEntitiesInDb(db, { id: entity.id })).toEqual([]);
    const [archivedRow] = queryLimsEntitiesInDb(db, { id: entity.id, includeArchived: true });
    expect(archivedRow.tombstone).toBe(true);
    expect(archivedRow.name).toBe('Primer-R-v2');
  });

  it('archives an entity (hidden by default, visible with includeArchived) and restores it', () => {
    const entity = makeOligo('Primer-D', 'GTAAAACGACGGCCAGT');

    const archived = archiveLimsEntityInDb(db, { id: entity.id });
    expect(archived.tombstone).toBe(true);

    expect(queryLimsEntitiesInDb(db, { id: entity.id })).toEqual([]);
    expect(queryLimsEntitiesInDb(db, { id: entity.id, includeArchived: true })).toHaveLength(1);

    const restored = restoreLimsEntityInDb(db, { id: entity.id });
    expect(restored.tombstone).toBe(false);
    expect(queryLimsEntitiesInDb(db, { id: entity.id })).toHaveLength(1);
  });

  it('writes archive/restore audit events and is idempotent on repeat', () => {
    const entity = makeOligo('Primer-E', 'GTAAAACGACGGCCAGT');

    archiveLimsEntityInDb(db, { id: entity.id });
    archiveLimsEntityInDb(db, { id: entity.id });
    restoreLimsEntityInDb(db, { id: entity.id });

    const events = db
      .prepare(
        `SELECT event_type, COUNT(*) as count FROM lims_audit
         WHERE subject_id = ? AND event_type IN ('entity_archived', 'entity_restored')
         GROUP BY event_type`
      )
      .all(entity.id) as Array<{ event_type: string; count: number }>;
    const byType = Object.fromEntries(events.map((e) => [e.event_type, e.count]));
    expect(byType.entity_archived).toBe(1);
    expect(byType.entity_restored).toBe(1);
  });

  it('surfaces the archived flag on registry summaries', () => {
    const entity = makeOligo('Primer-F', 'GTAAAACGACGGCCAGT');
    archiveLimsEntityInDb(db, { id: entity.id });

    const page = queryLimsRegistrySummariesInDb(db, { includeArchived: true, search: 'Primer-F' });
    const summary = page.summaries.find((s) => s.id === entity.id);
    expect(summary?.archived).toBe(true);
  });
});

describe('LIMS entity version history (read side of durability)', () => {
  it('excludes storage descriptors and undeclared fields while retaining the user rename', () => {
    const entity = registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'Before',
      fields: { use: 'primer' },
    });
    updateLimsEntityInDb(db, {
      id: entity.id,
      name: 'After',
      fields: {
        artifact: {
          schema: 'dnaforge.primer',
          revision: 2,
          relativePath: 'secret.primer.json',
          contentHash: 'private-hash',
        },
        futureStorageAttribute: { internalMethod: 'private-method' },
        undeclaredScalar: 'private-scalar',
      },
    });
    const history = getLimsEntityHistoryInDb(db, { entityId: entity.id });
    expect(history[0].changes).toEqual([
      { field: 'name', label: 'Name', kind: 'changed', before: 'Before', after: 'After' },
    ]);
    for (const internal of [
      'dnaforge.primer',
      'secret.primer.json',
      'private-hash',
      'private-method',
      'private-scalar',
    ])
      expect(JSON.stringify(history)).not.toContain(internal);
  });

  it('summarizes saved molecular results without exposing their internal references or fingerprints', () => {
    const first = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';
    const entity = registerLimsEntityInDb(db, {
      kind: 'molecular-document',
      name: 'Molecular view',
      fields: {
        currentReferenceId: first,
        revisionCount: 1,
        sourceCount: 1,
        artifactFingerprint: 'private-first-fingerprint',
      },
    });
    updateLimsEntityInDb(db, {
      id: entity.id,
      fields: {
        currentReferenceId: second,
        revisionCount: 2,
        artifactFingerprint: 'private-second-fingerprint',
      },
    });
    const history = getLimsEntityHistoryInDb(db, { entityId: entity.id });
    expect(history[0].changes).toContainEqual({
      field: 'molecularResult',
      label: 'Molecular result',
      kind: 'changed',
      description: 'Saved molecular result changed',
    });
    expect(history[0].changes).toContainEqual({
      field: 'fields.revisionCount',
      label: 'Saved results',
      kind: 'changed',
      before: '1',
      after: '2',
    });
    for (const internal of [
      first,
      second,
      'private-first-fingerprint',
      'private-second-fingerprint',
    ])
      expect(JSON.stringify(history)).not.toContain(internal);
  });

  it('omits package projection upkeep but retains a real sequence-content change', () => {
    const firstHash = `sha256:${'a'.repeat(64)}`;
    const secondHash = `sha256:${'b'.repeat(64)}`;
    const entity = registerLimsEntityInDb(db, {
      kind: 'sequence',
      name: 'PFY1-native-NC_001147.6',
      actor: 'workspace-reconcile',
      fields: {
        _managedSequenceContent: { fileContentHash: firstHash },
        _managedSequenceProjectionVersion: 1,
      },
    });
    updateLimsEntityInDb(db, {
      id: entity.id,
      actor: 'workspace-reconcile',
      fields: {
        _managedSequenceContent: {
          fileContentHash: firstHash,
          length: 590,
          topology: 'linear',
          geneticCode: 1,
        },
        _managedSequenceProjectionVersion: 2,
      },
    });

    const afterUpkeep = getLimsEntityHistoryInDb(db, { entityId: entity.id });
    expect(afterUpkeep.map((entry) => entry.label)).toEqual(['Registered']);
    expect(JSON.stringify(afterUpkeep)).not.toContain('_managedSequence');

    updateLimsEntityInDb(db, {
      id: entity.id,
      actor: 'workspace-reconcile',
      fields: {
        _managedSequenceContent: {
          fileContentHash: secondHash,
          length: 591,
          topology: 'linear',
          geneticCode: 1,
        },
      },
    });

    const afterContentChange = getLimsEntityHistoryInDb(db, { entityId: entity.id });
    expect(afterContentChange.map((entry) => entry.label)).toEqual(['Edited', 'Registered']);
    expect(afterContentChange[0].changes).toEqual([
      { field: 'fields.size', label: 'Length', kind: 'changed', before: '590', after: '591' },
    ]);
    expect(JSON.stringify(afterContentChange)).not.toContain(firstHash);
    expect(JSON.stringify(afterContentChange)).not.toContain(secondHash);
    const storedEvents = db
      .prepare(
        "SELECT COUNT(*) AS count FROM lims_audit WHERE subject_table = 'lims_entity' AND subject_id = ?"
      )
      .get(entity.id) as { count: number };
    expect(storedEvents.count).toBe(3);
  });

  it.each([false, true])(
    'reports forward and reverse metadata edits without file-save details with established fingerprints: %s',
    (established) => {
      const basesHash = `sha256:${'b'.repeat(64)}`;
      const entity = registerLimsEntityInDb(db, {
        kind: 'sequence',
        name: 'Metadata history round trip',
        actor: 'workspace-reconcile',
        fields: {
          description: '',
          _managedSequenceContent: {
            length: 2686,
            topology: 'circular',
            geneticCode: 1,
            ...(established
              ? { fileContentHash: `sha256:${'a'.repeat(64)}`, normalizedSequenceHash: basesHash }
              : {}),
          },
        },
      });
      for (const [index, topology, geneticCode, description] of [
        [0, 'linear', 3, 'Native sequence persistence check'],
        [1, 'circular', 1, ''],
      ] as const) {
        updateLimsEntityInDb(db, {
          id: entity.id,
          actor: 'workspace-reconcile',
          fields: {
            description,
            _managedSequenceContent: {
              fileContentHash: `sha256:${String(index + 1).repeat(64)}`,
              normalizedSequenceHash: basesHash,
              length: 2686,
              topology,
              geneticCode,
            },
          },
        });
      }
      const readAudit = () =>
        db
          .prepare(
            'SELECT * FROM lims_audit WHERE subject_table = ? AND subject_id = ? ORDER BY event_seq'
          )
          .all('lims_entity', entity.id);
      const audit = readAudit();
      const history = getLimsEntityHistoryInDb(db, { entityId: entity.id });
      expect(history.map((entry) => entry.label)).toEqual(['Edited', 'Edited', 'Registered']);
      for (const entry of history.slice(0, 2)) {
        expect(entry.changes.map((change) => change.field)).toEqual([
          'fields.description',
          'fields.topology',
          'fields.geneticCode',
        ]);
        expect(entry.changes.every((change) => change.description === undefined)).toBe(true);
      }
      expect(history[0].changes[1]).toMatchObject({ before: 'linear', after: 'circular' });
      expect(history[1].changes[1]).toMatchObject({ before: 'circular', after: 'linear' });
      expect(history[0].changes[0]).toMatchObject({
        before: 'Native sequence persistence check',
        after: '',
      });
      expect(readAudit()).toEqual(audit);
      expect(audit).toHaveLength(3);
    }
  );

  it.each([false, true])(
    'retains a proven file-only edit without adding an implicit save detail with known bases: %s',
    (knownBases) => {
      const bases = knownBases ? { normalizedSequenceHash: `sha256:${'b'.repeat(64)}` } : {};
      const entity = registerLimsEntityInDb(db, {
        kind: 'sequence',
        name: 'Saved version without field details',
        actor: 'workspace-reconcile',
        fields: {
          _managedSequenceContent: { fileContentHash: `sha256:${'a'.repeat(64)}`, ...bases },
        },
      });
      updateLimsEntityInDb(db, {
        id: entity.id,
        actor: 'workspace-reconcile',
        fields: {
          _managedSequenceContent: { fileContentHash: `sha256:${'c'.repeat(64)}`, ...bases },
        },
      });
      const history = getLimsEntityHistoryInDb(db, { entityId: entity.id });
      expect(history.map((entry) => entry.label)).toEqual(['Edited', 'Registered']);
      expect(history[0]).toMatchObject({ eventType: 'entity_updated', changes: [] });
      expect(history[0].at).toBeGreaterThan(0);
    }
  );

  it.each([false, true])(
    'retains an established same-length DNA edit with comparable file fingerprints: %s',
    (comparableFiles) => {
      const entity = registerLimsEntityInDb(db, {
        kind: 'sequence',
        name: 'DNA history',
        actor: 'workspace-reconcile',
        fields: {
          _managedSequenceContent: {
            normalizedSequenceHash: `sha256:${'a'.repeat(64)}`,
            length: 2686,
            ...(comparableFiles ? { fileContentHash: `sha256:${'b'.repeat(64)}` } : {}),
          },
        },
      });
      updateLimsEntityInDb(db, {
        id: entity.id,
        actor: 'workspace-reconcile',
        fields: {
          _managedSequenceContent: {
            normalizedSequenceHash: `sha256:${'c'.repeat(64)}`,
            length: 2686,
            ...(comparableFiles ? { fileContentHash: `sha256:${'d'.repeat(64)}` } : {}),
          },
        },
      });
      expect(getLimsEntityHistoryInDb(db, { entityId: entity.id })[0].changes).toEqual([
        { field: 'sequence', label: 'Sequence', kind: 'changed', description: 'Sequence changed' },
      ]);
    }
  );

  it('shows established sequence metadata edits without treating a derived-hash refresh as edited DNA', () => {
    const fileHash = `sha256:${'a'.repeat(64)}`;
    const firstNormalized = `sha256:${'b'.repeat(64)}`;
    const refreshedNormalized = `sha256:${'c'.repeat(64)}`;
    const entity = registerLimsEntityInDb(db, {
      kind: 'sequence',
      name: 'History-intrinsics',
      actor: 'workspace-reconcile',
      fields: {
        _managedSequenceContent: {
          fileContentHash: fileHash,
          normalizedSequenceHash: firstNormalized,
          length: 590,
          topology: 'linear',
          geneticCode: 1,
        },
      },
    });
    updateLimsEntityInDb(db, {
      id: entity.id,
      actor: 'workspace-reconcile',
      fields: {
        _managedSequenceContent: {
          fileContentHash: fileHash,
          normalizedSequenceHash: refreshedNormalized,
          length: 590,
          topology: 'linear',
          geneticCode: 1,
        },
      },
    });
    expect(
      getLimsEntityHistoryInDb(db, { entityId: entity.id }).map((entry) => entry.label)
    ).toEqual(['Registered']);

    updateLimsEntityInDb(db, {
      id: entity.id,
      actor: 'workspace-reconcile',
      fields: {
        _managedSequenceContent: {
          fileContentHash: fileHash,
          normalizedSequenceHash: refreshedNormalized,
          length: 591,
          topology: 'circular',
          geneticCode: 11,
        },
      },
    });
    const changes = getLimsEntityHistoryInDb(db, { entityId: entity.id })[0].changes;
    expect(changes.map((change) => change.field)).toEqual([
      'fields.size',
      'fields.topology',
      'fields.geneticCode',
    ]);
    expect(changes[0]).toMatchObject({ before: '590', after: '591' });
    expect(changes[1]).toMatchObject({ before: 'linear', after: 'circular' });
    expect(JSON.stringify(changes)).not.toContain(fileHash);
  });

  it('builds a newest-first timeline with correct labels and per-event diffs', () => {
    const entity = registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'History-1',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
        use: 'primer',
      },
      actor: 'alice',
    });
    updateLimsEntityInDb(db, {
      id: entity.id,
      name: 'History-1-renamed',
      fields: { use: 'sequencing' },
      actor: 'bob',
    });
    archiveLimsEntityInDb(db, { id: entity.id, actor: 'bob' });
    restoreLimsEntityInDb(db, { id: entity.id, actor: 'carol' });

    const history = getLimsEntityHistoryInDb(db, { entityId: entity.id });

    expect(history.map((h) => h.label)).toEqual(['Restored', 'Archived', 'Edited', 'Registered']);
    expect(history.map((h) => h.actor)).toEqual(['carol', 'bob', 'bob', 'alice']);

    for (let i = 1; i < history.length; i++) {
      expect(history[i - 1].eventSeq).toBeGreaterThan(history[i].eventSeq);
    }

    const edited = history.find((h) => h.label === 'Edited');
    const editedFields = edited?.changes.map((c) => c.field) ?? [];
    expect(editedFields).toContain('name');
    expect(editedFields).toContain('fields.use');
    const nameChange = edited?.changes.find((c) => c.field === 'name');
    expect(nameChange).toMatchObject({
      kind: 'changed',
      before: 'History-1',
      after: 'History-1-renamed',
    });

    const archived = history.find((h) => h.label === 'Archived');
    expect(archived?.changes).toEqual([]);

    const registered = history.find((h) => h.label === 'Registered');
    expect(registered?.changes).toEqual([
      { field: 'name', label: 'Name', kind: 'added', after: 'History-1' },
    ]);
  });

  it('collapses sequence-field changes to a summary rather than raw bases', () => {
    const entity = registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'History-Seq',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
        use: 'primer',
      },
    });
    updateLimsEntityInDb(db, {
      id: entity.id,
      fields: {
        sequence: { mode: 'inline', bases: 'CAGGAAACAGCTATGAC', topology: 'linear', length: 17 },
      },
    });

    const history = getLimsEntityHistoryInDb(db, { entityId: entity.id });
    const seqChange = history[0].changes.find((c) => c.field === 'sequence');
    expect(seqChange).toMatchObject({ label: 'Sequence', description: 'Sequence changed' });
    expect(JSON.stringify(history)).not.toContain('CAGGAAACAGCTATGAC');
  });

  it('redacts raw bases nested in metadata — no nucleotide leak in the diff', () => {
    const rawBases = 'GTAAAACGACGGCCAGT'.repeat(8);
    const entity = registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'History-Meta',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
        use: 'primer',
      },
    });
    updateLimsEntityInDb(db, {
      id: entity.id,
      fields: {
        sourceMetadata: {
          schemaVersion: 1,
          origin: { type: 'file_import', sourceKind: 'csv' },
          values: { Name: 'History-Meta', Sequence: rawBases },
        },
      },
    });

    const history = getLimsEntityHistoryInDb(db, { entityId: entity.id });
    const metaChange = history[0].changes.find((c) => c.field === 'fields.sourceMetadata');
    expect(metaChange).toBeTruthy();

    expect(metaChange?.after ?? '').not.toContain(rawBases);
    expect(metaChange?.after ?? '').not.toContain('GTAAAACGACGGCCAGTGTAAAACGACGGCCAGT');
  });

  it('surfaces a registry-ID assignment as its own history entry', () => {
    setLimsIdSchemeInDb(db, { kind: 'oligo', enabled: false });
    const entity = registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'History-NoId',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
        use: 'primer',
      },
    });
    setLimsIdSchemeInDb(db, { kind: 'oligo', enabled: true });
    backfillLimsRegistryIdsInDb(db, {});

    const history = getLimsEntityHistoryInDb(db, { entityId: entity.id });
    expect(history[0].label).toBe('Registry ID assigned');
    const idChange = history[0].changes.find((c) => c.field === 'registryId');
    expect(idChange?.kind).toBe('added');
    expect(idChange?.after).toBeTruthy();
  });

  it('excludes marker events (only state transitions appear)', () => {
    const entity = registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'History-Markers',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
        use: 'primer',
      },
    });

    logLimsTelemetryInDb(db, {
      eventType: 'register_consulted',
      subjectTable: 'lims_entity',
      subjectId: entity.id,
      payload: { note: 'marker' },
    });

    const history = getLimsEntityHistoryInDb(db, { entityId: entity.id });
    expect(history.map((h) => h.label)).toEqual(['Registered']);
  });
});

describe('LIMS registry per-column filters (name + sequence)', () => {
  const makeOligo = (name: string, bases: string) =>
    registerLimsEntityInDb(db, {
      kind: 'oligo',
      name,
      fields: {
        sequence: { mode: 'inline', bases, topology: 'linear', length: bases.length },
        use: 'primer',
      },
    });

  it('filters by nameLike and sequenceLike, composing as AND', () => {
    makeOligo('AlphaPrimer', 'GTAAAACGACGGCCAGT');
    makeOligo('BetaPrimer', 'CAGGAAACAGCTATGAC');

    expect(
      queryLimsRegistrySummariesInDb(db, { nameLike: 'alpha' }).summaries.map((s) => s.name)
    ).toEqual(['AlphaPrimer']);

    expect(
      queryLimsRegistrySummariesInDb(db, { sequenceLike: 'CAGGAAACAG' }).summaries.map(
        (s) => s.name
      )
    ).toEqual(['BetaPrimer']);

    expect(
      queryLimsRegistrySummariesInDb(db, { nameLike: 'alpha', sequenceLike: 'CAGGAAACAG' })
        .summaries
    ).toEqual([]);

    expect(
      queryLimsRegistrySummariesInDb(db, {
        nameLike: 'alpha',
        sequenceLike: 'GTAAAACGAC',
      }).summaries.map((s) => s.name)
    ).toEqual(['AlphaPrimer']);
  });

  it('is case-insensitive and composes with the global search', () => {
    makeOligo('Histidine-F', 'AAAATTTTGGGGCCCC');
    makeOligo('Histidine-R', 'TTTTAAAACCCCGGGG');

    const bySeq = queryLimsRegistrySummariesInDb(db, {
      search: 'histidine',
      sequenceLike: 'aaaatttt',
    });
    expect(bySeq.summaries.map((s) => s.name)).toEqual(['Histidine-F']);
  });
});

describe('LIMS registry filters: multi-select kind/status, registry ID, date', () => {
  const registration = (
    kind: string,
    name: string,
    status: 'tracked' | 'registered' | 'drifted'
  ) => ({
    kind: kind as 'oligo' | 'plasmid' | 'strain',
    name,
    fields:
      kind === 'strain'
        ? { genotypeCanonical: 'wt' }
        : {
            sequence: {
              mode: 'inline',
              bases: 'GTAAAACGACGGCCAGT',
              topology: 'linear',
              length: 17,
            },
            ...(kind === 'oligo' ? { use: 'primer' } : {}),
          },
    registrationStatus: status,
  });
  const reg = (kind: string, name: string, status: 'tracked' | 'registered' | 'drifted') =>
    registerLimsEntityInDb(db, registration(kind, name, status));

  it('filters by multiple kinds (any match)', () => {
    reg('oligo', 'mk-oligo', 'registered');
    reg('plasmid', 'mk-plasmid', 'registered');
    reg('strain', 'mk-strain', 'registered');

    const both = queryLimsRegistrySummariesInDb(db, { kinds: ['oligo', 'plasmid'] });
    expect(both.summaries.map((s) => s.kind).sort()).toEqual(['oligo', 'plasmid']);

    expect(queryLimsRegistrySummariesInDb(db, { kinds: [] }).summaries.length).toBe(3);
  });

  it('filters by multiple registration statuses (any match)', () => {
    reg('oligo', 'ms-a', 'tracked');
    reg('oligo', 'ms-b', 'registered');
    reg('oligo', 'ms-c', 'drifted');

    const page = queryLimsRegistrySummariesInDb(db, {
      registrationStatuses: ['tracked', 'drifted'],
    });
    expect(page.summaries.map((s) => s.name).sort()).toEqual(['ms-a', 'ms-c']);
  });

  it('filters by organism (species-rank rollup) and exposes availableOrganisms', () => {
    const ecoliStrain = (name: string, taxid: string) =>
      registerLimsEntityInDb(db, {
        kind: 'strain',
        name,
        fields: { genotypeCanonical: 'wt', species: 'Escherichia coli', speciesTaxid: taxid },
        registrationStatus: 'registered',
      });

    ecoliStrain('mg1655', '511145');
    ecoliStrain('w3110', '316407');
    registerLimsEntityInDb(db, {
      kind: 'strain',
      name: 'n16961',
      fields: { genotypeCanonical: 'wt', species: 'Vibrio cholerae', speciesTaxid: '666' },
      registrationStatus: 'registered',
    });
    reg('plasmid', 'no-organism-plasmid', 'registered');

    const organisms = (queryLimsRegistrySummariesInDb(db, {}).availableOrganisms ?? [])
      .map((o) => `${o.speciesTaxid}:${o.count}`)
      .sort();
    expect(organisms).toEqual(['562:2', '666:1']);

    const ecoli = queryLimsRegistrySummariesInDb(db, { speciesTaxids: ['562'] });
    expect(ecoli.summaries.map((s) => s.name).sort()).toEqual(['mg1655', 'w3110']);
    expect(ecoli.summaries.every((s) => s.organism?.speciesTaxid === '562')).toBe(true);

    const plasmid = queryLimsRegistrySummariesInDb(db, { kind: 'plasmid' }).summaries[0];
    expect(plasmid.organism ?? null).toBeNull();
  });

  it('filters by registry ID substring', () => {
    const e = reg('oligo', 'rid-target', 'registered');
    backfillLimsRegistryIdsInDb(db, {});
    const withId = queryLimsEntitiesInDb(db, { id: e.id })[0];
    expect(withId.registryId).toBeTruthy();

    const page = queryLimsRegistrySummariesInDb(db, {
      registryIdLike: (withId.registryId ?? '').slice(0, 4),
    });
    expect(page.summaries.some((s) => s.id === e.id)).toBe(true);
    expect(queryLimsRegistrySummariesInDb(db, { registryIdLike: 'zzzz-nope' }).summaries).toEqual(
      []
    );
  });

  it('filters by updated date: on / after / before a calendar day', () => {
    reg('oligo', 'date-a', 'registered');
    const now = Date.now();
    const yesterday = now - 86_400_000;
    const tomorrow = now + 86_400_000;

    expect(queryLimsRegistrySummariesInDb(db, { updatedOn: now }).summaries.length).toBe(1);
    expect(queryLimsRegistrySummariesInDb(db, { updatedOn: yesterday }).summaries).toEqual([]);

    expect(queryLimsRegistrySummariesInDb(db, { updatedAfter: yesterday }).summaries.length).toBe(
      1
    );
    expect(queryLimsRegistrySummariesInDb(db, { updatedAfter: now }).summaries).toEqual([]);

    expect(queryLimsRegistrySummariesInDb(db, { updatedBefore: tomorrow }).summaries.length).toBe(
      1
    );
    expect(queryLimsRegistrySummariesInDb(db, { updatedBefore: now }).summaries).toEqual([]);
  });

  it('counts entities by kind via COUNT(*), uncapped past the 500-row fetch limit', () => {
    seedLimsBuiltinsInDb(db);
    db.transaction(() => {
      for (let i = 0; i < 501; i += 1)
        registerLimsEntityInsideTx(db, registration('oligo', `bulk-${i}`, 'registered'));
      registerLimsEntityInsideTx(db, registration('plasmid', 'pl-1', 'registered'));
      registerLimsEntityInsideTx(db, registration('plasmid', 'pl-2', 'registered'));
    })();

    const counts = countLimsEntitiesByKindInDb(db);

    expect(counts.oligo).toBe(501);
    expect(counts.plasmid).toBe(2);
    expect(counts.genome).toBe(0);
    expect(counts.strain).toBe(0);
    expect(counts.organism).toBe(0);
  });
});

describe('LIMS atomic test-database load (reset + replace)', () => {
  it('resetLimsRegistryInDb clears all data but preserves the builtin schema contract', () => {
    seedLimsStarterRegistryInDb(db);
    expect(countLimsEntitiesByKindInDb(db).strain).toBeGreaterThan(0);

    const nextOligoSeq = getLimsIdSchemesInDb(db).find(
      (scheme) => scheme.kind === 'oligo'
    )!.nextSeq;

    const result = resetLimsRegistryInDb(db);
    expect(result).toEqual({ cleared: true, entityCount: 0 });

    const counts = countLimsEntitiesByKindInDb(db);
    expect(counts.strain).toBe(0);
    expect(counts.genome).toBe(0);
    expect(counts.chromosome).toBe(0);
    expect(counts.oligo).toBe(0);
    expect(queryLimsEntitiesInDb(db, {})).toEqual([]);

    expect(getLimsIdSchemesInDb(db).length).toBeGreaterThan(0);
    expect(getLimsIdSchemesInDb(db).find((scheme) => scheme.kind === 'oligo')!.nextSeq).toBe(
      nextOligoSeq
    );
    const reg = registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'post-reset oligo',
      fields: { sequence: { mode: 'inline', bases: 'ACGT', topology: 'linear', length: 4 } },
      registrationStatus: 'registered',
    });
    expect(reg.kind).toBe('oligo');

    expect(Number(reg.registryId!.replace(/^[a-zA-Z]+/, ''))).toBe(nextOligoSeq);
    expect(getLimsIdSchemesInDb(db).find((scheme) => scheme.kind === 'oligo')!.nextSeq).toBe(
      nextOligoSeq + 1
    );
  });

  it('a replace-load (reset:true) REPLACES rather than accumulates: prior data is gone', () => {
    seedLimsDemoDatasetInDb(db);
    expect(queryLimsEntitiesInDb(db, { nameLike: 'pUC19' }).length).toBeGreaterThan(0);

    seedLimsStarterRegistryInDb(db, { reset: true });

    expect(queryLimsEntitiesInDb(db, { nameLike: 'pUC19' })).toEqual([]);

    const after1 = countLimsEntitiesByKindInDb(db);
    seedLimsStarterRegistryInDb(db, { reset: true });
    const after2 = countLimsEntitiesByKindInDb(db);
    expect(after2).toEqual(after1);
  });

  it('replace-load fixes an entity stuck at a stale kind (the live-DB migration bug)', () => {
    registerLimsEntityInDb(db, {
      id: 'starter-chr-scerevisiae-iv',
      kind: 'genome',
      name: 'S. cerevisiae S288C chromosome IV',
      fields: { sequence: { mode: 'unresolved' } },
      registrationStatus: 'registered',
    });
    expect(queryLimsEntitiesInDb(db, { id: 'starter-chr-scerevisiae-iv' })[0]?.kind).toBe('genome');

    seedLimsStarterRegistryInDb(db, { reset: true });

    expect(queryLimsEntitiesInDb(db, { id: 'starter-chr-scerevisiae-iv' })[0]?.kind).toBe(
      'chromosome'
    );
  });

  it('clear is atomic: a throw after clearLimsRegistryInsideTx rolls back the whole transaction', () => {
    seedLimsStarterRegistryInDb(db);
    const before = countLimsEntitiesByKindInDb(db);
    expect(before.strain).toBeGreaterThan(0);

    expect(() =>
      db.transaction(() => {
        clearLimsRegistryInsideTx(db);
        throw new Error('boom — simulated mid-load failure');
      })()
    ).toThrow('boom');

    const after = countLimsEntitiesByKindInDb(db);
    expect(after).toEqual(before);
  });

  it('scoped reseed (resetScope: "dev-seed") refreshes seed rows but KEEPS hand-made rows', () => {
    seedLimsMockDemoInDb(db, { actor: 'test', reset: true });
    const seededOligos = countLimsEntitiesByKindInDb(db).oligo;
    expect(seededOligos).toBeGreaterThan(0);

    registerLimsEntityInDb(db, {
      id: 'my-handmade-oligo',
      kind: 'oligo',
      name: 'keep me — hand made',
      fields: { sequence: { mode: 'inline', bases: 'ACGT', topology: 'linear', length: 4 } },
      registrationStatus: 'registered',
    });

    seedLimsMockDemoInDb(db, { actor: 'test', reset: true, resetScope: 'dev-seed' });

    expect(queryLimsEntitiesInDb(db, { id: 'my-handmade-oligo' })[0]?.name).toBe(
      'keep me — hand made'
    );

    expect(countLimsEntitiesByKindInDb(db).oligo).toBe(seededOligos + 1);

    seedLimsMockDemoInDb(db, { actor: 'test', reset: true });
    expect(queryLimsEntitiesInDb(db, { id: 'my-handmade-oligo' })).toEqual([]);
  });
});

describe('LIMS sequence-bearing kinds FLAG (not block) an unresolved sequence — ', () => {
  it('registers a chromosome with an unresolved (or missing) sequence, flagged unresolved', () => {
    const withPlaceholder = registerLimsEntityInDb(db, {
      kind: 'chromosome',
      name: 'Pending chromosome',
      fields: { sequence: { mode: 'unresolved' }, moleculeType: 'chromosome' },
    });
    expect(withPlaceholder.registrationStatus).toBe('unresolved');

    const noSequence = registerLimsEntityInDb(db, {
      kind: 'chromosome',
      name: 'Sequenceless chromosome',
      fields: { moleculeType: 'chromosome' },
    });
    expect(noSequence.registrationStatus).toBe('unresolved');
  });

  it('accepts a chromosome with a resolved (inline) sequence', () => {
    const bases = 'ACGTACGTACGTACGT';
    const chromosome = registerLimsEntityInDb(db, {
      kind: 'chromosome',
      name: 'Real chromosome',
      fields: {
        sequence: { mode: 'inline', bases, topology: 'linear', length: bases.length },
        moleculeType: 'chromosome',
      },
      registrationStatus: 'registered',
    });
    expect(chromosome.kind).toBe('chromosome');
  });

  it('registers an unresolved plasmid or oligo flagged, and still allows an unresolved genome', () => {
    const plasmid = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'Pending plasmid',
      fields: { sequence: { mode: 'unresolved' } },
    });
    expect(plasmid.registrationStatus).toBe('unresolved');

    const oligo = registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'Pending oligo',
      fields: { sequence: { mode: 'unresolved' }, use: 'primer' },
    });
    expect(oligo.registrationStatus).toBe('unresolved');

    const genome = registerLimsEntityInDb(db, {
      kind: 'genome',
      name: 'Unresolved assembly',
      fields: { sequence: { mode: 'unresolved' }, assemblyLevel: 'complete_genome' },
    });
    expect(genome.kind).toBe('genome');
  });

  it('still REJECTS a genuinely malformed sequence (invalid DNA), unlike a merely unresolved one', () => {
    expect(() =>
      registerLimsEntityInDb(db, {
        kind: 'plasmid',
        name: 'Garbage plasmid',
        fields: { sequence: { mode: 'inline', bases: 'ZZZ123', topology: 'linear', length: 6 } },
      })
    ).toThrow();
  });

  it('accepts a linear plasmid because topology is sequence metadata, not entity identity', () => {
    const linearPlasmid = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'Linearized plasmid',
      fields: {
        sequence: {
          mode: 'file',
          relPath: '/workspace/linearized-plasmid.gb',
          topology: 'linear',
          length: 2686,
          contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      },
      registrationStatus: 'registered',
    });

    expect(linearPlasmid.kind).toBe('plasmid');
    expect((linearPlasmid.fields.sequence as { topology?: string }).topology).toBe('linear');
  });

  it('labels an unresolved DNA sequence as Needs sequence and prevents opening it', () => {
    const pendingSequence = registerLimsEntityInDb(db, {
      kind: 'dna_sequence',
      name: 'Sequence pending from Benchling',
      fields: { sequence: { mode: 'unresolved' } },
      registrationStatus: 'unresolved',
    });

    const page = queryLimsRegistrySummariesInDb(db, {
      kind: 'dna_sequence',
      limit: 20,
      offset: 0,
      sort: 'name_asc',
    });

    expect(page.summaries).toHaveLength(1);
    expect(page.summaries[0]).toMatchObject({
      id: pendingSequence.id,
      representation: {
        kind: 'unresolved',
        label: 'Needs sequence',
        canOpen: false,
      },
    });
  });
});

describe('LIMS registry summary — protein representation ', () => {
  it('a file-backed protein is openable as protein_sequence', () => {
    const protein = registerLimsEntityInDb(db, {
      kind: 'protein',
      name: 'GFP',
      fields: {
        sequence: {
          mode: 'file',
          relPath: '/workspace/proteins/GFP-abc12345.faa',
          length: 238,
          contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          sourceFormat: 'fasta',
        },
      },
      registrationStatus: 'registered',
    });

    const page = queryLimsRegistrySummariesInDb(db, {
      kind: 'protein',
      limit: 20,
      offset: 0,
      sort: 'name_asc',
    });

    expect(page.summaries).toHaveLength(1);
    expect(page.summaries[0]).toMatchObject({
      id: protein.id,
      kind: 'protein',
      name: 'GFP',
      representation: {
        kind: 'protein_sequence',
        canOpen: true,
        openTarget: {
          kind: 'protein_sequence',
          entityId: protein.id,
          entityKind: 'protein',
          label: 'GFP',
          filePath: '/workspace/proteins/GFP-abc12345.faa',
          registrationStatus: 'registered',
        },
      },
    });
  });

  it('a package-backed inline protein is directly openable in the protein editor', () => {
    const protein = registerLimsEntityInDb(db, {
      kind: 'protein',
      name: 'Inline GFP',
      fields: {
        sequence: { mode: 'inline', aminoAcids: 'MSKGEEL', length: 7 },
      },
      registrationStatus: 'registered',
    });

    const page = queryLimsRegistrySummariesInDb(db, {
      kind: 'protein',
      limit: 20,
      offset: 0,
      sort: 'name_asc',
    });

    expect(page.summaries).toHaveLength(1);
    expect(page.summaries[0]).toMatchObject({
      id: protein.id,
      representation: {
        kind: 'protein_sequence',
        label: 'Protein sequence',
        canOpen: true,
        openTarget: {
          kind: 'protein_sequence',
          entityId: protein.id,
          entityKind: 'protein',
          label: 'Inline GFP',
          registrationStatus: 'registered',
        },
      },
    });
  });

  it("rejects registering a protein with an unresolved sequence — a protein IS an amino-acid sequence, matching chromosome/plasmid/oligo's requireResolved rule (genome assembly is the sole exception, not protein)", () => {
    expect(() =>
      registerLimsEntityInDb(db, {
        kind: 'protein',
        name: 'Phantom protein',
        fields: { sequence: { mode: 'unresolved' } },
        registrationStatus: 'unresolved',
      })
    ).toThrow(/must reference an actual amino-acid sequence/i);
  });
});
