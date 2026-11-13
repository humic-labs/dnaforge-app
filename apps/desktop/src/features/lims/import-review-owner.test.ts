import { describe, expect, it, vi } from 'vitest';
import type { LimsImportPlan } from '../../shared/lims';
import {
  ImportReviewOwner,
  type ImportReviewDependencies,
  type ImportReviewDocument,
} from './import-review-owner';

function harness() {
  const documents = new Map<string, ImportReviewDocument>();
  const state = { fingerprint: 'source-a', authorized: true };
  let id = 0;
  const plan: LimsImportPlan = {
    id: 'legacy-name-and-count',
    sourceName: 'strains.csv',
    sourceKind: 'csv',
    detectedKind: 'strain_table',
    columns: [],
    records: [
      {
        id: 'source-row-1',
        sourceRow: 2,
        accepted: true,
        action: 'create',
        entityDraft: { kind: 'strain', name: 'Test strain', fields: { genotypeCanonical: 'test' } },
        duplicateCandidates: [],
        proposedLinks: [],
        unresolvedLinks: [],
        errors: [],
        warnings: [],
        source: {},
      },
    ],
    aggregateWarnings: [],
    canApply: true,
    oracle: { ok: true, source: 'strains.csv', invariants: [] },
  };
  const dependencies: ImportReviewDependencies = {
    newId: () => `identity-${++id}`,
    read: async (key) => documents.get(key) ?? null,
    write: async (document) => {
      documents.set(document.id, structuredClone(document));
    },
    assertAuthority: async () => {
      if (!state.authorized) throw new Error('Permission revoked');
    },
    fingerprint: async () => state.fingerprint,
    build: async () => structuredClone(plan),
    map: async (current) => current,
    accept: (current, ids, accepted) => ({
      ...current,
      records: current.records.map((record) =>
        ids.includes(record.id)
          ? { ...record, accepted, action: accepted ? 'create' : 'skip' }
          : record
      ),
    }),
    resolveLink: async (current) => current,
    apply: vi.fn(async () => ({
      changed: true,
      artifactPaths: ['records/strain/test.entity.json'],
      imported: 1,
      skipped: 0,
      failed: 0,
    })),
  };
  const owner = new ImportReviewOwner(dependencies);
  const prepare = () =>
    owner.prepare({
      workspaceRoot: '/admitted-project',
      destinationDir: '/admitted-project/imports',
      source: { fileName: 'strains.csv', sourcePath: '/admitted-project/strains.csv' },
    });
  return { documents, state, dependencies, owner, prepare };
}

describe('application-owned import review', () => {
  it('retains a review with no writes and refuses stale decisions without replacing newer review', async () => {
    const h = harness();
    const first = await h.prepare();
    const newer = await h.owner.execute({
      id: first.id,
      expectedRevision: first.revision,
      command: { kind: 'set-records-accepted', recordIds: ['source-row-1'], accepted: false },
    });
    await expect(
      h.owner.execute({
        id: first.id,
        expectedRevision: first.revision,
        command: { kind: 'apply', requestId: 'apply-old' },
      })
    ).rejects.toThrow('STALE_IMPORT_REVIEW');
    expect(h.documents.get(first.id)?.revision).toBe(newer.revision);
    expect(h.documents.get(first.id)?.plan.records[0].accepted).toBe(false);
    expect(h.dependencies.apply).not.toHaveBeenCalled();
  });

  it('refuses changed source bytes before the first import effect', async () => {
    const h = harness();
    const first = await h.prepare();
    h.state.fingerprint = 'outside-edit';
    await expect(
      h.owner.execute({
        id: first.id,
        expectedRevision: first.revision,
        command: { kind: 'apply', requestId: 'apply' },
      })
    ).rejects.toThrow('IMPORT_SOURCE_CHANGED');
    expect(h.dependencies.apply).not.toHaveBeenCalled();
    expect(h.documents.get(first.id)?.phase).toBe('review');
  });

  it('reattaches a completed request after owner restart without importing it twice', async () => {
    const h = harness();
    const first = await h.prepare();
    const request = {
      id: first.id,
      expectedRevision: first.revision,
      command: { kind: 'apply' as const, requestId: 'stable-apply' },
    };
    const result = await h.owner.execute(request);
    const restarted = new ImportReviewOwner(h.dependencies);
    expect(await restarted.execute(request)).toEqual(result);
    expect(h.dependencies.apply).toHaveBeenCalledTimes(1);
    expect(result.receipt?.artifactPaths).toEqual(['records/strain/test.entity.json']);
  });

  it('retains an admitted native outcome when permission is revoked after publication', async () => {
    const h = harness();
    const first = await h.prepare();
    h.dependencies.apply = vi.fn(async () => {
      h.state.authorized = false;
      return {
        changed: true,
        artifactPaths: ['saved.entity.json'],
        imported: 1,
        skipped: 0,
        failed: 0,
      };
    });
    const result = await h.owner.execute({
      id: first.id,
      expectedRevision: first.revision,
      command: { kind: 'apply', requestId: 'native-write' },
    });
    expect(result.phase).toBe('applied');
    expect(h.documents.get(first.id)?.receipt?.artifactPaths).toEqual(['saved.entity.json']);
    await expect(h.owner.execute({ id: first.id, command: { kind: 'inspect' } })).rejects.toThrow(
      'Permission revoked'
    );
  });

  it('retains a partial outcome and never replays the same partial import', async () => {
    const h = harness();
    const first = await h.prepare();
    h.dependencies.apply = vi.fn(async () => ({
      changed: true,
      artifactPaths: ['saved.entity.json'],
      imported: 1,
      skipped: 0,
      failed: 1,
      partialEffects: ['One record failed after the preceding record was saved.'],
    }));
    const request = {
      id: first.id,
      expectedRevision: first.revision,
      command: { kind: 'apply' as const, requestId: 'partial' },
    };
    const result = await h.owner.execute(request);
    expect(result.phase).toBe('partial');
    expect(await h.owner.execute(request)).toEqual(result);
    expect(h.dependencies.apply).toHaveBeenCalledTimes(1);
    await expect(
      h.owner.execute({
        id: first.id,
        expectedRevision: result.revision,
        command: { kind: 'apply', requestId: 'different' },
      })
    ).rejects.toThrow('IMPORT_REVIEW_SETTLED');
  });

  it('refuses unavailable record targets and rejects invalid pagination without writes', async () => {
    const h = harness();
    const first = await h.prepare();
    await expect(
      h.owner.execute({
        id: first.id,
        expectedRevision: first.revision,
        command: { kind: 'set-records-accepted', recordIds: ['other-plan-row'], accepted: true },
      })
    ).rejects.toThrow('IMPORT_RECORD_NOT_FOUND');
    await expect(
      h.owner.execute({ id: first.id, command: { kind: 'inspect', offset: -1 } })
    ).rejects.toThrow('INVALID_IMPORT_REVIEW_PAGE');
    expect(h.documents.get(first.id)?.revision).toBe(first.revision);
    expect(h.dependencies.apply).not.toHaveBeenCalled();
  });
});
