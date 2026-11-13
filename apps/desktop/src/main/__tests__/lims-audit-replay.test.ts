import { seedOriginalProjectFixture } from './original-project-fixture';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema } from '../schema';
import { createTestDb } from './test-db';
import {
  archiveLimsEntityInDb,
  backfillLimsRegistryIdsInDb,
  applyLimsImportBatchInDb,
  linkLimsEntitiesInDb,
  materializeLimsGitReadableExportInDb,
  queryLimsEntitiesInDb,
  readLimsAuditExportRowsFromWorkspace,
  registerLimsEntityInDb,
  restoreLimsEntityInDb,
  revertLimsEntityInDb,
  seedLimsDemoDatasetInDb,
  setLimsIdSchemeInDb,
  undoLimsImportBatchInDb,
  updateLimsEntityInDb,
} from '../lims';
import {
  LIMS_ENTITY_STATE_EVENT_TYPES,
  type LimsAuditRow,
  type LimsEntity,
} from '../../shared/lims';
import { insertAuditEvent } from '../lims-engine-core';
import {
  assertLimsProjectionReplayParityFromAuditRowsInDb,
  assertLimsProjectionReplayParityInDb,
  rebuildLimsProjectionFromAuditRowsInDb,
  rebuildLimsProjectionInDb,
  restoreLimsAuditAndProjectionFromRowsInDb,
  verifyLimsAuditHashChainInDb,
  verifyLimsContentPinsInDb,
} from '../lims-projection-rebuild';

const ENTITY_STATE_EVENTS = new Set<string>(LIMS_ENTITY_STATE_EVENT_TYPES);

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  seedOriginalProjectFixture(db);
});

afterEach(() => {
  db.close();
});

function reconstructEntitiesFromAudit(database: Database.Database): Map<string, LimsEntity> {
  const events = database
    .prepare(
      `SELECT subject_id, event_type, after FROM lims_audit
       WHERE subject_table = 'lims_entity'
       ORDER BY event_seq ASC`
    )
    .all() as Array<{ subject_id: string; event_type: string; after: string | null }>;
  const state = new Map<string, LimsEntity>();
  for (const event of events) {
    if (!ENTITY_STATE_EVENTS.has(event.event_type)) continue;
    if (event.after == null) continue;
    state.set(event.subject_id, JSON.parse(event.after) as LimsEntity);
  }
  return state;
}

function diffProjectionVsReplay(database: Database.Database) {
  const actual = queryLimsEntitiesInDb(database, { includeArchived: true, limit: 100_000 });
  const reconstructed = reconstructEntitiesFromAudit(database);

  const COMPARED: Array<keyof LimsEntity> = [
    'id',
    'kind',
    'name',
    'registrationStatus',
    'domainStatus',
    'registryId',
    'tombstone',
    'workspaceId',
    'fields',
  ];

  const orphanRows: string[] = [];
  const fieldMismatches: Array<{ id: string; field: string; actual: unknown; replayed: unknown }> =
    [];

  for (const row of actual) {
    const rebuilt = reconstructed.get(row.id);
    if (!rebuilt) {
      orphanRows.push(`${row.kind}:${row.name} (${row.id})`);
      continue;
    }
    for (const field of COMPARED) {
      const a = JSON.stringify(row[field] ?? null);
      const b = JSON.stringify(rebuilt[field] ?? null);
      if (a !== b) {
        fieldMismatches.push({ id: row.id, field, actual: row[field], replayed: rebuilt[field] });
      }
    }
  }

  const phantomEntities = [...reconstructed.keys()].filter(
    (id) => !actual.some((row) => row.id === id)
  );

  return { actualCount: actual.length, orphanRows, fieldMismatches, phantomEntities };
}

