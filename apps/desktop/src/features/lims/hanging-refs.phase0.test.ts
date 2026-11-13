import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../main/auth/session-store', () => ({
  getActiveStoredSession: vi.fn(async () => null),
}));
import type Database from 'better-sqlite3';
import { createLimsTestBridge } from '../../main/__tests__/lims-bridge-for-db';
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

function activeEntityCount(db: Database.Database): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM lims_entity WHERE tombstone = 0').get() as { n: number }
  ).n;
}
function linksOfType(db: Database.Database, type: string): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS n FROM lims_link WHERE type = ? AND tombstone = 0')
      .get(type) as {
      n: number;
    }
  ).n;
}

describe(' Phase 0 / M2 — an ambiguous parent does not block the import', () => {
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

  async function seedTwoNamesakes(): Promise<void> {
    await lims.registerEntity({
      kind: 'strain',
      name: 'ACME-3',
      fields: { genotypeCanonical: 'wild-type', species: 'E. coli' },
    });
    await lims.registerEntity({
      kind: 'strain',
      name: 'ACME-3',
      fields: { genotypeCanonical: 'ΔargF', species: 'E. coli' },
    });
  }

  const csv = ['Strain,Genotype,Parent Strain', 'ACME-7,ΔlacZ,ACME-3', 'ACME-8,ΔaraB,'].join('\n');

  it('the plan is APPLYABLE even though one row names an ambiguous parent', async () => {
    await seedTwoNamesakes();
    const plan = await createLimsImportPlan({ fileName: 'strains.csv', text: csv });
    expect(plan.canApply).toBe(true);
  });

  it('the ambiguous endpoint is a NON-BLOCKING hanging reference, not a record error', async () => {
    await seedTwoNamesakes();
    const plan = await createLimsImportPlan({ fileName: 'strains.csv', text: csv });
    const acme7 = plan.records.find((r) => r.entityDraft?.name === 'ACME-7');
    expect(acme7).toBeDefined();

    expect(acme7?.errors ?? []).toHaveLength(0);
    const unresolved = acme7?.unresolvedLinks ?? [];
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.severity).toBe('ambiguous');
    expect(unresolved[0]?.label).toBe('ACME-3');
  });

  it('the hanging reference carries its CANDIDATE ids so a human can pick later', async () => {
    await seedTwoNamesakes();
    const plan = await createLimsImportPlan({ fileName: 'strains.csv', text: csv });
    const acme7 = plan.records.find((r) => r.entityDraft?.name === 'ACME-7');
    expect(acme7?.unresolvedLinks[0]?.candidateEntityIds ?? []).toHaveLength(2);
  });

  it('applying COMMITS both rows and creates ZERO lineage edges (never a guess)', async () => {
    await seedTwoNamesakes();
    const before = activeEntityCount(db);

    const plan = await createLimsImportPlan({ fileName: 'strains.csv', text: csv });
    const applied = await applyAcceptedLimsImportPlan(plan, { actor: 'phase0' });

    expect(applied.insertedEntities).toBe(2);
    expect(activeEntityCount(db)).toBe(before + 2);

    expect(linksOfType(db, 'derives_from')).toBe(0);
  });

  it('a row whose parent is ABSENT entirely also commits (the ACME-3-never-imported case)', async () => {
    const plan = await createLimsImportPlan({ fileName: 'strains.csv', text: csv });
    expect(plan.canApply).toBe(true);
    const applied = await applyAcceptedLimsImportPlan(plan, { actor: 'phase0' });
    expect(applied.insertedEntities).toBe(2);
    expect(linksOfType(db, 'derives_from')).toBe(0);
  });

  it('exactly ONE live parent still resolves and creates the edge (no regression)', async () => {
    await lims.registerEntity({
      kind: 'strain',
      name: 'ACME-3',
      fields: { genotypeCanonical: 'wild-type', species: 'E. coli' },
    });
    const plan = await createLimsImportPlan({ fileName: 'strains.csv', text: csv });
    await applyAcceptedLimsImportPlan(plan, { actor: 'phase0' });
    expect(linksOfType(db, 'derives_from')).toBe(1);
  });
});
