import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeSequenceForInPlaceSave } from '@waypoint/sequence-utils';
import type { PairwiseSessionAlignmentResult } from '@waypoint/api-client';
import {
  buildSequencePackageDocument,
  parseSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
} from '../db/sequence-package';
import {
  readSequencePackageEvidenceRun,
  readSequencePackageHistoryIndex,
} from '../db/sequence-package-history-io';
import {
  activateSequenceEvidenceRunInMain,
  appendSequenceEvidenceStateInMain,
  completeSequenceEvidenceRunInMain,
  prepareSequenceEvidenceRunInMain,
} from './sequence-package-evidence-publication';
import { publishSequencePackageRevisionInMain } from './sequence-package-revision-publication';

let workspaceRoot = '';
let packageRoot = '';
let productPath = '';
let queryPath = '';

function hash(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'sequence-evidence-'));
  packageRoot = join(workspaceRoot, 'entity');
  const paths = sequencePackagePaths(packageRoot, { productFile: 'entity.gb' });
  productPath = paths.productPath;
  queryPath = join(paths.contentsDir, 'read.fasta');
  await mkdir(paths.metaDir, { recursive: true });
  await mkdir(paths.contentsDir, { recursive: true });
  await writeFile(
    productPath,
    serializeSequenceForInPlaceSave(
      {
        id: 'entity-id',
        name: 'entity',
        sequence: 'AACC',
        length: 4,
        circular: false,
        annotations: [],
      },
      productPath
    )
  );
  await writeFile(queryPath, '>read\nAACC\n');
  await writeFile(
    paths.metaPath,
    serializeSequencePackageDocument(
      buildSequencePackageDocument({
        id: 'entity-id',
        name: 'entity',
        product: { file: 'entity.gb', topology: 'linear' },
      })
    )
  );
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function request(runId = 'run-one') {
  return {
    workspaceRoot,
    packageRoot,
    packageId: 'entity-id',
    sourcePath: productPath,
    sessionId: 'session-one',
    session: {
      name: 'First review',
      mode: 'one-per-clone' as const,
      createdAt: '2026-01-01T00:00:00Z',
    },
    runId,
    queries: [{ id: 'query-one', label: 'read', path: queryPath }],
  };
}

function result(referenceRevision: string): PairwiseSessionAlignmentResult {
  return {
    inputRevision: `pairwise-session-alignment-v1:sha256:${'a'.repeat(64)}`,
    referenceRevision,
    results: [
      {
        queryId: 'query-one',
        queryRevision: `pairwise-query-v1:${hash(JSON.stringify('AACC'))}`,
        alignment: {
          aligned_query: 'AACC',
          aligned_reference: 'AACC',
          identity: 100,
          mutations: [],
          alignment_length: 4,
          gaps: 0,
          matches: 4,
          mismatches: 0,
          query_length: 4,
          reference_length: 4,
        },
      },
    ],
  };
}