describe('#0 rebuild proof — lims_audit replay reconstructs the lims_entity projection', () => {
  it('rebuilds a register/update/link/archive/restore/revert workload with zero divergence', () => {
    const a = registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'Replay-A',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
        use: 'primer',
      },
    });
    const b = registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'Replay-B',
      fields: {
        sequence: { mode: 'inline', bases: 'CAGGAAACAGCTATGAC', topology: 'linear', length: 17 },
        use: 'primer',
      },
    });
    updateLimsEntityInDb(db, { id: a.id, name: 'Replay-A-renamed', fields: { use: 'sequencing' } });
    linkLimsEntitiesInDb(db, { fromEntityId: a.id, toEntityId: b.id, type: 'associated_with' });
    archiveLimsEntityInDb(db, { id: b.id });
    restoreLimsEntityInDb(db, { id: b.id });
    revertLimsEntityInDb(db, { id: a.id });

    const report = diffProjectionVsReplay(db);
    expect(report.orphanRows).toEqual([]);
    expect(report.phantomEntities).toEqual([]);
    expect(report.fieldMismatches).toEqual([]);
  });

  it('rebuilds the Demo demo dataset with zero divergence', () => {
    seedLimsDemoDatasetInDb(db, { outputDir: mkdtempSync(join(tmpdir(), 'lims-replay-')) });
    const report = diffProjectionVsReplay(db);

    expect(report.orphanRows).toEqual([]);
    expect(report.phantomEntities).toEqual([]);
    expect(report.fieldMismatches).toEqual([]);
  });

  it('rebuilds after a registry-ID backfill assigns IDs (regression guard for the closed bypass)', () => {
    setLimsIdSchemeInDb(db, { kind: 'oligo', enabled: false });
    const e1 = registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'Legacy-1',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
        use: 'primer',
      },
    });
    const e2 = registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'Legacy-2',
      fields: {
        sequence: { mode: 'inline', bases: 'CAGGAAACAGCTATGAC', topology: 'linear', length: 17 },
        use: 'primer',
      },
    });
    expect(e1.registryId).toBeNull();
    expect(e2.registryId).toBeNull();

    setLimsIdSchemeInDb(db, { kind: 'oligo', enabled: true });
    const result = backfillLimsRegistryIdsInDb(db, {});
    expect(result.assigned).toBe(2);

    const live = queryLimsEntitiesInDb(db, { kind: 'oligo', includeArchived: true });
    expect(live.every((row) => typeof row.registryId === 'string' && row.registryId)).toBe(true);

    const report = diffProjectionVsReplay(db);
    expect(report.orphanRows).toEqual([]);
    expect(report.phantomEntities).toEqual([]);
    expect(report.fieldMismatches).toEqual([]);
  });
});

function tableSnapshot(database: Database.Database, table: string): unknown[] {
  return database.prepare(`SELECT * FROM ${table} ORDER BY id ASC`).all();
}

function projectionSnapshot(database: Database.Database): Record<string, unknown[]> {
  return {
    lims_schema: tableSnapshot(database, 'lims_schema'),
    lims_schema_revision: tableSnapshot(database, 'lims_schema_revision'),
    lims_entity: tableSnapshot(database, 'lims_entity'),
    lims_link: tableSnapshot(database, 'lims_link'),
  };
}

function insertWorkspace(database: Database.Database, name: string, workspaceRoot: string): number {
  return Number(
    database
      .prepare(`INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)`)
      .run(name, workspaceRoot, Date.now()).lastInsertRowid
  );
}

