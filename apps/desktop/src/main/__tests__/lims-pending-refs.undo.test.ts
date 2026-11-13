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
import {
  derivePendingRefsInDb,
  confirmPendingRefInDb,
  rejectPendingRefCandidateInDb,
  dismissPendingRefInDb,
} from '../lims-pending-refs';
import {
  assertLimsProjectionReplayParityInDb,
  verifyLimsAuditHashChainInDb,
} from '../lims-projection-rebuild';

describe(' Phase 3 — audit integrity across the hanging-reference lifecycle', () => {
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

  async function importStrains(csv: string): Promise<string> {
    const plan = await createLimsImportPlan({ fileName: 'strains.csv', text: csv });
    const applied = await applyAcceptedLimsImportPlan(plan, { actor: 'p3' });
    return applied.batchId;
  }

  it('M13 + M14 — parity holds and the hash chain verifies after the full lifecycle', async () => {
    await importStrains(['Strain,Genotype,Parent Strain', 'ACME-7,ΔlacZ,ACME-3'].join('\n'));
    const c1 = await lims.registerEntity({
      kind: 'strain',
      name: 'ACME-3',
      fields: { genotypeCanonical: 'wt', species: 'E. coli' },
    });
    const c2 = await lims.registerEntity({
      kind: 'strain',
      name: 'ACME-3',
      fields: { genotypeCanonical: 'v2', species: 'E. coli' },
    });

    let ref = derivePendingRefsInDb(db).find((r) => r.targetName === 'ACME-3')!;
    rejectPendingRefCandidateInDb(db, { key: ref.key, rejectedEntityId: c1.id });
    dismissPendingRefInDb(db, { key: ref.key });
    ref = derivePendingRefsInDb(db).find((r) => r.targetName === 'ACME-3')!;
    expect(ref.candidateEntityIds).toContain(c2.id);

    const parity = assertLimsProjectionReplayParityInDb(db);
    expect(parity.appliedEvents).toBeGreaterThan(0);
    const chain = verifyLimsAuditHashChainInDb(db);
    expect(chain.ok).toBe(true);
    expect(chain.failures).toHaveLength(0);
    expect(chain.checkedEvents).toBeGreaterThan(0);
  });

  it('M13 — parity still holds after a CONFIRM writes a real link', async () => {
    await importStrains(['Strain,Genotype,Parent Strain', 'ACME-7,ΔlacZ,ACME-3'].join('\n'));
    const c = await lims.registerEntity({
      kind: 'strain',
      name: 'ACME-3',
      fields: { genotypeCanonical: 'wt', species: 'E. coli' },
    });
    const ref = derivePendingRefsInDb(db).find((r) => r.targetName === 'ACME-3')!;
    confirmPendingRefInDb(db, { key: ref.key, targetEntityId: c.id });

    const parity = assertLimsProjectionReplayParityInDb(db);
    expect(parity.appliedEvents).toBeGreaterThan(0);
    expect(verifyLimsAuditHashChainInDb(db).ok).toBe(true);
  });

  it('M10 — undoing the referrer import removes the confirmed link and re-dangles the reference', async () => {
    const referrerBatch = await importStrains(
      ['Strain,Genotype,Parent Strain', 'ACME-7,ΔlacZ,ACME-3'].join('\n')
    );
    await importStrains(['Strain,Genotype', 'ACME-3,wild-type'].join('\n'));
    const ref = derivePendingRefsInDb(db).find((r) => r.targetName === 'ACME-3')!;
    const candidate = ref.candidateEntityIds[0];
    confirmPendingRefInDb(db, { key: ref.key, targetEntityId: candidate });

    const linkCount = () =>
      (
        db
          .prepare(`SELECT COUNT(*) n FROM lims_link WHERE type='derives_from' AND tombstone=0`)
          .get() as { n: number }
      ).n;
    expect(linkCount()).toBe(1);

    await lims.undoImportBatch({ batchId: referrerBatch });

    expect(linkCount()).toBe(0);
    expect(
      derivePendingRefsInDb(db).some((r) => r.referrerEntityId && r.targetName === 'ACME-3')
    ).toBe(false);
  });
});
