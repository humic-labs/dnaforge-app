import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  advanceBenchlingMigrationAllocation,
  parseBenchlingMigrationActionJournal,
  type BenchlingMigrationActionJournal,
} from '../../shared/benchling-migration-action-journal';
import {
  benchlingMigrationActionJournalRelativePath,
  advancePersistedBenchlingMigrationAllocation,
  advancePersistedBenchlingMigrationAllocations,
  readBenchlingMigrationActionJournal,
  recoverBenchlingMigrationActionJournal,
  reserveBenchlingMigrationAction,
  writeBenchlingMigrationActionJournal,
  setMigrationJournalObserverForTest,
} from './action-journal';
import {
  LOCAL_PROJECTION_WORKER_JOB_SCHEMA,
  runLocalProjectionWorkerJob,
} from './local-projection-worker-job';
import type { MigrationRun, SourceObject } from '../../shared/benchling-migration';
import { assertWorkspaceMigrationActionsSettled } from '../workspace-migration-admission';
import { withUnavailableWindowsDirectoryHandles } from './__fixtures__/windows-directory-handles';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const wrapped = { ...actual, open: vi.fn(actual.open) };
  return { ...wrapped, default: wrapped };
});

const DIGEST = `sha256:${'a'.repeat(64)}` as const;

describe('Benchling migration action journal', () => {
  afterEach(() => setMigrationJournalObserverForTest(undefined));

  it('publishes and recovers a journal without Windows directory handles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'migration-windows-journal-'));
    try {
      await withUnavailableWindowsDirectoryHandles(async (counts) => {
        const journal = fixture(root);
        await writeBenchlingMigrationActionJournal(root, journal);
        expect(await readBenchlingMigrationActionJournal(root, journal.actionId)).toEqual(journal);
        const pending = { ...journal, updatedAt: '2026-08-29T13:00:00.000Z' };
        const path = join(root, benchlingMigrationActionJournalRelativePath(journal.actionId));
        await writeFile(`${path}.pending`, JSON.stringify(pending));
        await recoverBenchlingMigrationActionJournal(root, journal.actionId);
        expect(await readBenchlingMigrationActionJournal(root, journal.actionId)).toEqual(pending);
        expect(counts.directoryOpens).toBe(0);
        expect(counts.fileSyncs).toBeGreaterThan(0);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('blocks ordinary workspace projection until every import allocation completes', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'migration-admission-'));
    await expect(assertWorkspaceMigrationActionsSettled(workspacePath)).resolves.toBeUndefined();
    const journal = fixture(workspacePath);
    const path = join(workspacePath, benchlingMigrationActionJournalRelativePath(journal.actionId));
    await mkdir(join(workspacePath, '.dnaforge/migration/actions'), { recursive: true });
    for (const state of [
      'reserved',
      'staged',
      'installed',
      'catalog_committed',
      'manifest_committed',
    ] as const) {
      await writeFile(
        path,
        JSON.stringify({
          ...journal,
          allocations: journal.allocations.map((a) => ({ ...a, installState: state })),
        })
      );
      await expect(assertWorkspaceMigrationActionsSettled(workspacePath)).rejects.toThrow(
        /recovery/i
      );
    }
    await writeFile(
      path,
      JSON.stringify({
        ...journal,
        allocations: journal.allocations.map((a) => ({ ...a, installState: 'complete' })),
      })
    );
    await expect(assertWorkspaceMigrationActionsSettled(workspacePath)).resolves.toBeUndefined();
    await writeFile(
      `${path}.pending`,
      JSON.stringify({ ...journal, updatedAt: '2026-08-29T13:00:00.000Z' })
    );
    await expect(assertWorkspaceMigrationActionsSettled(workspacePath)).rejects.toThrow(
      /recovery/i
    );
    await writeFile(`${path}.pending`, JSON.stringify(journal));
    await expect(assertWorkspaceMigrationActionsSettled(workspacePath)).resolves.toBeUndefined();
    await writeFile(`${path}.pending`, JSON.stringify({ ...journal, runId: 'other-run' }));
    await expect(assertWorkspaceMigrationActionsSettled(workspacePath)).rejects.toThrow(
      /identity|immutable/i
    );
  });

  async function batchFixture() {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-action-journal-'));
    const base = fixture(workspacePath);
    const allocation = base.allocations[0];
    if (allocation.providerIdentity === null) throw new Error('Expected provider fixture.');
    const journal = {
      ...base,
      allocations: Array.from({ length: 4 }, (_, index) => ({
        ...allocation,
        sourceObjectId: `seq_BATCH${index}`,
        providerIdentity: {
          ...allocation.providerIdentity,
          stableObjectId: `seq_BATCH${index}`,
        },
        destinationEntityId: `migration-sequence-${index}`,
        destination: { kind: 'file', relativePath: `Selected Root/Plasmid${index}.gb` } as const,
        actionOwnedPaths: [`Selected Root/Plasmid${index}.gb`],
        installState: 'installed' as const,
      })),
    } satisfies BenchlingMigrationActionJournal;
    await writeBenchlingMigrationActionJournal(workspacePath, journal);
    return {
      workspacePath,
      journal,
      input: {
        workspacePath,
        actionId: journal.actionId,
        sourceObjectIds: journal.allocations.map((a) => a.sourceObjectId),
        nextState: 'catalog_committed' as const,
        updatedAt: '2026-08-29T12:01:00.000Z',
      },
    };
  }

  it('persists a complete batch once and makes duplicate retries read-only', async () => {
    const { workspacePath, journal, input } = await batchFixture();
    let writes = 0;
    setMigrationJournalObserverForTest(async () => {
      writes++;
    });
    const next = await advancePersistedBenchlingMigrationAllocations(input);
    expect(writes).toBe(1);
    expect(next.allocations.every((a) => a.installState === 'catalog_committed')).toBe(true);
    expect(await readBenchlingMigrationActionJournal(workspacePath, journal.actionId)).toEqual(
      next
    );
    expect(
      await advancePersistedBenchlingMigrationAllocations({
        ...input,
        sourceObjectIds: [...input.sourceObjectIds, input.sourceObjectIds[0]],
      })
    ).toEqual(next);
    expect(writes).toBe(1);
  });

  it('coalesces concurrent installation checkpoints without acknowledging before durability', async () => {
    const { workspacePath, journal, input } = await batchFixture();
    await writeBenchlingMigrationActionJournal(workspacePath, {
      ...journal,
      allocations: journal.allocations.map((a) => ({ ...a, installState: 'reserved' })),
    });
    let release: () => void = () => undefined;
    const durableGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const observed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let writes = 0;
    let acknowledged = 0;
    setMigrationJournalObserverForTest(async () => {
      writes++;
      entered();
      await durableGate;
    });
    const staged = input.sourceObjectIds.map((sourceObjectId) =>
      advancePersistedBenchlingMigrationAllocation({
        ...input,
        sourceObjectId,
        nextState: 'staged',
      }).then((value) => {
        acknowledged++;
        return value;
      })
    );
    await observed;
    expect(acknowledged).toBe(0);
    release();
    await Promise.all(staged);
    expect(writes).toBe(1);
    await Promise.all(
      input.sourceObjectIds.map((sourceObjectId) =>
        advancePersistedBenchlingMigrationAllocation({
          ...input,
          sourceObjectId,
          nextState: 'installed',
        })
      )
    );
    expect(writes).toBe(2);
    const durable = await readBenchlingMigrationActionJournal(workspacePath, journal.actionId);
    expect(durable?.allocations.every((a) => a.installState === 'installed')).toBe(true);
  });

  it('rejects conflicting queued states without skipping durability and accepts a later retry', async () => {
    const { workspacePath, journal, input } = await batchFixture();
    await writeBenchlingMigrationActionJournal(workspacePath, {
      ...journal,
      allocations: journal.allocations.map((a) => ({ ...a, installState: 'reserved' })),
    });
    const sourceObjectId = input.sourceObjectIds[0];
    const bad = await Promise.allSettled([
      advancePersistedBenchlingMigrationAllocation({
        ...input,
        sourceObjectId,
        nextState: 'staged',
      }),
      advancePersistedBenchlingMigrationAllocation({
        ...input,
        sourceObjectId,
        nextState: 'installed',
      }),
    ]);
    expect(bad.every((r) => r.status === 'rejected')).toBe(true);
    expect(
      (await readBenchlingMigrationActionJournal(workspacePath, journal.actionId))?.allocations[0]
        .installState
    ).toBe('reserved');
    await advancePersistedBenchlingMigrationAllocation({
      ...input,
      sourceObjectId,
      nextState: 'staged',
    });
    await advancePersistedBenchlingMigrationAllocation({
      ...input,
      sourceObjectId,
      nextState: 'installed',
    });
    expect(
      (await readBenchlingMigrationActionJournal(workspacePath, journal.actionId))?.allocations[0]
        .installState
    ).toBe('installed');
  });

  it('propagates a failed durable observer to all covered callbacks and drains the next batch', async () => {
    const { workspacePath, journal, input } = await batchFixture();
    await writeBenchlingMigrationActionJournal(workspacePath, {
      ...journal,
      allocations: journal.allocations.map((a) => ({ ...a, installState: 'reserved' })),
    });
    setMigrationJournalObserverForTest(async () => {
      throw new Error('checkpoint failed');
    });
    const results = await Promise.allSettled(
      input.sourceObjectIds.map((sourceObjectId) =>
        advancePersistedBenchlingMigrationAllocation({
          ...input,
          sourceObjectId,
          nextState: 'staged',
        })
      )
    );
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    setMigrationJournalObserverForTest(undefined);
    await Promise.all(
      input.sourceObjectIds.map((sourceObjectId) =>
        advancePersistedBenchlingMigrationAllocation({
          ...input,
          sourceObjectId,
          nextState: 'staged',
        })
      )
    );
    await Promise.all(
      input.sourceObjectIds.map((sourceObjectId) =>
        advancePersistedBenchlingMigrationAllocation({
          ...input,
          sourceObjectId,
          nextState: 'installed',
        })
      )
    );
    expect(
      (
        await readBenchlingMigrationActionJournal(workspacePath, journal.actionId)
      )?.allocations.every((a) => a.installState === 'installed')
    ).toBe(true);
  });

  it('never coalesces distinct actions in the same workspace', async () => {
    const { workspacePath, journal, input } = await batchFixture();
    const initial = {
      ...journal,
      allocations: journal.allocations.map((a) => ({ ...a, installState: 'reserved' as const })),
    };
    await writeBenchlingMigrationActionJournal(workspacePath, initial);
    await writeBenchlingMigrationActionJournal(workspacePath, {
      ...initial,
      actionId: 'action-other',
    });
    const writes: string[] = [];
    setMigrationJournalObserverForTest(async (_path, checkpoint) => {
      writes.push(checkpoint.actionId);
    });
    await Promise.all(
      [journal.actionId, 'action-other'].flatMap((actionId) =>
        input.sourceObjectIds.map((sourceObjectId) =>
          advancePersistedBenchlingMigrationAllocation({
            ...input,
            actionId,
            sourceObjectId,
            nextState: 'staged',
          })
        )
      )
    );
    expect(writes.sort()).toEqual([journal.actionId, 'action-other'].sort());
    for (const actionId of writes)
      expect(
        (await readBenchlingMigrationActionJournal(workspacePath, actionId))?.allocations.every(
          (a) => a.installState === 'staged'
        )
      ).toBe(true);
  });

  it('rejects the whole batch when one transition is invalid or missing', async () => {
    const { workspacePath, journal, input } = await batchFixture();
    await advancePersistedBenchlingMigrationAllocation({
      ...input,
      sourceObjectId: input.sourceObjectIds[0],
    });
    const before = await readBenchlingMigrationActionJournal(workspacePath, journal.actionId);
    await expect(
      advancePersistedBenchlingMigrationAllocations({ ...input, nextState: 'manifest_committed' })
    ).rejects.toThrow(/cannot advance/);
    await expect(
      advancePersistedBenchlingMigrationAllocations({
        ...input,
        sourceObjectIds: [...input.sourceObjectIds, 'missing'],
      })
    ).rejects.toThrow(/missing/);
    expect(await readBenchlingMigrationActionJournal(workspacePath, journal.actionId)).toEqual(
      before
    );
  });

  it('finishes a partially recorded legacy stage without moving completed entries backward', async () => {
    const { input } = await batchFixture();
    await advancePersistedBenchlingMigrationAllocation({
      ...input,
      sourceObjectId: input.sourceObjectIds[0],
    });
    const next = await advancePersistedBenchlingMigrationAllocations(input);
    expect(next.allocations.every((a) => a.installState === 'catalog_committed')).toBe(true);
    await expect(
      advancePersistedBenchlingMigrationAllocations({ ...input, nextState: 'installed' })
    ).rejects.toThrow(/cannot advance/);
  });

  it('serializes disjoint batches without losing either update', async () => {
    const { workspacePath, journal, input } = await batchFixture();
    await Promise.all([
      advancePersistedBenchlingMigrationAllocations({
        ...input,
        sourceObjectIds: input.sourceObjectIds.slice(0, 2),
      }),
      advancePersistedBenchlingMigrationAllocations({
        ...input,
        sourceObjectIds: input.sourceObjectIds.slice(2),
      }),
    ]);
    const next = await readBenchlingMigrationActionJournal(workspacePath, journal.actionId);
    expect(next?.allocations.every((a) => a.installState === 'catalog_committed')).toBe(true);
  });
  it('reserves a new managed workspace before global registration', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-action-journal-'));
    const initial = migrationRun(workspacePath);
    const { workspaceDbId: _unregistered, ...staged } = initial;
    const journal = await reserveBenchlingMigrationAction({
      run: {
        ...staged,
        workspaceOrigin: { kind: 'migration_created' },
        repoUuid: staged.workspaceId,
        projectionScopeId: staged.workspaceId,
      },
      actionId: staged.id,
      sourceObjects: [source()],
      decisions: [],
      now: '2026-08-29T12:00:00.000Z',
      loadPersistentReservations: async () => [],
    });
    expect(journal.workspace).toMatchObject({
      workspaceDbId: null,
      repoUuid: staged.workspaceId,
      projectionScopeId: staged.workspaceId,
    });
    expect(await readBenchlingMigrationActionJournal(workspacePath, staged.id)).toEqual(journal);
    expect(journal.allocations[0].installState).toBe('reserved');
  });

  it('still requires a database binding for adopted workspaces', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-action-journal-'));
    const { workspaceDbId: _missing, ...run } = migrationRun(workspacePath);
    await expect(
      reserveBenchlingMigrationAction({
        run: { ...run, workspaceOrigin: { kind: 'adopted_existing', workspaceDbId: 7 } },
        actionId: run.id,
        sourceObjects: [source()],
        decisions: [],
        now: '2026-08-29T12:00:00.000Z',
        loadPersistentReservations: async () => [],
      })
    ).rejects.toThrow(/authoritative workspace binding/);
  });

  it('parses the complete v1 recovery authority and rejects unsafe owned paths', () => {
    const journal = fixture('/workspace');
    expect(parseBenchlingMigrationActionJournal(journal)).toEqual(journal);
    expect(() =>
      parseBenchlingMigrationActionJournal({
        ...journal,
        allocations: [{ ...journal.allocations[0], actionOwnedPaths: ['../escape'] }],
      })
    ).toThrow(/unsafe/iu);
  });

  it('rejects unrelated safe paths in an otherwise valid write set', () => {
    const journal = fixture('/workspace');
    expect(() =>
      parseBenchlingMigrationActionJournal({
        ...journal,
        allocations: [
          {
            ...journal.allocations[0],
            actionOwnedPaths: [...journal.allocations[0].actionOwnedPaths, 'unrelated-notes.txt'],
          },
        ],
      })
    ).toThrow(/unrelated/iu);
  });

  it('allows an installed retained file without claiming its bytes', () => {
    const journal = fixture('/workspace');
    const allocation = {
      ...journal.allocations[0],
      expectedPriorImportedHash: null,
      actionOwnedPaths: [],
      installState: 'installed',
    };
    expect(
      parseBenchlingMigrationActionJournal({ ...journal, allocations: [allocation] }).allocations[0]
        .actionOwnedPaths
    ).toEqual([]);
  });

  it('writes atomically and recovers a newer complete pending journal', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-action-journal-'));
    const initial = fixture(workspacePath);
    await writeBenchlingMigrationActionJournal(workspacePath, initial);
    expect(await readBenchlingMigrationActionJournal(workspacePath, initial.actionId)).toEqual(
      initial
    );

    const staged = advanceBenchlingMigrationAllocation(
      initial,
      'seq_ABCDEFGH',
      'staged',
      '2026-08-29T12:01:00.000Z'
    );
    const journalPath = join(
      workspacePath,
      benchlingMigrationActionJournalRelativePath(initial.actionId)
    );
    await writeFile(`${journalPath}.pending`, `${JSON.stringify(staged, null, 2)}\n`, 'utf8');

    await expect(
      recoverBenchlingMigrationActionJournal(workspacePath, initial.actionId)
    ).resolves.toEqual(staged);
    expect(JSON.parse(await readFile(journalPath, 'utf8'))).toEqual(staged);
  });

  it('does not let a stale pending write roll back durable state', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-action-journal-'));
    const initial = fixture(workspacePath);
    const staged = advanceBenchlingMigrationAllocation(
      initial,
      'seq_ABCDEFGH',
      'staged',
      '2026-08-29T12:01:00.000Z'
    );
    await writeBenchlingMigrationActionJournal(workspacePath, staged);
    const journalPath = join(
      workspacePath,
      benchlingMigrationActionJournalRelativePath(initial.actionId)
    );
    await writeFile(`${journalPath}.pending`, `${JSON.stringify(initial, null, 2)}\n`, 'utf8');
    await expect(
      readBenchlingMigrationActionJournal(workspacePath, initial.actionId)
    ).resolves.toEqual(staged);
  });

  it('enforces one-way adjacent install transitions and immutable allocations', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-action-journal-'));
    const initial = fixture(workspacePath);
    expect(() =>
      advanceBenchlingMigrationAllocation(
        initial,
        'seq_ABCDEFGH',
        'installed',
        '2026-08-29T12:01:00.000Z'
      )
    ).toThrow(/cannot advance/iu);

    await writeBenchlingMigrationActionJournal(workspacePath, initial);
    await expect(
      writeBenchlingMigrationActionJournal(workspacePath, {
        ...initial,
        allocations: [
          {
            ...initial.allocations[0],
            destination: { kind: 'file', relativePath: 'Elsewhere/changed.gb' },
            actionOwnedPaths: ['Elsewhere/changed.gb'],
          },
        ],
        updatedAt: '2026-08-29T12:01:00.000Z',
      })
    ).rejects.toThrow(/allocation changed/iu);
  });

  it('rejects a journal path whose action ID could escape the action directory', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-action-journal-'));
    await mkdir(join(workspacePath, '.dnaforge/migration/actions'), { recursive: true });
    expect(() => benchlingMigrationActionJournalRelativePath('../escape')).toThrow(/unsafe/iu);
  });

  it('persists a direct provider hierarchy allocation before projection', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-action-journal-'));
    const sourceObject = source();
    const journal = await reserveBenchlingMigrationAction({
      run: migrationRun(workspacePath),
      actionId: 'action-reserve',
      sourceObjects: [sourceObject],
      decisions: [],
      now: '2026-08-29T12:00:00.000Z',
      loadPersistentReservations: async () => [],
    });

    expect(journal.allocations).toHaveLength(1);
    expect(journal.allocations[0]).toMatchObject({
      sourceObjectId: sourceObject.id,
      canonicalMembership: {
        hierarchySegments: ['Selected Root', 'Alpha'],
      },
      destination: {
        kind: 'file',
        relativePath: 'Selected Root/Alpha/Plasmid.gb',
      },
      installState: 'reserved',
    });
    expect(journal.allocations[0]?.actionOwnedPaths.join('/')).not.toContain('Benchling Imports');
    await expect(
      readBenchlingMigrationActionJournal(workspacePath, 'action-reserve')
    ).resolves.toEqual(journal);
  });

  it('allocates against persistent manifest, journal, and catalog reservations', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-action-journal-'));
    const journal = await reserveBenchlingMigrationAction({
      run: migrationRun(workspacePath),
      actionId: 'action-collision',
      sourceObjects: [source()],
      decisions: [],
      now: '2026-08-29T12:00:00.000Z',
      loadPersistentReservations: async () => [
        {
          relativePath: 'Selected Root/Alpha/Plasmid.gb',
          kind: 'file',
          ownerSourceObjectId: 'seq_OTHER',
        },
      ],
    });

    expect(journal.allocations[0]?.destination).toMatchObject({
      kind: 'file',
      relativePath: 'Selected Root/Alpha/Plasmid--seq_ABCDEFGH.gb',
    });
    expect(journal.allocations[0]?.collisionSuffixDecision).toEqual({
      kind: 'stable_id',
      suffix: '--seq_ABCDEFGH',
      ordinal: 1,
    });
  });

  it('requires the worker to consume the exact reserved allocation', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-action-journal-'));
    const sourceObject = source();
    const journal = await reserveBenchlingMigrationAction({
      run: migrationRun(workspacePath),
      actionId: 'action-worker',
      sourceObjects: [sourceObject],
      decisions: [],
      now: '2026-08-29T12:00:00.000Z',
      loadPersistentReservations: async () => [],
    });
    const baseJob = {
      schema: LOCAL_PROJECTION_WORKER_JOB_SCHEMA,
      runId: 'run-1',
      capturedAt: '2026-08-29T12:00:00.000Z',
      converterVersion: '1',
      sourceObjects: [sourceObject],
      resolutions: [],
      allocations: journal.allocations,
    } as const;

    const result = runLocalProjectionWorkerJob(baseJob);
    expect(result.plans[0]?.plan.destination).toEqual({
      kind: 'file',
      relativePath: 'Selected Root/Alpha/Plasmid.gb',
    });
    expect(() => runLocalProjectionWorkerJob({ ...baseJob, allocations: [] })).toThrow(
      /one immutable allocation/iu
    );
  });
});