describe(' rebuildLimsProjection byte-parity gate', () => {
  it('drops and replays schema/entity/link projections byte-identically, including tombstones and link reactivation', () => {
    const plasmid = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'pUC19 parity target',
      fields: {
        sequence: {
          mode: 'inline',
          bases: 'GTAAAACGACGGCCAGT',
          topology: 'linear',
          length: 17,
        },
      },
    });

    const batch = applyLimsImportBatchInDb(db, {
      batchId: 'parity-batch',
      sourceName: 'primers.csv',
      sourceKind: 'csv',
      records: [
        {
          id: 'row-1',
          action: 'register_entity',
          accepted: true,
          entity: {
            id: 'parity-oligo-1',
            kind: 'oligo',
            name: 'Parity primer',
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
              toEntityId: plasmid.id,
              payload: { role: 'target', nullable: null },
            },
          ],
          source: { nullable: null },
        },
      ],
    });
    expect(batch.insertedLinks).toBe(1);

    undoLimsImportBatchInDb(db, { batchId: 'parity-batch' });
    restoreLimsEntityInDb(db, { id: 'parity-oligo-1' });
    linkLimsEntitiesInDb(db, {
      fromEntityId: 'parity-oligo-1',
      toEntityId: plasmid.id,
      type: 'associated_with',
      payload: { role: 'target', nullable: null },
    });
    updateLimsEntityInDb(db, {
      id: 'parity-oligo-1',
      fields: { note: null },
    });

    const before = projectionSnapshot(db);
    const result = assertLimsProjectionReplayParityInDb(db);
    expect(result.appliedEvents).toBeGreaterThan(0);
    expect(projectionSnapshot(db)).toEqual(before);
  });

  it('proves the parity ruler fails when an event-derived link projection is missing', () => {
    const a = registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'Link-A',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
        use: 'primer',
      },
    });
    const b = registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'Link-B',
      fields: {
        sequence: { mode: 'inline', bases: 'CAGGAAACAGCTATGAC', topology: 'linear', length: 17 },
        use: 'primer',
      },
    });
    linkLimsEntitiesInDb(db, { fromEntityId: a.id, toEntityId: b.id, type: 'associated_with' });

    const rows = db
      .prepare(`SELECT * FROM lims_audit ORDER BY event_seq ASC`)
      .all() as LimsAuditRow[];
    const withoutLinkEvents = rows.filter(
      (row) => (row as { event_type: string }).event_type !== 'link_created'
    );

    expect(() => assertLimsProjectionReplayParityFromAuditRowsInDb(db, withoutLinkEvents)).toThrow(
      /projection parity failed/i
    );
  });

  it('deduplicates idempotency keys during replay', () => {
    const entity = registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'Idempotent replay',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
        use: 'primer',
      },
    });
    const rows = db
      .prepare(`SELECT * FROM lims_audit ORDER BY event_seq ASC`)
      .all() as LimsAuditRow[];
    const entityEvent = rows.find(
      (row) =>
        (row as { event_type: string; subject_id: string }).event_type === 'entity_registered' &&
        (row as { subject_id: string }).subject_id === entity.id
    );
    expect(entityEvent).toBeDefined();

    rebuildLimsProjectionFromAuditRowsInDb(db, [...rows, entityEvent!]);
    expect(
      queryLimsEntitiesInDb(db, { includeArchived: true, nameLike: 'Idempotent' })
    ).toHaveLength(1);
  });
});

describe(' git content pin health', () => {
  it('refuses to register a git-backed sequence when the pinned hash cannot resolve', () => {
    expect(() =>
      registerLimsEntityInDb(db, {
        kind: 'plasmid',
        name: 'Dangling pin',
        fields: {
          sequence: {
            mode: 'file',
            relPath: '/tmp/missing.gb',
            topology: 'circular',
            length: 10,
            contentHash: `git:${'f'.repeat(40)}`,
            fileContentHash: `git:${'f'.repeat(40)}`,
            sourceFormat: 'gb',
          },
        },
      })
    ).toThrow(/git content pin/i);
  });

  it('fails health when an existing event records a dangling git content pin', () => {
    insertAuditEvent(db, {
      eventType: 'entity_registered',
      subjectTable: 'lims_entity',
      subjectId: 'bad-pin',
      after: {
        id: 'bad-pin',
        kind: 'plasmid',
        schemaId: 'schema-entity-plasmid',
        schemaRevisionId: 'schema-entity-plasmid-v1',
        name: 'Dangling pin',
        registryId: 'p999999',
        fields: {},
        registrationStatus: 'registered',
        domainStatus: null,
        workspaceId: null,
        actor: 'test',
        eventSeq: 1,
        tombstone: false,
        createdAt: 1,
        updatedAt: 1,
        archivedAt: null,
      },
      payload: {
        contentPins: [
          {
            entityId: 'bad-pin',
            field: 'sequence',
            relPath: '/tmp/missing.gb',
            contentHash: `git:${'f'.repeat(40)}`,
            commit: '0'.repeat(40),
            ref: 'refs/dnaforge/lims-pins/bad-pin/1',
          },
        ],
      },
    });

    const health = verifyLimsContentPinsInDb(db);
    expect(health.ok).toBe(false);
    expect(health.danglingPins).toEqual([
      expect.objectContaining({ contentHash: `git:${'f'.repeat(40)}` }),
    ]);
  });
});

