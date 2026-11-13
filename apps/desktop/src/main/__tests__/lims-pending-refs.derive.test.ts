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
import { upsertProviderBinding } from '../catalog-provider-bindings';
import { insertAuditEvent } from '../lims-engine-core';
import { derivePendingRefsInDb } from '../lims-pending-refs';

describe(' Phase 1 — derivePendingRefsInDb (read-only)', () => {
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
    await applyAcceptedLimsImportPlan(plan, { actor: 'p1' });
  }

  it('M1 — a strain whose parent is ABSENT yields one OPEN hanging reference', async () => {
    await importStrains(['Strain,Genotype,Parent Strain', 'ACME-7,ΔlacZ,ACME-3'].join('\n'));

    const refs = derivePendingRefsInDb(db);
    expect(refs).toHaveLength(1);
    const r = refs[0];
    expect(r.targetName).toBe('ACME-3');
    expect(r.type).toBe('derives_from');
    expect(r.status).toBe('open');
    expect(r.candidateEntityIds).toHaveLength(0);
    const acme7 = db.prepare(`SELECT id FROM lims_entity WHERE name='ACME-7'`).get() as {
      id: string;
    };
    expect(r.referrerEntityId).toBe(acme7.id);
  });

  it('the reference carries provenance back to the source cell', async () => {
    await importStrains(['Strain,Genotype,Parent Strain', 'ACME-7,ΔlacZ,ACME-3'].join('\n'));
    const r = derivePendingRefsInDb(db)[0];
    expect(r.sourceBatchId).toBeTruthy();
  });

  it('exactly ONE later-registered namesake makes the ref a DRAFT (one candidate, still not linked)', async () => {
    await importStrains(['Strain,Genotype,Parent Strain', 'ACME-7,ΔlacZ,ACME-3'].join('\n'));
    await importStrains(['Strain,Genotype', 'ACME-3,wild-type'].join('\n'));

    const refs = derivePendingRefsInDb(db);
    const acme7ref = refs.find((r) => r.targetName === 'ACME-3');
    expect(acme7ref?.status).toBe('draft');
    expect(acme7ref?.candidateEntityIds).toHaveLength(1);
    const links = db
      .prepare(`SELECT COUNT(*) n FROM lims_link WHERE type='derives_from' AND tombstone=0`)
      .get() as { n: number };
    expect(links.n).toBe(0);
  });

  it('TWO namesakes make the ref AMBIGUOUS with both candidates (never a guess)', async () => {
    await importStrains(['Strain,Genotype,Parent Strain', 'ACME-7,ΔlacZ,ACME-3'].join('\n'));
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

    const r = derivePendingRefsInDb(db).find((x) => x.targetName === 'ACME-3');
    expect(r?.status).toBe('ambiguous');
    expect(r?.candidateEntityIds).toHaveLength(2);
  });

  it('M11 — every derived reference has a live referrer entity (no referrer-less phantom)', async () => {
    const first = ['Strain,Genotype,Parent Strain', 'ACME-7,ΔlacZ,ACME-3'].join('\n');
    await importStrains(first);
    expect(derivePendingRefsInDb(db)).toHaveLength(1);

    await importStrains(
      ['Strain,Genotype,Parent Strain', 'ACME-7,ΔlacZ,ACME-3', 'ACME-9,ΔaraB,ACME-4'].join('\n')
    );

    const refs = derivePendingRefsInDb(db);
    expect(refs.map((r) => r.targetName).sort()).toEqual(['ACME-3', 'ACME-3', 'ACME-4']);
    expect(refs.every((r) => r.referrerEntityId)).toBe(true);
    const liveIds = new Set(
      (db.prepare('SELECT id FROM lims_entity WHERE tombstone = 0').all() as { id: string }[]).map(
        (e) => e.id
      )
    );
    expect(refs.every((r) => liveIds.has(r.referrerEntityId))).toBe(true);
  });

  it('a resolved reference (a real derives_from link now exists) is not reported as open', async () => {
    await importStrains(['Strain,Genotype', 'ACME-3,wild-type'].join('\n'));
    await importStrains(['Strain,Genotype,Parent Strain', 'ACME-7,ΔlacZ,ACME-3'].join('\n'));

    const link = db
      .prepare(`SELECT COUNT(*) n FROM lims_link WHERE type='derives_from' AND tombstone=0`)
      .get() as { n: number };
    expect(link.n).toBe(1);

    const open = derivePendingRefsInDb(db).filter((r) => r.status !== 'resolved');
    expect(open).toHaveLength(0);
  });

  it('resolves an exact provider reference after a later import even when the display name differs', async () => {
    const child = await lims.registerEntity({
      kind: 'strain',
      name: 'Child strain',
      fields: { genotypeCanonical: 'child' },
    });
    const parent = await lims.registerEntity({
      kind: 'strain',
      name: 'Parent display name',
      fields: { genotypeCanonical: 'parent' },
    });
    db.prepare(
      `INSERT INTO catalog_entities
         (id, type, name, locator, storage_type, status, workspace_id, metadata, created_at, updated_at)
       VALUES (?, 'sample', ?, ?, 'database', 'active', NULL, NULL, 1, 1)`
    ).run(parent.id, parent.name, `entity://lims/${parent.id}`);
    upsertProviderBinding(
      db,
      {
        reference: {
          provider: 'benchling',
          stableObjectId: 'bfi_PARENTAA',
          objectClass: 'registry_entity',
          canonicalUrl: null,
          providerAccountHint: null,
        },
        entityId: parent.id,
        bindingKind: 'observed',
        evidence: { source: 'test' },
      },
      1
    );
    insertAuditEvent(db, {
      eventType: 'import_batch_applied',
      subjectTable: 'lims_audit',
      batchId: 'batch-child-before-parent',
      payload: {
        insertedEntityIds: [{ recordId: 'child-record', entityId: child.id }],
        unresolvedLinks: [
          {
            recordId: 'child-record',
            link: {
              label: 'bfi_PARENTAA',
              kind: 'strain',
              type: 'derives_from',
              severity: 'provisional_stub',
              reason: 'The exact provider object has not been imported yet.',
              targetProviderIdentity: {
                provider: 'benchling',
                stableObjectId: 'bfi_PARENTAA',
                objectClass: 'registry_entity',
              },
            },
          },
        ],
      },
    });
    await lims.linkEntities({
      fromEntityId: child.id,
      toEntityId: parent.id,
      type: 'derives_from',
    });

    const ref = derivePendingRefsInDb(db).find(
      (candidate) => candidate.targetName === 'bfi_PARENTAA'
    );
    expect(ref).toEqual(
      expect.objectContaining({
        status: 'resolved',
        candidateEntityIds: [parent.id],
        targetProviderIdentity: {
          provider: 'benchling',
          stableObjectId: 'bfi_PARENTAA',
          objectClass: 'registry_entity',
        },
      })
    );
  });

  it('splits a stored comma-joined relationship into one reference per live display name', async () => {
    const child = await lims.registerEntity({
      kind: 'strain',
      name: 'PCY602',
      fields: { genotypeCanonical: 'child' },
    });
    const sundew = await lims.registerEntity({
      kind: 'strain',
      name: 'GEM-ZQX-Sundew integrated Chr XI',
      fields: { genotypeCanonical: 'sundew' },
    });
    const reporter = await lims.registerEntity({
      kind: 'strain',
      name: 'Triple reporter integrated',
      fields: { genotypeCanonical: 'reporter' },
    });
    insertAuditEvent(db, {
      eventType: 'import_batch_applied',
      subjectTable: 'lims_audit',
      batchId: 'batch-joined-sequence-links',
      payload: {
        insertedEntityIds: [{ recordId: 'pcy602', entityId: child.id }],
        unresolvedLinks: [
          {
            recordId: 'pcy602',
            link: {
              label: 'GEM-ZQX-Sundew integrated Chr XI, Triple reporter integrated',
              type: 'associated_with',
              severity: 'provisional_stub',
              reason: 'No exact source candidate is available yet.',
            },
          },
        ],
      },
    });

    const refs = derivePendingRefsInDb(db).filter((ref) => ref.referrerEntityId === child.id);
    expect(refs.map((ref) => ref.targetName).sort()).toEqual([
      'GEM-ZQX-Sundew integrated Chr XI',
      'Triple reporter integrated',
    ]);
    expect(refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'draft',
          type: 'associated_with',
          candidateEntityIds: [sundew.id],
        }),
        expect.objectContaining({
          status: 'draft',
          type: 'associated_with',
          candidateEntityIds: [reporter.id],
        }),
      ])
    );
  });
});
