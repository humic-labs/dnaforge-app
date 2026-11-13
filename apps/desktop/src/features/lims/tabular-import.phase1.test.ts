import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../main/auth/session-store', () => ({
  getActiveStoredSession: vi.fn(async () => null),
}));
import type Database from 'better-sqlite3';
import { createLimsTestBridge } from '../../main/__tests__/lims-bridge-for-db';
import { normalizeInlineDnaSequenceRef } from '../../shared/lims';
import type { PlatformBridge } from '../../platform/index';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: {},
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
}));

const mocks = vi.hoisted(() => ({ bridge: null as PlatformBridge['lims'] | null }));
function ops(): PlatformBridge['lims'] {
  if (!mocks.bridge) throw new Error('mocks.bridge not initialized');
  return mocks.bridge;
}

vi.mock('./operations', () => ({
  queryLimsEntities: (input: unknown) => ops().queryEntities(input as never),
  applyLimsImportBatch: (input: unknown) => ops().applyImportBatch(input as never),
}));

import { createLimsImportPlan, applyAcceptedLimsImportPlan } from './ingress';

const STRAINS_CSV = readFileSync(join(__dirname, '__fixtures__', 'strains-34.csv'), 'utf8');

const CARRIED_PLASMIDS = ['pUC19', 'pET28a', 'pACYC184', 'pRS416'];
const ROWS_WITH_PLASMID = 28;

function activeEntityCount(db: Database.Database): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM lims_entity WHERE tombstone = 0').get() as { n: number }
  ).n;
}
function auditCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get() as { n: number }).n;
}

describe(' Phase 1 — 34-row strains.csv → registry → undo (real engine)', () => {
  let db: Database.Database;
  let lims: PlatformBridge['lims'];

  beforeEach(async () => {
    vi.clearAllMocks();
    const bridge = createLimsTestBridge();
    db = bridge.db;
    lims = bridge.lims;
    mocks.bridge = lims;
    await lims.ensureSeeded();
    for (const name of CARRIED_PLASMIDS) {
      await lims.registerEntity({
        kind: 'plasmid',
        name,
        fields: { sequence: normalizeInlineDnaSequenceRef('ACGTACGTACGTACGTACGT') },
      });
    }
  });

  it('plan: 34 register records + column→field map + resolved within-table carried_by links', async () => {
    const plan = await createLimsImportPlan({ fileName: 'strains.csv', text: STRAINS_CSV });

    expect(plan.detectedKind).toBe('strain_table');
    expect(plan.canApply).toBe(true);
    expect(plan.records).toHaveLength(34);
    expect(plan.records.every((r) => r.action === 'create' && r.accepted)).toBe(true);

    const mapped = new Map(plan.columns.map((c) => [c.sourceColumn, c.mappedField]));
    expect(mapped.get('Genotype')).toBeTruthy();
    expect(mapped.get('Organism')).toBeTruthy();
    expect(mapped.get('Plasmid Carried')).toBeTruthy();

    expect(plan.records[0].entityDraft).toMatchObject({
      kind: 'strain',
      name: 'DH5alpha',
      fields: {
        genotypeCanonical: 'F- endA1 glnV44 thi-1 recA1 relA1 gyrA96 deoR',
        organismName: 'Escherichia coli K-12',
      },
    });

    const resolvedCarriedBy = plan.records.flatMap((r) =>
      r.proposedLinks.filter(
        (l) => l.type === 'carried_by' && !l.fromEntityLookup && !l.toEntityLookup
      )
    );
    expect(resolvedCarriedBy).toHaveLength(ROWS_WITH_PLASMID);
    expect(plan.records.flatMap((r) => r.unresolvedLinks)).toHaveLength(0);
  });

  it('atomic: building the plan writes ZERO rows; nothing hits the registry before apply', async () => {
    const entitiesBefore = activeEntityCount(db);
    const auditBefore = auditCount(db);

    await createLimsImportPlan({ fileName: 'strains.csv', text: STRAINS_CSV });

    expect(activeEntityCount(db)).toBe(entitiesBefore);
    expect(auditCount(db)).toBe(auditBefore);
  });

  it('apply: registers exactly 34 entities + 28 carried_by links, zero silent loss', async () => {
    const entitiesBefore = activeEntityCount(db);

    const plan = await createLimsImportPlan({ fileName: 'strains.csv', text: STRAINS_CSV });
    const result = await applyAcceptedLimsImportPlan(plan, { actor: 'phase1-gate' });

    expect(result.insertedEntities).toBe(34);
    expect(result.insertedLinks).toBe(ROWS_WITH_PLASMID);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.batchId).toBeTruthy();

    expect(result.insertedEntities + result.skipped + result.errors.length).toBe(34);

    expect(activeEntityCount(db)).toBe(entitiesBefore + 34);
  });

  it('reversible: one Undo tombstones all 34 entities + their links, registry byte-identical', async () => {
    const entitiesBefore = activeEntityCount(db);

    const plan = await createLimsImportPlan({ fileName: 'strains.csv', text: STRAINS_CSV });
    const applied = await applyAcceptedLimsImportPlan(plan, { actor: 'phase1-gate' });
    expect(activeEntityCount(db)).toBe(entitiesBefore + 34);

    const undo = await lims.undoImportBatch({ batchId: applied.batchId, actor: 'phase1-gate' });

    expect(undo.tombstonedEntities).toBe(34);
    expect(undo.tombstonedLinks).toBe(ROWS_WITH_PLASMID);

    expect(activeEntityCount(db)).toBe(entitiesBefore);
  });
});