function migrationRun(workspacePath: string): MigrationRun {
  return {
    version: 1,
    id: 'run-1',
    workspaceId: 'workspace-1',
    workspaceDbId: 42,
    repoUuid: null,
    projectionScopeId: 'workspace-db-42',
    workspaceOrigin: { kind: 'adopted_existing', workspaceDbId: 42 },
    baseline: {
      kind: 'adopted_workspace',
      adoptedAt: '2026-08-29T12:00:00.000Z',
      existingManifestSha256: null,
    },
    workspacePath,
    displayName: 'Existing workspace',
    scope: {
      version: 1,
      kind: 'file',
      acquisition: 'local_bundle',
      source: { id: 'local-export-run-1', url: 'dnaforge-local-export://run-1' },
    },
    binding: null,
    state: 'projecting',
    resumeState: null,
    attempt: 1,
    converterVersions: { projection: '1' },
    createdAt: '2026-08-29T12:00:00.000Z',
    updatedAt: '2026-08-29T12:00:00.000Z',
    startedAt: '2026-08-29T12:00:00.000Z',
    unlockedAt: null,
    lastError: null,
    externalZipSource: {
      schema: 'dnaforge.benchling.external-zip-source.v1',
      sourceId: 'external-zip-aaaaaaaaaaaaaaaaaaaaaaaa',
      originalPath: '/Users/scientist/Benchling export.zip',
      displayName: 'Benchling export.zip',
      zipSha256: DIGEST,
      sizeBytes: 123,
      selectedAt: '2026-08-29T12:00:00.000Z',
    },
  };
}

