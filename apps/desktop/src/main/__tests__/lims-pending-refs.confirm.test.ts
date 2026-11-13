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
  rejectPendingRefCandidateInDb,
  dismissPendingRefInDb,
  restorePendingRefInDb,
} from '../lims-pending-refs';

describe(' Phase 4 — reject / dismiss / restore', () => {
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
    await applyAcceptedLimsImportPlan(plan, { actor: 'p4' });
  }

  it('M7 — rejecting a candidate excludes it and leaves the reference OPEN', async () => {
    await importStrains(['Strain,Genotype,Parent Strain', 'ACME-7,ΔlacZ,ACME-3'].join('\n'));
    const c1 = await lims.registerEntity({
      kind: 'strain',
      name: 'ACME-3',
      fields: { genotypeCanonical: 'wt', species: 'E. coli' },
    });
    let ref = derivePendingRefsInDb(db).find((r) => r.targetName === 'ACME-3');
    expect(ref?.status).toBe('draft');

    rejectPendingRefCandidateInDb(db, { key: ref!.key, rejectedEntityId: c1.id });

    ref = derivePendingRefsInDb(db).find((r) => r.targetName === 'ACME-3');
    expect(ref?.candidateEntityIds).not.toContain(c1.id);
    expect(ref?.status).toBe('open');
  });

  it('a later, different match still resolves a reference whose first candidate was rejected', async () => {
    await importStrains(['Strain,Genotype,Parent Strain', 'ACME-7,ΔlacZ,ACME-3'].join('\n'));
    const wrong = await lims.registerEntity({
      kind: 'strain',
      name: 'ACME-3',
      fields: { genotypeCanonical: 'wrong', species: 'E. coli' },
    });
    const ref0 = derivePendingRefsInDb(db).find((r) => r.targetName === 'ACME-3')!;
    rejectPendingRefCandidateInDb(db, { key: ref0.key, rejectedEntityId: wrong.id });

    const right = await lims.registerEntity({
      kind: 'strain',
      name: 'ACME-3',
      fields: { genotypeCanonical: 'right', species: 'E. coli' },
    });
    const ref = derivePendingRefsInDb(db).find((r) => r.targetName === 'ACME-3');
    expect(ref?.candidateEntityIds).toEqual([right.id]);
    expect(ref?.status).toBe('draft');
  });

  it('dismiss hides a reference; restore brings it back (nothing is destroyed)', async () => {
    await importStrains(['Strain,Genotype,Parent Strain', 'ACME-7,ΔlacZ,GHOST'].join('\n'));
    const ref = derivePendingRefsInDb(db).find((r) => r.targetName === 'GHOST')!;
    expect(ref.status).toBe('open');

    dismissPendingRefInDb(db, { key: ref.key });
    expect(derivePendingRefsInDb(db).find((r) => r.targetName === 'GHOST')?.status).toBe(
      'dismissed'
    );

    restorePendingRefInDb(db, { key: ref.key });
    expect(derivePendingRefsInDb(db).find((r) => r.targetName === 'GHOST')?.status).toBe('open');
  });

  it('reject and dismiss are idempotent (no throw, no duplicate effect)', async () => {
    await importStrains(['Strain,Genotype,Parent Strain', 'ACME-7,ΔlacZ,GHOST'].join('\n'));
    const ref = derivePendingRefsInDb(db).find((r) => r.targetName === 'GHOST')!;
    expect(() => dismissPendingRefInDb(db, { key: ref.key })).not.toThrow();
    expect(() => dismissPendingRefInDb(db, { key: ref.key })).not.toThrow();
    expect(derivePendingRefsInDb(db).find((r) => r.targetName === 'GHOST')?.status).toBe(
      'dismissed'
    );
  });
});