describe('package-owned immutable sequence evidence', () => {
  it('applies a completed run after a GenBank-only label edit, but not after a base edit', async () => {
    const prepared = await prepareSequenceEvidenceRunInMain(request());
    const output = result(prepared.run.reference.sequenceRevision);
    await completeSequenceEvidenceRunInMain({
      ...request(),
      managedOperationId: 'managed-one',
      inputRevision: output.inputRevision,
      result: output,
    });
    const markerPath = sequencePackagePaths(packageRoot).metaPath;
    const markerContent = await readFile(markerPath, 'utf8');
    const current = parseSequencePackageDocument(markerContent);
    const content = (name: string, sequence: string) =>
      serializeSequenceForInPlaceSave(
        {
          id: 'entity-id',
          name,
          sequence,
          length: sequence.length,
          circular: false,
          annotations: [],
        },
        productPath
      );
    const renamed = content('renamed', 'AACC');
    await writeFile(productPath, renamed);
    const nextProductContent = content('renamed', 'AATC');
    await publishSequencePackageRevisionInMain({
      workspaceRoot,
      packageRoot,
      packageId: current.id,
      nextDocument: current,
      nextProductContent,
      kind: 'sequencing-apply',
      evidenceRunId: 'run-one',
      operationId: 'apply-renamed-reference',
      revisionId: 'apply-renamed-reference',
      adoptedRevisionId: 'adopted-before-apply',
      expectedMarkerSha256: hash(markerContent),
      expectedProductSha256: hash(renamed),
    });
    expect(await readFile(productPath, 'utf8')).toBe(nextProductContent);

    const other = parseSequencePackageDocument(await readFile(markerPath, 'utf8'));
    const changedBases = content('renamed', 'AAGC');
    await writeFile(productPath, changedBases);
    await expect(
      publishSequencePackageRevisionInMain({
        workspaceRoot,
        packageRoot,
        packageId: other.id,
        nextDocument: other,
        nextProductContent: content('renamed', 'AAGG'),
        kind: 'sequencing-apply',
        evidenceRunId: 'run-one',
        operationId: 'apply-wrong-reference',
        revisionId: 'apply-wrong-reference',
        expectedMarkerSha256: hash(await readFile(markerPath, 'utf8')),
        expectedProductSha256: hash(changedBases),
      })
    ).rejects.toThrow('exact current reference');
  });

  it('freezes reference and query bytes before a run and retains a result across package copy', async () => {
    const prepared = await prepareSequenceEvidenceRunInMain(request());
    expect(prepared.referenceReadPath).toContain('/contents/evidence/run-one/reference.gb');
    expect(prepared.run.producer).toEqual({
      kind: 'pairwise-session-alignment',
      algorithm: 'auto',
      threads: 4,
      timeoutSeconds: 300,
      isCircular: false,
    });
    const activated = await activateSequenceEvidenceRunInMain({
      ...request(),
      managedOperationId: 'managed-one',
      inputRevision: result(prepared.run.reference.sequenceRevision).inputRevision,
    });
    expect(activated.managedOperationId).toBe('managed-one');
    expect(activated.session?.name).toBe('First review');
    expect(await readFile(prepared.queryPaths['query-one'], 'utf8')).toBe('>read\nAACC\n');
    const completed = await completeSequenceEvidenceRunInMain({
      ...request(),
      managedOperationId: 'managed-one',
      inputRevision: result(prepared.run.reference.sequenceRevision).inputRevision,
      result: result(prepared.run.reference.sequenceRevision),
    });
    expect(completed.run.status).toBe('completed');
    const sameRetry = await completeSequenceEvidenceRunInMain({
      ...request(),
      managedOperationId: 'managed-one',
      inputRevision: result(prepared.run.reference.sequenceRevision).inputRevision,
      result: result(prepared.run.reference.sequenceRevision),
    });
    expect(sameRetry.run.result).toEqual(completed.run.result);
    const copiedRoot = join(workspaceRoot, 'copied');
    await cp(packageRoot, copiedRoot, { recursive: true });
    const copied = parseSequencePackageDocument(
      await readFile(sequencePackagePaths(copiedRoot).metaPath, 'utf8')
    );
    expect(copied.evidenceRuns?.[0].result).toEqual(completed.run.result);
    expect(await readFile(join(copiedRoot, completed.run.result!.path), 'utf8')).toContain(
      'referenceRevision'
    );
    expect(copied.members.filter((member) => member.role.startsWith('evidence-'))).toHaveLength(3);
  });

  it('freezes a read kept elsewhere in the project, such as another package', async () => {
    const elsewhere = join(workspaceRoot, 'clone', 'clone.gb');
    await mkdir(join(workspaceRoot, 'clone'), { recursive: true });
    await writeFile(elsewhere, '>clone\nAACC\n');

    const prepared = await prepareSequenceEvidenceRunInMain({
      ...request(),
      queries: [{ id: 'query-one', label: 'clone', path: elsewhere }],
    });

    expect(await readFile(prepared.queryPaths['query-one'], 'utf8')).toBe('>clone\nAACC\n');
    expect(await readFile(elsewhere, 'utf8')).toBe('>clone\nAACC\n');
  });

  it('refuses a read outside the project', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'sequence-evidence-outside-'));
    try {
      const stray = join(outside, 'read.fasta');
      await writeFile(stray, '>read\nAACC\n');
      await expect(
        prepareSequenceEvidenceRunInMain({
          ...request(),
          queries: [{ id: 'query-one', label: 'read', path: stray }],
        })
      ).rejects.toThrow(/inside the owning workspace/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('does not relabel a changed mutable query or overwrite a completed result', async () => {
    const prepared = await prepareSequenceEvidenceRunInMain(request());
    await writeFile(queryPath, '>read\nTTTT\n');
    const output = result(prepared.run.reference.sequenceRevision);
    await completeSequenceEvidenceRunInMain({
      ...request(),
      managedOperationId: 'managed-one',
      inputRevision: output.inputRevision,
      result: output,
    });
    const changed = {
      ...output,
      inputRevision: `pairwise-session-alignment-v1:sha256:${'b'.repeat(64)}`,
    };
    await expect(
      completeSequenceEvidenceRunInMain({
        ...request(),
        managedOperationId: 'managed-one',
        inputRevision: changed.inputRevision,
        result: changed,
      })
    ).rejects.toThrow(/different operation/);
    expect(await readFile(prepared.queryPaths['query-one'], 'utf8')).toBe('>read\nAACC\n');
  });

  it('retains append-only interpretation and review states in the copied package', async () => {
    const prepared = await prepareSequenceEvidenceRunInMain(request());
    const output = result(prepared.run.reference.sequenceRevision);
    await completeSequenceEvidenceRunInMain({
      ...request(),
      managedOperationId: 'managed-one',
      inputRevision: output.inputRevision,
      result: output,
    });
    const track = {
      queryId: 'query-one',
      label: 'read',
      alignment: {
        alignedReference: 'AACC',
        alignedQuery: 'AACC',
        identity: 100,
        coverageStart: 1,
        coverageEnd: 4,
        algorithm: 'MAFFT',
      },
      mutations: [],
      status: 'pass' as const,
      alignedAt: '2026-01-01T00:00:00Z',
    };
    const base = {
      workspaceRoot,
      packageRoot,
      packageId: 'entity-id',
      runId: 'run-one',
      classifier: 'mutation-impact-v1' as const,
    };
    const first = await appendSequenceEvidenceStateInMain({
      ...base,
      stateId: 'review-one',
      tracks: [track],
    });
    expect(first.states).toHaveLength(1);
    const duplicate = await appendSequenceEvidenceStateInMain({
      ...base,
      stateId: 'different-id',
      tracks: [track],
    });
    expect(duplicate.states).toHaveLength(1);
    const second = await appendSequenceEvidenceStateInMain({
      ...base,
      stateId: 'review-two',
      session: {
        name: 'Renamed review',
        mode: 'one-per-clone',
        createdAt: '2026-01-01T00:00:00Z',
        archived: true,
      },
      tracks: [{ ...track, userStatus: 'variants', userOverrideReason: 'manual review' }],
    });
    expect(second.states).toHaveLength(2);
    const copiedRoot = join(workspaceRoot, 'review-copy');
    await cp(packageRoot, copiedRoot, { recursive: true });
    const copied = parseSequencePackageDocument(
      await readFile(sequencePackagePaths(copiedRoot).metaPath, 'utf8')
    );
    const copiedRun = copied.evidenceRuns?.[0];
    expect(copiedRun?.states).toHaveLength(2);
    expect(
      JSON.parse(await readFile(join(copiedRoot, copiedRun!.states![0].artifact.path), 'utf8'))
        .tracks[0].userStatus
    ).toBeUndefined();
    expect(
      JSON.parse(await readFile(join(copiedRoot, copiedRun!.states![1].artifact.path), 'utf8'))
        .tracks[0].userStatus
    ).toBe('variants');
    expect(
      JSON.parse(await readFile(join(copiedRoot, copiedRun!.states![1].artifact.path), 'utf8'))
        .session
    ).toMatchObject({
      name: 'Renamed review',
      archived: true,
    });
    const copiedFs = {
      exists: async (path: string) =>
        readFile(path).then(
          () => true,
          () => false
        ),
      readTextFile: (path: string) => readFile(path, 'utf8'),
      readFile: (path: string) => readFile(path),
      validateWorkspacePath: async ({ path }: { path: string }) =>
        path.startsWith(`${workspaceRoot}/`),
    };
    const index = await readSequencePackageHistoryIndex({
      packageRoot: copiedRoot,
      workspaceRoot,
      expectedPackageId: 'entity-id',
      fs: copiedFs,
    });
    expect(
      await readSequencePackageEvidenceRun({
        index,
        runId: 'run-one',
        workspaceRoot,
        fs: copiedFs,
      })
    ).toMatchObject({ status: 'available', states: [{}, {}] });
    await writeFile(join(copiedRoot, copiedRun!.states![0].artifact.path), 'tampered');
    expect(
      await readSequencePackageEvidenceRun({
        index,
        runId: 'run-one',
        workspaceRoot,
        fs: copiedFs,
      })
    ).toMatchObject({ status: 'unavailable' });
    await expect(
      appendSequenceEvidenceStateInMain({
        ...base,
        stateId: 'review-one',
        tracks: [{ ...track, userStatus: 'fail' }],
      })
    ).rejects.toThrow(/different content/);
  });
});

import type Database from 'better-sqlite3';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
vi.mock('./ipc/database', () => ({ getDb: () => registryPublicationDb }));
let registryPublicationDb: Database.Database;
beforeEach(() => {
  registryPublicationDb = createTestDb();
  ensureSchema(registryPublicationDb, ':memory:');
});
afterEach(() => {
  registryPublicationDb.close();
});
