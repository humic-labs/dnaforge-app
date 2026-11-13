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

import { createLimsImportPlan, applyAcceptedLimsImportPlan } from './ingress';
import { reconcileSequenceToRegistry, type ReconcileEntity } from './sequence-reconciliation';

function linksOfType(db: Database.Database, type: string): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS n FROM lims_link WHERE type = ? AND tombstone = 0')
      .get(type) as { n: number }
  ).n;
}
function activeEntityCount(db: Database.Database): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM lims_entity WHERE tombstone = 0').get() as { n: number }
  ).n;
}

describe(' Phase 4 — scale + reconciliation (real engine)', () => {
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

  it('RECONCILE: exact hash → auto same_as; fuzzy name → suggested associated_with (never auto)', async () => {
    const registry: ReconcileEntity[] = [
      { id: 'p-1', name: 'pDEMO026', normalizedSequenceHash: 'sha256:abc' },
    ];
    const exact = reconcileSequenceToRegistry(
      { name: 'pDEMO026-reimport', normalizedSequenceHash: 'sha256:abc' },
      registry
    );
    expect(exact).toMatchObject({
      verdict: 'exact-auto',
      matchId: 'p-1',
      link: { type: 'same_as', accepted: true },
    });

    const fuzzy = reconcileSequenceToRegistry(
      { name: 'pDEMO026 v2', normalizedSequenceHash: 'sha256:DIFFERENT' },
      registry
    );
    expect(fuzzy.verdict).toBe('fuzzy-suggest');
    expect(fuzzy.link).toMatchObject({ type: 'associated_with', accepted: false });

    const degenerate = reconcileSequenceToRegistry(
      { name: 'pDEMO026', normalizedSequenceHash: '' },
      registry
    );
    expect(degenerate.verdict).not.toBe('exact-auto');
  });

  it('NEW KINDS/LINKS round-trip: guide_rna + targets + same_as register + link cleanly', async () => {
    const guide = await lims.registerEntity({
      kind: 'guide_rna',
      name: 'sgRNA-ADE2',
      fields: { spacer: 'GATCGATCGATCGATCGATC' },
    });
    const locus = await lims.registerEntity({ kind: 'locus', name: 'ADE2', fields: {} });
    const marker = await lims.registerEntity({ kind: 'marker', name: 'URA3', fields: {} });

    await expect(
      lims.linkEntities({ fromEntityId: guide.id, toEntityId: locus.id, type: 'targets' })
    ).resolves.toBeDefined();
    await expect(
      lims.linkEntities({ fromEntityId: locus.id, toEntityId: marker.id, type: 'same_as' })
    ).resolves.toBeDefined();
    expect(linksOfType(db, 'targets')).toBe(1);
    expect(linksOfType(db, 'same_as')).toBe(1);
  });

  it('BENCHLING ACCEPTANCE SLICE: reproduce a lineage registry slice end-to-end', async () => {
    await lims.registerEntity({
      kind: 'plasmid',
      name: 'pACME1',
      fields: { sequence: normalizeInlineDnaSequenceRef('ACGTACGTACGTACGTACGT') },
    });
    const before = activeEntityCount(db);

    const csv = [
      'Strain,Genotype,Organism,Parent Strain,Plasmid Carried',
      'ACME-WT,wild-type,S. cerevisiae,,',
      'ACME-A,ura3-52,S. cerevisiae,ACME-WT,pACME1',
      'ACME-B,ura3-52 leu2-0,S. cerevisiae,ACME-A,pACME1',
    ].join('\n');
    const plan = await createLimsImportPlan({ fileName: 'benchling-slice.csv', text: csv });
    expect(plan.canApply).toBe(true);

    const applied = await applyAcceptedLimsImportPlan(plan, { actor: 'benchling' });

    expect(applied.insertedEntities).toBe(3);
    expect(activeEntityCount(db)).toBe(before + 3);
    expect(applied.insertedLinks).toBe(4);
    expect(linksOfType(db, 'derives_from')).toBe(2);
    expect(linksOfType(db, 'carried_by')).toBe(2);

    const acmeB = db.prepare("SELECT id FROM lims_entity WHERE name = 'ACME-B'").get() as {
      id: string;
    };
    const acmeA = db.prepare("SELECT id FROM lims_entity WHERE name = 'ACME-A'").get() as {
      id: string;
    };
    const edge = db
      .prepare(
        "SELECT COUNT(*) AS n FROM lims_link WHERE type='derives_from' AND from_entity_id=? AND to_entity_id=? AND tombstone=0"
      )
      .get(acmeB.id, acmeA.id) as { n: number };
    expect(edge.n).toBe(1);

    const fields = JSON.parse(
      (
        db.prepare("SELECT fields FROM lims_entity WHERE name = 'ACME-A'").get() as {
          fields: string;
        }
      ).fields
    ) as { sourceMetadata?: { origin?: { sourceName?: string }; row?: { index?: number } } };
    expect(fields.sourceMetadata?.origin?.sourceName).toBe('benchling-slice.csv');
    expect(typeof fields.sourceMetadata?.row?.index).toBe('number');

    const undo = await lims.undoImportBatch({ batchId: applied.batchId, actor: 'benchling' });
    expect(undo.tombstonedEntities).toBe(3);
    expect(activeEntityCount(db)).toBe(before);
    expect(linksOfType(db, 'derives_from')).toBe(0);
    expect(linksOfType(db, 'carried_by')).toBe(0);
  });
});
