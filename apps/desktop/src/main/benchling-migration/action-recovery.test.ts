import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

import type { ProjectionReceipt, SourceObject } from '../../shared/benchling-migration';
import type {
  BenchlingMigrationActionJournal,
  BenchlingMigrationInstallState,
} from '../../shared/benchling-migration-action-journal';
import { NATIVE_WORKSPACE_MANIFEST_PATH } from '../../shared/native-workspace-manifest';
import {
  commitAllIfDirty,
  initManagedRepo,
  readBlobOidAtHead,
  resolveHeadCommit,
} from '../workspace-git';
import {
  advancePersistedBenchlingMigrationAllocation,
  writeBenchlingMigrationActionJournal,
} from './action-journal';
import * as actionJournal from './action-journal';
import {
  BenchlingMigrationActionRecoveryError,
  recoverBenchlingMigrationAction,
} from './action-recovery';
import { buildProjectionPlan } from './projection';
import { writeProjectionPlan } from './projection-writer';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { publishActionLimsExport } from './generated-lims-publication';
import { fingerprintExistingDestination } from './destination-name-allocator';

describe('Benchling migration action recovery', () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-action-recovery-'));
  });

  afterEach(async () => {
    actionJournal.setMigrationJournalObserverForTest(undefined);
    vi.restoreAllMocks();
    await rm(workspacePath, { recursive: true, force: true });
  });

  it.each(['reserved', 'staged'] as const)(
    'discards only hidden staging bytes and asks the %s action to resume',
    async (state) => {
      const { journal } = await installedFixture(workspacePath, state, false);
      const visible = join(workspacePath, 'Selected Root', 'keep.txt');
      const temporary = join(
        workspacePath,
        'Selected Root',
        '.Plasmid.gb.123.dnaforge-migration.tmp'
      );
      await mkdir(dirname(visible), { recursive: true });
      await writeFile(visible, 'keep');
      await writeFile(temporary, 'temporary');

      const result = await recoverBenchlingMigrationAction(
        workspacePath,
        journal.actionId,
        dependencies([])
      );

      expect(result.kind).toBe('resume_required');
      await expect(readFile(visible, 'utf8')).resolves.toBe('keep');
      await expect(readFile(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it.each([
    ['installed', ['catalog', 'manifest', 'verify']],
    ['catalog_committed', ['manifest', 'verify']],
    ['manifest_committed', ['verify']],
  ] as const)('resumes deterministically from %s', async (state, expectedCalls) => {
    const { journal, receipt } = await installedFixture(workspacePath, state, true);
    const calls: string[] = [];

    const result = await recoverBenchlingMigrationAction(
      workspacePath,
      journal.actionId,
      dependencies([receipt], calls)
    );

    expect(result.kind).toBe('complete');
    expect(result.journal.allocations[0]?.installState).toBe('complete');
    expect(calls).toEqual(expectedCalls);
  });

  it('treats a completed retry as a no-op without requiring the external ZIP', async () => {
    const { journal, receipt } = await installedFixture(workspacePath, 'complete', true);
    const verifySource = vi.fn(() => Promise.reject(new Error('source removed')));

    const result = await recoverBenchlingMigrationAction(workspacePath, journal.actionId, {
      ...dependencies([receipt]),
      verifyExternalSource: verifySource,
    });

    expect(result.kind).toBe('complete');
    expect(verifySource).not.toHaveBeenCalled();
  });

  it('finalizes an empty managed-Git action before treating retries as complete', async () => {
    await initManagedRepo(workspacePath);
    await writeFile(join(workspacePath, 'keep.txt'), 'Unrelated data');
    await commitAllIfDirty(workspacePath, 'Fixture baseline');
    const head = await resolveHeadCommit(workspacePath);
    if (!head) throw new Error('Expected fixture HEAD.');
    const { journal } = await installedFixture(workspacePath, 'installed', true, head);
    await writeBenchlingMigrationActionJournal(workspacePath, { ...journal, allocations: [] });
    const calls: string[] = [];
    const first = await recoverBenchlingMigrationAction(
      workspacePath,
      journal.actionId,
      dependencies([], calls)
    );
    expect(first.kind).toBe('complete');
    expect(calls).toEqual(['catalog', 'manifest', 'verify']);
    expect(first.journal.durability).toMatchObject({
      kind: 'managed_git',
      committedHead: expect.any(String),
    });
    const retryCalls: string[] = [];
    await recoverBenchlingMigrationAction(workspacePath, journal.actionId, {
      ...dependencies([], retryCalls),
      verifyExternalSource: async () => {
        throw new Error('Source unavailable after completion');
      },
    });
    expect(retryCalls).toEqual([]);
  });

  it('records each action-wide finalization stage once, regardless of allocation count', async () => {
    const { journal, receipt } = await installedFixture(workspacePath, 'installed', true);
    const allocations = [...journal.allocations];
    const baseAllocation = journal.allocations[0];
    if (baseAllocation.providerIdentity === null) throw new Error('Expected provider fixture.');
    const receipts = [receipt];
    for (let index = 1; index < 16; index++) {
      const source = {
        ...nativeSequence(),
        id: `seq_RECOVERY${index}`,
        stableId: `seq_RECOVERY${index}`,
      };
      const destination = {
        kind: 'file',
        relativePath: `Selected Root/Plasmid${index}.gb`,
      } as const;
      const plan = buildProjectionPlan(source, {
        runId: journal.actionId,
        capturedAt: journal.createdAt,
        converterVersion: 'test',
        destination,
      });
      const installed = await writeProjectionPlan({
        workspacePath,
        runId: journal.actionId,
        sourceObjectId: source.id,
        plan,
        createdAt: journal.createdAt,
      });
      receipts.push(installed);
      allocations.push({
        ...baseAllocation,
        sourceObjectId: source.id,
        providerIdentity: {
          provider: 'benchling',
          stableObjectId: source.stableId,
          objectClass: 'sequence',
        },
        destinationEntityId: installed.destinationObjectId,
        destination,
        actionOwnedPaths: [destination.relativePath],
      });
    }
    await writeBenchlingMigrationActionJournal(workspacePath, { ...journal, allocations });
    const checkpoints: BenchlingMigrationActionJournal[] = [];
    actionJournal.setMigrationJournalObserverForTest(async (_root, written) => {
      checkpoints.push(written);
    });

    const result = await recoverBenchlingMigrationAction(
      workspacePath,
      journal.actionId,
      dependencies(receipts)
    );

    expect(result.kind).toBe('complete');
    expect(
      checkpoints.map((checkpoint) => [
        ...new Set(checkpoint.allocations.map((a) => a.installState)),
      ])
    ).toEqual([['catalog_committed'], ['manifest_committed'], ['complete']]);
    expect(result.journal.allocations).toHaveLength(16);
  });

  it('commits an empty non-Git action without Undo capture and does not repeat it', async () => {
    const { journal: base } = await installedFixture(workspacePath, 'installed', false);
    const journal = { ...base, allocations: [] };
    await writeBenchlingMigrationActionJournal(workspacePath, journal);
    await expect(assertWorkspaceMigrationActionsSettled(workspacePath)).rejects.toThrow(
      'incomplete'
    );
    const calls: string[] = [];
    const result = await recoverBenchlingMigrationAction(
      workspacePath,
      journal.actionId,
      dependencies([], calls)
    );
    expect(result.kind).toBe('complete');
    expect(result.journal).toHaveProperty('completedAt');
    await expect(assertWorkspaceMigrationActionsSettled(workspacePath)).resolves.toBeUndefined();
    expect(calls).toEqual(['catalog', 'manifest', 'verify']);
    const replayCalls: string[] = [];
    await recoverBenchlingMigrationAction(
      workspacePath,
      journal.actionId,
      dependencies([], replayCalls)
    );
    expect(replayCalls).toEqual([]);
  });

  it('marks a failed journal write after catalog commit as unsafe to roll back', async () => {
    const { journal, receipt } = await installedFixture(workspacePath, 'installed', true);
    const calls: string[] = [];
    vi.spyOn(actionJournal, 'advancePersistedBenchlingMigrationAllocations').mockRejectedValueOnce(
      new Error('journal write interrupted')
    );
    await expect(
      recoverBenchlingMigrationAction(
        workspacePath,
        journal.actionId,
        dependencies([receipt], calls)
      )
    ).rejects.toMatchObject({ code: 'catalog_commit_uncertain' });
    expect(calls).toEqual(['catalog']);
  });

  it('treats a completed managed action as history after later workspace commits', async () => {
    await initManagedRepo(workspacePath);
    await writeFile(join(workspacePath, 'seed.txt'), 'seed\n');
    const preActionHead = await commitAllIfDirty(workspacePath, 'seed');
    const { journal, receipt } = await installedFixture(
      workspacePath,
      'installed',
      true,
      preActionHead ?? undefined
    );
    const completed = await recoverBenchlingMigrationAction(
      workspacePath,
      journal.actionId,
      dependencies([receipt])
    );
    expect(completed.kind).toBe('complete');

    await writeFile(join(workspacePath, 'later.txt'), 'later workspace change\n');
    const laterHead = await commitAllIfDirty(workspacePath, 'later workspace change');
    expect(laterHead).not.toBe(
      completed.journal.durability.kind === 'managed_git'
        ? completed.journal.durability.committedHead
        : null
    );

    const verifySource = vi.fn(() => Promise.reject(new Error('source removed')));
    const retry = await recoverBenchlingMigrationAction(workspacePath, journal.actionId, {
      ...dependencies([receipt]),
      verifyExternalSource: verifySource,
    });

    expect(retry.kind).toBe('complete');
    expect(verifySource).not.toHaveBeenCalled();
    expect(await resolveHeadCommit(workspacePath)).toBe(laterHead);
  });

  it('fails closed when the external source disappears before completion', async () => {
    const { journal, receipt } = await installedFixture(workspacePath, 'installed', true);

    await expect(
      recoverBenchlingMigrationAction(workspacePath, journal.actionId, {
        ...dependencies([receipt]),
        verifyExternalSource: () => Promise.reject(new Error('ENOENT')),
      })
    ).rejects.toMatchObject({
      code: 'source_integrity',
    });
  });

  it('preserves a same-path user edit and reports recovery_incomplete', async () => {
    const { journal, receipt } = await installedFixture(workspacePath, 'installed', true);
    const destination = join(workspacePath, 'Selected Root', 'Plasmid.gb');
    await writeFile(destination, 'user changed these bytes after installation');

    await expect(
      recoverBenchlingMigrationAction(workspacePath, journal.actionId, dependencies([receipt]))
    ).rejects.toMatchObject({
      code: 'recovery_incomplete',
    });
    await expect(readFile(destination, 'utf8')).resolves.toBe(
      'user changed these bytes after installation'
    );
  });

  it('publishes only owned paths and preserves unrelated staged and unstaged edits', async () => {
    await initManagedRepo(workspacePath);
    await writeFile(join(workspacePath, 'staged.txt'), 'staged v1\n');
    await writeFile(join(workspacePath, 'unstaged.txt'), 'unstaged v1\n');
    const preActionHead = await commitAllIfDirty(workspacePath, 'seed');
    const { journal, receipt } = await installedFixture(
      workspacePath,
      'installed',
      true,
      preActionHead ?? undefined
    );
    const stagedHeadBlob = await readBlobOidAtHead(workspacePath, 'staged.txt');
    const unstagedHeadBlob = await readBlobOidAtHead(workspacePath, 'unstaged.txt');
    await writeFile(join(workspacePath, 'staged.txt'), 'staged version two\n');
    await git.add({ fs, dir: workspacePath, filepath: 'staged.txt' });
    await writeFile(join(workspacePath, 'unstaged.txt'), 'unstaged version two\n');
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    db.prepare(
      `INSERT INTO workspaces (id,name,path,repo_uuid,created_at,last_opened_at) VALUES (1,'Test',?,NULL,0,0)`
    ).run(workspacePath);
    await publishActionLimsExport({
      db,
      workspacePath,
      workspaceDbId: 1,
      actionId: journal.actionId,
    });
    db.close();

    const result = await recoverBenchlingMigrationAction(workspacePath, journal.actionId, {
      ...dependencies([receipt]),
      mergeManifest: async () => {
        await mkdir(dirname(join(workspacePath, NATIVE_WORKSPACE_MANIFEST_PATH)), {
          recursive: true,
        });
        await writeFile(join(workspacePath, NATIVE_WORKSPACE_MANIFEST_PATH), '{"schema":"test"}\n');
      },
    });

    expect(result.kind).toBe('complete');
    expect(await resolveHeadCommit(workspacePath)).not.toBe(preActionHead);
    expect(await readBlobOidAtHead(workspacePath, 'staged.txt')).toBe(stagedHeadBlob);
    expect(await readBlobOidAtHead(workspacePath, 'unstaged.txt')).toBe(unstagedHeadBlob);
    expect(await readBlobOidAtHead(workspacePath, '.waypoint/lims/manifest.json')).not.toBeNull();
    expect(
      await readBlobOidAtHead(workspacePath, '.waypoint/lims/sheets/oligos.csv')
    ).not.toBeNull();
    const matrix = Object.fromEntries(
      (await git.statusMatrix({ fs, dir: workspacePath })).map(([path, head, workdir, stage]) => [
        path,
        { head, workdir, stage },
      ])
    );
    expect(matrix['staged.txt']).toEqual({ head: 1, workdir: 2, stage: 2 });
    expect(matrix['unstaged.txt']).toEqual({ head: 1, workdir: 2, stage: 1 });
  });

  it('refuses an unrelated new file under a displaced parent before catalog or Git publication', async () => {
    const { journal, receipt } = await installedFixture(workspacePath, 'installed', true);
    const backupRelativePath = '.dnaforge/migration/rollback/displacement/parent';
    await mkdir(dirname(join(workspacePath, backupRelativePath)), { recursive: true });
    await writeFile(join(workspacePath, backupRelativePath), 'original parent file');
    const expectedExistingState = await fingerprintExistingDestination(
      workspacePath,
      backupRelativePath
    );
    if (!expectedExistingState) throw new Error('Missing fixture preimage.');
    await writeBenchlingMigrationActionJournal(workspacePath, {
      ...journal,
      actionId: 'displacement',
      allocations: journal.allocations.map((allocation) => ({
        ...allocation,
        rollback: {
          kind: 'displaced',
          targetRelativePath: 'Selected Root',
          backupRelativePath,
          expectedExistingState,
        },
        actionOwnedPaths: [...allocation.actionOwnedPaths, backupRelativePath],
      })),
    });
    const unrelated = join(workspacePath, 'Selected Root/user-note.txt');
    await writeFile(unrelated, 'concurrent local note');
    const calls: string[] = [];
    await expect(
      recoverBenchlingMigrationAction(workspacePath, 'displacement', dependencies([receipt], calls))
    ).rejects.toMatchObject({ code: 'destination_integrity' });
    expect(calls).toEqual([]);
    await expect(readFile(unrelated, 'utf8')).resolves.toBe('concurrent local note');
  });
});

function dependencies(receipts: readonly ProjectionReceipt[], calls: string[] = []) {
  return {
    receipts,
    assertMutationLeaseHeld: () => undefined,
    verifyExternalSource: () => Promise.resolve('/fixture/export.zip'),
    completeCatalog: () => {
      calls.push('catalog');
    },
    mergeManifest: () => {
      calls.push('manifest');
    },
    verifyCatalogManifestAgreement: () => {
      calls.push('verify');
    },
    now: () => '2026-08-29T12:30:00.000Z',
  };
}

async function installedFixture(
  root: string,
  state: BenchlingMigrationInstallState,
  installDestination: boolean,
  preActionHead?: string
): Promise<{ journal: BenchlingMigrationActionJournal; receipt: ProjectionReceipt }> {
  const source = nativeSequence();
  const destination = { kind: 'file', relativePath: 'Selected Root/Plasmid.gb' } as const;
  const plan = buildProjectionPlan(source, {
    runId: 'action-recovery',
    capturedAt: '2026-08-29T12:00:00.000Z',
    converterVersion: 'test',
    destination,
  });
  let receipt: ProjectionReceipt = {
    id: 'receipt-placeholder',
    runId: 'action-recovery',
    sourceObjectId: source.id,
    destinationObjectId: 'placeholder',
    destinationPath: destination.relativePath,
    destination,
    projection: 'native',
    converterId: 'test',
    converterVersion: 'test',
    sourceHash: '0'.repeat(64),
    destinationHash: '0'.repeat(64),
    warnings: [],
    exception: null,
    createdAt: '2026-08-29T12:00:00.000Z',
  } satisfies ProjectionReceipt;
  if (installDestination) {
    receipt = await writeProjectionPlan({
      workspacePath: root,
      runId: 'action-recovery',
      sourceObjectId: source.id,
      plan,
      createdAt: '2026-08-29T12:00:00.000Z',
    });
  }
  const journal: BenchlingMigrationActionJournal = {
    schema: 'dnaforge.benchling.migration-action-journal.v1',
    actionId: 'action-recovery',
    runId: 'run-recovery',
    workspace: {
      workspaceDbId: 42,
      repoUuid: preActionHead ? 'repo-recovery' : null,
      projectionScopeId: 'workspace-db-42',
      workspacePath: root,
    },
    durability: preActionHead
      ? {
          kind: 'managed_git',
          preActionHead,
          committedHead: state === 'complete' ? preActionHead : null,
        }
      : { kind: 'local_filesystem' },
    externalSource: {
      schema: 'dnaforge.benchling.external-zip-source.v1',
      sourceId: 'external-zip-aaaaaaaaaaaaaaaaaaaaaaaa',
      originalPath: '/fixture/export.zip',
      displayName: 'export.zip',
      zipSha256: `sha256:${'a'.repeat(64)}`,
      sizeBytes: 123,
      selectedAt: '2026-08-29T12:00:00.000Z',
    },
    decisions: [],
    allocations: [
      {
        sourceObjectId: source.id,
        providerIdentity: {
          provider: 'benchling',
          stableObjectId: source.stableId,
          objectClass: 'sequence',
        },
        destinationEntityId: receipt.destinationObjectId,
        destination,
        canonicalMembership: {
          sourceFolderId: 'fld_ROOT',
          hierarchySegments: ['Selected Root'],
          alternateSourceFolderIds: [],
        },
        collisionSuffixDecision: { kind: 'none' },
        expectedPriorImportedHash: null,
        actionOwnedPaths: [destination.relativePath],
        rollback: { kind: 'none' },
        installState: state,
      },
    ],
    createdAt: '2026-08-29T12:00:00.000Z',
    updatedAt: '2026-08-29T12:00:00.000Z',
  };
  await writeBenchlingMigrationActionJournal(root, journal);
  return { journal, receipt };
}

function nativeSequence(): SourceObject {
  return {
    id: 'seq_RECOVERY',
    stableId: 'seq_RECOVERY',
    sourceType: 'dna_sequence',
    name: 'Plasmid',
    aliases: [],
    sourceUrl: 'dnaforge-local-export://run/seq_RECOVERY',
    sourcePath: 'Selected Root/Plasmid.gb',
    attachmentHashes: [],
    memberships: ['fld_ROOT'],
    metadata: {},
    content: { kind: 'dna_sequence', sequence: 'ATGC', circular: false, annotations: [] },
    relationships: [],
  };
}
import { assertWorkspaceMigrationActionsSettled } from '../workspace-migration-admission';