function source(): SourceObject {
  return {
    id: 'seq_ABCDEFGH',
    stableId: 'seq_ABCDEFGH',
    sourceType: 'dna_sequence',
    name: 'Plasmid',
    aliases: [],
    sourceUrl: 'dnaforge-local-export://run-1/seq_ABCDEFGH',
    sourcePath: 'Selected Root/Alpha/Plasmid.gb',
    attachmentHashes: [],
    memberships: ['fld_ALPHA', 'fld_SECONDARY'],
    metadata: {},
    content: { kind: 'dna_sequence', sequence: 'ATGC', circular: false, annotations: [] },
    relationships: [],
  };
}

function fixture(workspacePath: string): BenchlingMigrationActionJournal {
  return {
    schema: 'dnaforge.benchling.migration-action-journal.v1',
    actionId: 'action-1',
    runId: 'run-1',
    workspace: {
      workspaceDbId: 42,
      repoUuid: null,
      projectionScopeId: 'workspace-db-42',
      workspacePath,
    },
    durability: { kind: 'local_filesystem' },
    externalSource: {
      schema: 'dnaforge.benchling.external-zip-source.v1',
      sourceId: 'external-zip-aaaaaaaaaaaaaaaaaaaaaaaa',
      originalPath: '/Users/scientist/Benchling export.zip',
      displayName: 'Benchling export.zip',
      zipSha256: DIGEST,
      sizeBytes: 123,
      selectedAt: '2026-08-29T12:00:00.000Z',
    },
    decisions: [
      {
        kind: 'provider_version_conflict',
        policy: 'use_incoming',
      },
    ],
    allocations: [
      {
        sourceObjectId: 'seq_ABCDEFGH',
        providerIdentity: {
          provider: 'benchling',
          stableObjectId: 'seq_ABCDEFGH',
          objectClass: 'sequence',
        },
        destinationEntityId: 'migration-sequence-1',
        destination: { kind: 'file', relativePath: 'Selected Root/Plasmid.gb' },
        canonicalMembership: {
          sourceFolderId: 'fld_ABCDEFGH',
          hierarchySegments: ['Selected Root'],
          alternateSourceFolderIds: ['fld_IJKLMNOP'],
        },
        collisionSuffixDecision: { kind: 'none' },
        expectedPriorImportedHash: null,
        actionOwnedPaths: ['Selected Root/Plasmid.gb'],
        rollback: { kind: 'none' },
        installState: 'reserved',
      },
    ],
    createdAt: '2026-08-29T12:00:00.000Z',
    updatedAt: '2026-08-29T12:00:00.000Z',
  };
}
