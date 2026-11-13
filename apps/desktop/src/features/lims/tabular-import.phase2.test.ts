import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../main/auth/session-store', () => ({
  getActiveStoredSession: vi.fn(async () => null),
}));
import type Database from 'better-sqlite3';
import { createLimsTestBridge } from '../../main/__tests__/lims-bridge-for-db';
import { SHEET_VERDICTS } from '../../shared/lims';
import type { PlatformBridge } from '../../platform/index';
import { build187SheetWorkbook, STRAINS_ROWS } from './__fixtures__/messy-workbook';

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

const WORKBOOK = build187SheetWorkbook();

function activeEntityCount(db: Database.Database): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM lims_entity WHERE tombstone = 0').get() as { n: number }
  ).n;
}
function auditCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get() as { n: number }).n;
}

describe(' Phase 2 — 187-sheet messy workbook triage + header detection (real engine)', () => {
  let db: Database.Database;
  let lims: PlatformBridge['lims'];

  beforeEach(async () => {
    vi.clearAllMocks();
    const bridge = createLimsTestBridge();
    db = bridge.db;
    lims = bridge.lims;
    mocks.bridge = lims;
    await lims.ensureSeeded();
  });

  it('triage is EXHAUSTIVE: every one of 187 sheets gets a valid visible disposition', async () => {
    const plan = await createLimsImportPlan({ fileName: 'messy-187.xlsx', arrayBuffer: WORKBOOK });

    expect(plan.sheetDispositions).toBeDefined();

    expect(plan.sheetDispositions).toHaveLength(187);
    expect(plan.sheetDispositions!.every((d) => SHEET_VERDICTS.includes(d.verdict))).toBe(true);
  });

  it('surfaces exactly the 2 real entity sheets out of 187', async () => {
    const plan = await createLimsImportPlan({ fileName: 'messy-187.xlsx', arrayBuffer: WORKBOOK });
    const entitySheets = plan
      .sheetDispositions!.filter((d) => d.verdict === 'entity-table')
      .map((d) => d.sheetName);
    expect(entitySheets).toEqual(['Strains', 'Oligos']);

    expect(plan.selectedSheet).toBe('Strains');
  });

  it('RED GATE: a real-but-tiny entity sheet is still VISIBLE (surfaced, never dropped)', async () => {
    const plan = await createLimsImportPlan({ fileName: 'messy-187.xlsx', arrayBuffer: WORKBOOK });
    const tiny = plan.sheetDispositions!.find((d) => d.sheetName === 'TinyPrimers');

    expect(tiny).toBeDefined();
    expect(tiny!.verdict).toBe('possible-table');
  });

  it('SIDE-BY-SIDE sheet is flagged leftover-region, not mis-parsed into the entity set', async () => {
    const plan = await createLimsImportPlan({ fileName: 'messy-187.xlsx', arrayBuffer: WORKBOOK });
    const side = plan.sheetDispositions!.find((d) => d.sheetName === 'SideBySide');
    expect(side!.verdict).toBe('leftover-region');
    expect(plan.sheetDispositions!.filter((d) => d.verdict === 'entity-table')).not.toContainEqual(
      expect.objectContaining({ sheetName: 'SideBySide' })
    );
  });

  it('HEADER-UNDER-TITLE: the Strains header is found on row 3, not the title — mapping is not shifted', async () => {
    const plan = await createLimsImportPlan({ fileName: 'messy-187.xlsx', arrayBuffer: WORKBOOK });

    const strains = plan.sheetDispositions!.find((d) => d.sheetName === 'Strains');
    expect(strains!.headerRowIndex).toBe(2);

    const mapped = new Map(plan.columns.map((c) => [c.sourceColumn, c.mappedField]));
    expect(mapped.get('Strain')).toBeTruthy();
    expect(mapped.get('Genotype')).toBeTruthy();
    expect(mapped.get('Organism')).toBeTruthy();

    expect(plan.records).toHaveLength(STRAINS_ROWS.length);
    expect(plan.records[0].entityDraft).toMatchObject({
      kind: 'strain',
      name: 'MG1655',
      fields: { organismName: 'Escherichia coli' },
    });
  });

  it('HEADERLESS: the Oligos plate synthesizes Name + Sequence; the first cell is the entity name', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'messy-187.xlsx',
      arrayBuffer: WORKBOOK,
      sheetName: 'Oligos',
    });
    expect(plan.selectedSheet).toBe('Oligos');
    const cols = plan.columns.map((c) => c.sourceColumn);
    expect(cols).toContain('Name');
    expect(cols).toContain('Sequence');

    expect(plan.records[0].entityDraft.name).toBe('oligo-1');
    expect(plan.records).toHaveLength(34);
  });

  it('CROSS-CUTTING: the selected sheet registers atomically + reverses (zero-silent-loss / atomic / reversible)', async () => {
    const entitiesBefore = activeEntityCount(db);
    const auditBefore = auditCount(db);

    const plan = await createLimsImportPlan({
      fileName: 'messy-187.xlsx',
      arrayBuffer: WORKBOOK,
      sheetName: 'Strains',
    });

    expect(activeEntityCount(db)).toBe(entitiesBefore);
    expect(auditCount(db)).toBe(auditBefore);
    expect(plan.canApply).toBe(true);

    const result = await applyAcceptedLimsImportPlan(plan, { actor: 'phase2-gate' });
    expect(result.insertedEntities).toBe(STRAINS_ROWS.length);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    expect(result.insertedEntities + result.skipped + result.errors.length).toBe(
      STRAINS_ROWS.length
    );
    expect(activeEntityCount(db)).toBe(entitiesBefore + STRAINS_ROWS.length);

    const undo = await lims.undoImportBatch({ batchId: result.batchId, actor: 'phase2-gate' });
    expect(undo.tombstonedEntities).toBe(STRAINS_ROWS.length);
    expect(activeEntityCount(db)).toBe(entitiesBefore);
  });
});
