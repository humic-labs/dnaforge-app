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
  if (!mocks.bridge) throw new Error('bridge not initialized');
  return mocks.bridge;
}
vi.mock('./operations', () => ({
  queryLimsEntities: (input: unknown) => ops().queryEntities(input as never),
  applyLimsImportBatch: (input: unknown) => ops().applyImportBatch(input as never),
}));

import {
  createLimsImportPlan,
  applyAcceptedLimsImportPlan,
  attachProvisionalStubsToImportPlan,
} from './ingress';

function activeEntityCount(db: Database.Database): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM lims_entity WHERE tombstone = 0').get() as { n: number }
  ).n;
}
function auditCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM lims_audit').get() as { n: number }).n;
}
function linksOfType(db: Database.Database, type: string): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS n FROM lims_link WHERE type = ? AND tombstone = 0')
      .get(type) as { n: number }
  ).n;
}
function entityByName(
  db: Database.Database,
  name: string
): { id: string; fields: string } | undefined {
  return db
    .prepare('SELECT id, fields FROM lims_entity WHERE name = ? AND tombstone = 0')
    .get(name) as { id: string; fields: string } | undefined;
}

describe(' Phase 3 — dedup + relationships (real engine)', () => {
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

  it('RE-DROP: re-importing the same strain table WARNS but stays importable (name matches allowed) — ', async () => {
    const csv = [
      'Strain,Genotype,Organism',
      'MG1655,wild-type,E. coli',
      'W3110,F- rph-1,E. coli',
      'DH5alpha,recA1 endA1,E. coli',
    ].join('\n');

    const plan1 = await createLimsImportPlan({ fileName: 'strains.csv', text: csv });
    const applied = await applyAcceptedLimsImportPlan(plan1, { actor: 'p3' });
    expect(applied.insertedEntities).toBe(3);

    const plan2 = await createLimsImportPlan({ fileName: 'strains.csv', text: csv });
    expect(plan2.records.filter((r) => r.action === 'create' && r.accepted)).toHaveLength(3);
    expect(plan2.records.every((r) => r.warnings.some((w) => /already exists/i.test(w)))).toBe(
      true
    );
    expect(plan2.canApply).toBe(true);
  });

  it('ACCESSION match: a renamed plasmid sharing an Addgene # WARNS but still imports — ', async () => {
    await lims.registerEntity({
      kind: 'plasmid',
      name: 'pFoo',
      fields: {
        sequence: normalizeInlineDnaSequenceRef('ACGTACGTACGTACGTACGT'),
        notes: 'Deposited: Addgene #125028',
      },
    });

    const csv = ['Name,Sequence,Notes', 'pBar,TTTTGGGGCCCCAAAATTTT,Addgene #125028'].join('\n');
    const plan = await createLimsImportPlan({
      fileName: 'plasmids.csv',
      text: csv,
      defaultKind: 'plasmid',
    });

    expect(plan.records[0].action).toBe('create');
    expect(plan.records[0].accepted).toBe(true);
    expect(plan.records[0].warnings.some((w) => /accession/i.test(w))).toBe(true);
  });

  it('same name + different sequence imports under the SAME name (no auto-rename) and WARNS — ', async () => {
    await lims.registerEntity({
      kind: 'plasmid',
      name: 'pUC19',
      fields: { sequence: normalizeInlineDnaSequenceRef('ACGTACGTACGTACGTACGT') },
    });
    const before = activeEntityCount(db);

    const csv = ['Name,Sequence', 'pUC19,TTTTGGGGCCCCAAAATTTTGGGG'].join('\n');
    const plan = await createLimsImportPlan({
      fileName: 'p.csv',
      text: csv,
      defaultKind: 'plasmid',
    });

    expect(plan.records[0].action).toBe('create');
    expect(plan.records[0].entityDraft.name).toBe('pUC19');
    expect(plan.records[0].warnings.some((w) => /already exists/i.test(w))).toBe(true);

    const applied = await applyAcceptedLimsImportPlan(plan, { actor: 'p3' });
    expect(applied.insertedEntities).toBe(1);
    expect(activeEntityCount(db)).toBe(before + 1);
    expect(entityByName(db, 'pUC19')).toBeDefined();
  });

  it('DERIVES_FROM: a within-batch parent column creates the sibling lineage edge (preflight batch-aware)', async () => {
    const csv = [
      'Strain,Genotype,Parent Strain',
      'MG1655,wild-type,',
      'W1485,F+ lambda-,MG1655',
      'DH5alpha,recA1,W1485',
    ].join('\n');
    const plan = await createLimsImportPlan({ fileName: 'lineage.csv', text: csv });
    expect(plan.canApply).toBe(true);

    const applied = await applyAcceptedLimsImportPlan(plan, { actor: 'p3' });
    expect(applied.insertedEntities).toBe(3);

    expect(applied.insertedLinks).toBe(2);
    expect(linksOfType(db, 'derives_from')).toBe(2);
  });

  it('PROVISIONAL STUB: an unresolved parent becomes a flagged stub (edge anchored, never dropped)', async () => {
    const csv = ['Strain,Genotype,Parent Strain', 'Xstrain,some mutation,GhostParent'].join('\n');
    const plan = await createLimsImportPlan({ fileName: 'orphan.csv', text: csv });

    expect(linksOfType(db, 'derives_from')).toBe(0);

    const stubbed = await attachProvisionalStubsToImportPlan(plan);
    const applied = await applyAcceptedLimsImportPlan(stubbed, { actor: 'p3' });

    expect(applied.insertedEntities).toBe(2);
    expect(linksOfType(db, 'derives_from')).toBe(1);
    const stub = entityByName(db, 'GhostParent');
    expect(stub).toBeDefined();
    expect(JSON.parse(stub!.fields).provisional).toBe(true);
  });

  it('BULK STUBS: K distinct unresolved parents create exactly K stubs', async () => {
    const csv = [
      'Strain,Genotype,Parent Strain',
      'A,g1,GhostOne',
      'B,g2,GhostTwo',
      'C,g3,GhostOne',
    ].join('\n');
    const plan = await createLimsImportPlan({ fileName: 'orphans.csv', text: csv });
    const stubbed = await attachProvisionalStubsToImportPlan(plan);
    const applied = await applyAcceptedLimsImportPlan(stubbed, { actor: 'p3' });

    expect(applied.insertedEntities).toBe(5);
    expect(linksOfType(db, 'derives_from')).toBe(3);
  });

  it('SUGGESTED free-text edges are PROPOSED (suggested), never auto-applied', async () => {
    await lims.registerEntity({
      kind: 'plasmid',
      name: 'pRS416',
      fields: { sequence: normalizeInlineDnaSequenceRef('ACGTACGTACGTACGTACGT') },
    });
    const csv = ['Strain,Genotype,Source', 'YS1,[pRS416] URA3,Addgene #125028'].join('\n');
    const plan = await createLimsImportPlan({ fileName: 'y.csv', text: csv });

    const suggested = plan.records[0].proposedLinks.filter((l) => l.suggested);

    expect(suggested.length).toBeGreaterThan(0);
    expect(suggested.some((l) => l.type === 'carried_by')).toBe(true);

    const applied = await applyAcceptedLimsImportPlan(plan, { actor: 'p3' });
    expect(applied.insertedEntities).toBe(1);

    expect(linksOfType(db, 'has_marker')).toBe(0);
    expect(linksOfType(db, 'associated_with')).toBe(0);

    expect(linksOfType(db, 'carried_by')).toBe(0);
  });

  it('FUZZY parent is NOT auto-linked to a near-name existing entity', async () => {
    await lims.registerEntity({
      kind: 'strain',
      name: 'BY4741 (MATa)',
      fields: { genotypeCanonical: 'his3-1 leu2-0', organismName: 'S. cerevisiae' },
    });
    const csv = ['Strain,Genotype,Parent Strain', 'BY4741-derA,mut,BY4741'].join('\n');
    const plan = await createLimsImportPlan({ fileName: 'fuzzy.csv', text: csv });
    const applied = await applyAcceptedLimsImportPlan(plan, { actor: 'p3' });

    expect(applied.insertedEntities).toBe(1);

    expect(linksOfType(db, 'derives_from')).toBe(0);
  });

  it('CROSS-CUTTING: lineage import is atomic + reversible (zero silent loss)', async () => {
    const csv = ['Strain,Genotype,Parent Strain', 'P,wt,', 'Q,mut,P'].join('\n');
    const entitiesBefore = activeEntityCount(db);
    const auditBefore = auditCount(db);

    const plan = await createLimsImportPlan({ fileName: 'l.csv', text: csv });

    expect(activeEntityCount(db)).toBe(entitiesBefore);
    expect(auditCount(db)).toBe(auditBefore);

    const applied = await applyAcceptedLimsImportPlan(plan, { actor: 'p3' });
    expect(applied.insertedEntities).toBe(2);
    expect(applied.errors).toHaveLength(0);

    expect(applied.insertedEntities + applied.skipped + applied.errors.length).toBe(2);
    expect(activeEntityCount(db)).toBe(entitiesBefore + 2);

    const undo = await lims.undoImportBatch({ batchId: applied.batchId, actor: 'p3' });
    expect(undo.tombstonedEntities).toBe(2);
    expect(activeEntityCount(db)).toBe(entitiesBefore);
    expect(linksOfType(db, 'derives_from')).toBe(0);
  });
});
