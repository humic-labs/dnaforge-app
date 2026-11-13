import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createLimsTestBridge } from './lims-bridge-for-db';
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
vi.mock('../../features/lims/operations', () => ({
  queryLimsEntities: (input: unknown) => ops().queryEntities(input as never),
  applyLimsImportBatch: (input: unknown) => ops().applyImportBatch(input as never),
}));

import { createLimsImportPlan, applyAcceptedLimsImportPlan } from '../../features/lims/ingress';
import { derivePendingRefsInDb, confirmPendingRefInDb } from '../lims-pending-refs';

function derivesFromLinks(db: Database.Database) {
  return db
    .prepare(
      `SELECT l.from_entity_id, l.to_entity_id, l.payload AS payload, a.batch_id AS batch_id
       FROM lims_link l JOIN lims_audit a ON a.subject_id = l.id AND a.event_type='link_created'
       WHERE l.type='derives_from' AND l.tombstone=0`
    )
    .all() as Array<{
    from_entity_id: string;
    to_entity_id: string;
    payload: string;
    batch_id: string | null;
  }>;
}

describe(' Phase 2 — confirm a hanging reference (first write)', () => {
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

  async function importStrains(csv: string): Promise<void> {
    const plan = await createLimsImportPlan({ fileName: 'strains.csv', text: csv });
    await applyAcceptedLimsImportPlan(plan, { actor: 'p2' });
  }

  async function seedDraft(): Promise<{ refKey: string; candidateId: string }> {
    await importStrains(['Strain,Genotype,Parent Strain', 'ACME-7,ΔlacZ,ACME-3'].join('\n'));
    await importStrains(['Strain,Genotype', 'ACME-3,wild-type'].join('\n'));
    const ref = derivePendingRefsInDb(db).find((r) => r.targetName === 'ACME-3');
    expect(ref?.status).toBe('draft');
    return { refKey: ref!.key, candidateId: ref!.candidateEntityIds[0] };
  }

  it('M5 — importing the parent by NAME creates NO link on its own (a draft, never auto-connected)', async () => {
    await seedDraft();
    expect(derivesFromLinks(db)).toHaveLength(0);
  });

  it('confirm writes ONE link, referrer→candidate, stamped human-confirmed + the REFERRER batch id', async () => {
    const { refKey, candidateId } = await seedDraft();
    const referrerBatch = derivePendingRefsInDb(db).find((r) => r.key === refKey)!.sourceBatchId;

    confirmPendingRefInDb(db, { key: refKey, targetEntityId: candidateId, actor: 'human' });

    const links = derivesFromLinks(db);
    expect(links).toHaveLength(1);
    expect(links[0].to_entity_id).toBe(candidateId);
    expect(JSON.parse(links[0].payload).resolution?.method).toBe('human-confirmed');
    expect(links[0].batch_id).toBe(referrerBatch);
  });

  it('after confirm the reference is derived as RESOLVED', async () => {
    const { refKey, candidateId } = await seedDraft();
    confirmPendingRefInDb(db, { key: refKey, targetEntityId: candidateId });
    const ref = derivePendingRefsInDb(db).find((r) => r.key === refKey);
    expect(ref?.status).toBe('resolved');
  });

  it('M16 — confirming twice is a no-op: still one link, no throw', async () => {
    const { refKey, candidateId } = await seedDraft();
    confirmPendingRefInDb(db, { key: refKey, targetEntityId: candidateId });
    expect(() =>
      confirmPendingRefInDb(db, { key: refKey, targetEntityId: candidateId })
    ).not.toThrow();
    expect(derivesFromLinks(db)).toHaveLength(1);
  });

  it('refuses to confirm to an entity that is NOT a candidate of the reference', async () => {
    const { refKey } = await seedDraft();
    const stranger = await lims.registerEntity({
      kind: 'strain',
      name: 'UNRELATED',
      fields: { genotypeCanonical: 'x', species: 'E. coli' },
    });
    expect(() => confirmPendingRefInDb(db, { key: refKey, targetEntityId: stranger.id })).toThrow(
      /candidate/i
    );
    expect(derivesFromLinks(db)).toHaveLength(0);
  });

  it('M17 — a cycle-closing confirm throws and leaves the reference a DRAFT (no partial damage)', async () => {
    await importStrains(['Strain,Genotype,Parent Strain', 'P-strain,g1,Q-strain'].join('\n'));
    await importStrains(['Strain,Genotype,Parent Strain', 'Q-strain,g2,P-strain'].join('\n'));

    const qToP = derivesFromLinks(db);
    expect(qToP).toHaveLength(1);

    const ref = derivePendingRefsInDb(db).find((r) => r.targetName === 'Q-strain');
    expect(ref?.status).toBe('draft');

    const before = derivesFromLinks(db).length;
    expect(() =>
      confirmPendingRefInDb(db, { key: ref!.key, targetEntityId: ref!.candidateEntityIds[0] })
    ).toThrow(/cycle/i);
    expect(derivesFromLinks(db).length).toBe(before);
    expect(derivePendingRefsInDb(db).find((r) => r.targetName === 'Q-strain')?.status).toBe(
      'draft'
    );
  });
});