describe(' recovery and hash-chain gates', () => {
  it('rebuilds a dropped projection from the audit log', () => {
    const entity = registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'Recoverable oligo',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
        use: 'primer',
      },
    });
    updateLimsEntityInDb(db, { id: entity.id, fields: { note: 'rebuild me' } });
    const before = projectionSnapshot(db);

    db.prepare(`DELETE FROM lims_link`).run();
    db.prepare(`DELETE FROM lims_entity`).run();
    db.prepare(`DELETE FROM lims_schema_revision`).run();
    db.prepare(`DELETE FROM lims_schema`).run();

    const result = rebuildLimsProjectionInDb(db);
    expect(result.appliedEvents).toBeGreaterThan(0);
    expect(projectionSnapshot(db)).toEqual(before);
  });

  it('detects tampering with a hashed audit event', () => {
    const entity = registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'Hash-chain oligo',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
        use: 'primer',
      },
    });
    expect(verifyLimsAuditHashChainInDb(db)).toMatchObject({
      ok: true,
      failures: [],
    });

    const row = db
      .prepare(
        `SELECT id, after FROM lims_audit
         WHERE event_type = 'entity_registered' AND subject_id = ?`
      )
      .get(entity.id) as { id: string; after: string };
    const after = JSON.parse(row.after) as LimsEntity;
    db.prepare(`UPDATE lims_audit SET after = ? WHERE id = ?`).run(
      JSON.stringify({ ...after, name: 'Tampered oligo' }),
      row.id
    );

    const health = verifyLimsAuditHashChainInDb(db);
    expect(health.ok).toBe(false);
    expect(health.failures).toEqual([
      expect.objectContaining({ auditId: row.id, reason: 'hash_mismatch' }),
    ]);
  });

  it('materializes complete replayable JSONL plus workspace-scoped oligos.csv', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'lims-export-'));
    const otherWorkspaceRoot = mkdtempSync(join(tmpdir(), 'lims-export-other-'));
    try {
      const workspaceId = insertWorkspace(db, 'LIMS export workspace', workspaceRoot);
      const otherWorkspaceId = insertWorkspace(
        db,
        'Other LIMS export workspace',
        otherWorkspaceRoot
      );
      registerLimsEntityInDb(db, {
        kind: 'oligo',
        name: 'Exported primer A',
        workspaceId,
        fields: {
          sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
          use: 'primer',
        },
      });

      const firstExport = materializeLimsGitReadableExportInDb(db, { workspaceRoot });
      expect(firstExport.exportedThroughEventSeq).toBeGreaterThan(0);
      expect(existsSync(firstExport.oligosCsvPath)).toBe(true);
      expect(readFileSync(firstExport.oligosCsvPath, 'utf8')).toContain('Exported primer A');
      const logDir = join(workspaceRoot, '.waypoint', 'lims', 'log');
      const logFile = join(logDir, readdirSync(logDir).find((name) => name.endsWith('.jsonl'))!);
      const firstLog = readFileSync(logFile, 'utf8');

      registerLimsEntityInDb(db, {
        kind: 'oligo',
        name: 'Other workspace primer',
        workspaceId: otherWorkspaceId,
        fields: {
          sequence: { mode: 'inline', bases: 'TTTTTTTTTTTTTTTTT', topology: 'linear', length: 17 },
          use: 'primer',
        },
      });
      registerLimsEntityInDb(db, {
        kind: 'oligo',
        name: 'Exported primer B',
        workspaceId,
        fields: {
          sequence: { mode: 'inline', bases: 'CAGGAAACAGCTATGAC', topology: 'linear', length: 17 },
          use: 'primer',
        },
      });
      const secondExport = materializeLimsGitReadableExportInDb(db, { workspaceRoot });
      expect(secondExport.exportedThroughEventSeq).toBeGreaterThan(
        firstExport.exportedThroughEventSeq
      );
      const secondLog = readFileSync(logFile, 'utf8');
      expect(secondLog.startsWith(firstLog)).toBe(true);
      const csv = readFileSync(secondExport.oligosCsvPath, 'utf8');
      expect(csv).toContain('Exported primer B');
      expect(csv).not.toContain('Other workspace primer');

      const exportedRows = readLimsAuditExportRowsFromWorkspace(workspaceRoot);
      const auditRows = db
        .prepare(`SELECT event_seq, id FROM lims_audit ORDER BY event_seq ASC`)
        .all() as Array<{ event_seq: number; id: string }>;
      expect(exportedRows.map((row) => ({ event_seq: row.event_seq, id: row.id }))).toEqual(
        auditRows
      );
      expect(exportedRows.some((row) => row.workspace_id === otherWorkspaceId)).toBe(true);

      const recoveryDb = createTestDb();
      try {
        ensureSchema(recoveryDb, ':memory:');
        recoveryDb
          .prepare(`INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)`)
          .run(workspaceId, 'LIMS export workspace', workspaceRoot, Date.now());
        recoveryDb
          .prepare(`INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)`)
          .run(otherWorkspaceId, 'Other LIMS export workspace', otherWorkspaceRoot, Date.now());
        const restore = restoreLimsAuditAndProjectionFromRowsInDb(recoveryDb, exportedRows);
        expect(restore.importedEvents).toBe(exportedRows.length);
        expect(restore.skippedDuplicateEvents).toBe(0);
        expect(verifyLimsAuditHashChainInDb(recoveryDb)).toMatchObject({
          ok: true,
          failures: [],
        });
        const auditCount = recoveryDb.prepare(`SELECT COUNT(*) as count FROM lims_audit`).get() as {
          count: number;
        };
        expect(auditCount.count).toBe(exportedRows.length);
        const maxSeq = Math.max(...exportedRows.map((row) => row.event_seq));
        const allocator = recoveryDb
          .prepare(`SELECT next_event_seq FROM lims_event_sequence WHERE id = 1`)
          .get() as { next_event_seq: number };
        expect(allocator.next_event_seq).toBe(maxSeq + 1);
        expect(projectionSnapshot(recoveryDb)).toEqual(projectionSnapshot(db));
      } finally {
        recoveryDb.close();
      }
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(otherWorkspaceRoot, { recursive: true, force: true });
    }
  });

  it('rejects unknown workspace roots instead of exporting every workspace into them', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'lims-export-known-'));
    const unknownRoot = mkdtempSync(join(tmpdir(), 'lims-export-unknown-'));
    try {
      const workspaceId = insertWorkspace(db, 'Known LIMS export workspace', workspaceRoot);
      registerLimsEntityInDb(db, {
        kind: 'oligo',
        name: 'Known workspace primer',
        workspaceId,
        fields: {
          sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
          use: 'primer',
        },
      });

      expect(() =>
        materializeLimsGitReadableExportInDb(db, { workspaceRoot: unknownRoot })
      ).toThrow(/not a known workspace/);
      expect(existsSync(join(unknownRoot, '.waypoint'))).toBe(false);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(unknownRoot, { recursive: true, force: true });
    }
  });

  it('repairs a stale export manifest when the JSONL log is missing events', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'lims-export-repair-'));
    try {
      const workspaceId = insertWorkspace(db, 'LIMS repair workspace', workspaceRoot);
      registerLimsEntityInDb(db, {
        kind: 'oligo',
        name: 'Repair primer A',
        workspaceId,
        fields: {
          sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
          use: 'primer',
        },
      });
      materializeLimsGitReadableExportInDb(db, { workspaceRoot });
      const logDir = join(workspaceRoot, '.waypoint', 'lims', 'log');
      for (const name of readdirSync(logDir).filter((entry) => entry.endsWith('.jsonl'))) {
        rmSync(join(logDir, name));
      }

      const repaired = materializeLimsGitReadableExportInDb(db, { workspaceRoot });
      expect(repaired.exportedThroughEventSeq).toBeGreaterThan(0);
      const exportedRows = readLimsAuditExportRowsFromWorkspace(workspaceRoot);
      const auditRows = db
        .prepare(`SELECT event_seq, id FROM lims_audit ORDER BY event_seq ASC`)
        .all() as Array<{ event_seq: number; id: string }>;
      expect(exportedRows.map((row) => ({ event_seq: row.event_seq, id: row.id }))).toEqual(
        auditRows
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
