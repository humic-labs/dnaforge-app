import { describe, expect, it } from 'vitest';

import { exportCanonicalClosure, importCanonicalRecords } from './codec-public';
import {
  applyWorkspaceMutation,
  captureRecoveryCandidate,
  createRevisionGraph,
  defineBlob,
  defineResourceState,
  listWorkspaceResources,
  parseOperationId,
  parseRefName,
  parseResourceId,
  parseWorkspaceId,
  parseWorkspacePath,
  type Result,
} from './index';

const MAIN_REF = must(parseRefName('main'));

describe('recovery candidate isolation', () => {
  it('captures invalid working bytes without advancing an accepted ref', () => {
    const graph = emptyRecoveryGraph();
    const operationId = must(parseOperationId('recovery-invalid-bytes'));
    const input = {
      graph,
      operationId,
      candidate: {
        kind: 'invalid-working-state' as const,
        workspaceId: must(parseWorkspaceId('workspace-recovery')),
        claimedResourceId: null,
        baseRevisionId: null,
        observedPath: must(parseWorkspacePath('incoming/broken.bin')),
        payloads: [
          {
            role: 'observed-bytes' as const,
            mediaType: 'application/octet-stream',
            blob: defineBlob(new Uint8Array([0xff, 0x00, 0xfe])),
          },
        ] as const,
        failure: { kind: 'parse-failed' as const, code: 'INVALID_BINARY_FORMAT' },
        expiresAtEpochMs: 2_000_000_000_000,
      },
    };

    const captured = captureRecoveryCandidate(input);
    expect(captured.kind).toBe('captured');
    if (captured.kind !== 'captured') throw new Error('Expected recovery capture.');
    expect(captured.candidate).toMatchObject({
      workspaceId: 'workspace-recovery',
      operationId,
      status: 'invalid',
    });
    expect(captured.recordWrites.map((write) => write.kind).sort()).toEqual([
      'operation-receipt',
      'recovery-candidate',
    ]);
    expect(exportCanonicalClosure(captured.graph).refs).toEqual([{ name: 'main', head: null }]);

    const imported = must(importCanonicalRecords(exportCanonicalClosure(captured.graph)));
    const replay = captureRecoveryCandidate({ ...input, graph: imported });
    expect(replay.kind).toBe('replay');
    if (replay.kind !== 'replay') throw new Error('Expected imported recovery replay.');
    expect(replay.original).toEqual({
      operationId,
      outcome: 'recovery-candidate',
      candidate: captured.candidate,
      recordWrites: captured.recordWrites,
    });
  });

  it('hashes explicit expiry into the candidate identity', () => {
    const common = {
      kind: 'invalid-working-state' as const,
      workspaceId: must(parseWorkspaceId('workspace-recovery')),
      claimedResourceId: null,
      baseRevisionId: null,
      observedPath: must(parseWorkspacePath('incoming/expiry.bin')),
      payloads: [
        {
          role: 'observed-bytes' as const,
          mediaType: 'application/octet-stream',
          blob: defineBlob(new Uint8Array([1, 2, 3])),
        },
      ] as const,
      failure: { kind: 'parse-failed' as const, code: 'UNSUPPORTED_FORMAT' },
    };
    const first = captureRecoveryCandidate({
      graph: emptyRecoveryGraph(),
      operationId: must(parseOperationId('recovery-expiry')),
      candidate: { ...common, expiresAtEpochMs: 2_000_000_000_000 },
    });
    const second = captureRecoveryCandidate({
      graph: emptyRecoveryGraph(),
      operationId: must(parseOperationId('recovery-expiry')),
      candidate: { ...common, expiresAtEpochMs: 2_000_000_000_001 },
    });
    if (first.kind !== 'captured' || second.kind !== 'captured') {
      throw new Error('Expected both expiry candidates to be captured.');
    }
    expect(first.candidate.id).not.toBe(second.candidate.id);
  });

  it('normalizes caller-only recovery fields before hashing and round-trips them', () => {
    const blob = { ...defineBlob(new Uint8Array([4, 5, 6])), callerTrace: 'ignored' };
    const payload = {
      role: 'observed-bytes' as const,
      mediaType: 'application/octet-stream',
      blob,
      callerTrace: 'ignored',
    };
    const failure = {
      kind: 'parse-failed' as const,
      code: 'EXTRA_FIELDS',
      callerTrace: 'ignored',
    };
    const captured = captureRecoveryCandidate({
      graph: emptyRecoveryGraph(),
      operationId: must(parseOperationId('recovery-normalized-fields')),
      candidate: {
        kind: 'invalid-working-state',
        workspaceId: must(parseWorkspaceId('workspace-recovery')),
        claimedResourceId: null,
        baseRevisionId: null,
        observedPath: must(parseWorkspacePath('incoming/extra.bin')),
        payloads: [payload],
        failure,
        expiresAtEpochMs: 2_000_000_000_000,
      },
    });
    if (captured.kind !== 'captured') throw new Error('Expected normalized recovery capture.');
    expect(importCanonicalRecords(exportCanonicalClosure(captured.graph)).ok).toBe(true);
  });

  it('captures divergent valid work while leaving the accepted version unchanged', () => {
    const acceptedGraph = createRevisionGraph({
      workspaceId: must(parseWorkspaceId('workspace-recovery')),
      acceptedRef: MAIN_REF,
    });
    const state = must(
      defineResourceState({
        layout: 'file',
        resourceKind: 'text.note',
        mediaType: 'text/plain',
        blob: defineBlob(new TextEncoder().encode('base')),
      })
    );
    const accepted = applyWorkspaceMutation({
      graph: acceptedGraph,
      refName: MAIN_REF,
      expectedHead: null,
      operationId: must(parseOperationId('recovery-divergence-base')),
      mutation: {
        kind: 'create-resource',
        resourceId: must(parseResourceId('recovery-resource')),
        path: must(parseWorkspacePath('notes/base.txt')),
        state,
        origin: { kind: 'created' },
      },
    });
    if (accepted.kind !== 'changed') throw new Error('Expected accepted base.');
    const candidate = applyWorkspaceMutation({
      graph: accepted.graph,
      refName: MAIN_REF,
      expectedHead: accepted.version.id,
      operationId: must(parseOperationId('recovery-divergence-candidate')),
      mutation: {
        kind: 'move-resource',
        resourceId: must(parseResourceId('recovery-resource')),
        expectedPath: must(parseWorkspacePath('notes/base.txt')),
        destination: must(parseWorkspacePath('notes/candidate.txt')),
      },
    });
    if (candidate.kind !== 'changed') throw new Error('Expected candidate version.');
    const bundle = exportCanonicalClosure(candidate.graph);
    const isolatedGraph = must(
      importCanonicalRecords({
        ...bundle,
        refs: [{ name: 'main', head: accepted.version.id }],
      })
    );

    const captureInput = {
      graph: isolatedGraph,
      operationId: must(parseOperationId('recovery-divergence-capture')),
      candidate: {
        kind: 'divergent-workspace',
        workspaceId: must(parseWorkspaceId('workspace-recovery')),
        baseVersionId: accepted.version.id,
        candidateVersionId: candidate.version.id,
        acceptedVersionId: accepted.version.id,
        expiresAtEpochMs: 2_000_000_000_000,
      },
    } as const;
    const captured = captureRecoveryCandidate(captureInput);

    expect(captured.kind).toBe('captured');
    if (captured.kind !== 'captured') throw new Error('Expected divergent capture.');
    expect(captured.candidate.status).toBe('valid-unaccepted');
    expect(exportCanonicalClosure(captured.graph).refs).toEqual([
      { name: 'main', head: accepted.version.id },
    ]);

    const advancedState = must(
      defineResourceState({
        layout: 'file',
        resourceKind: 'text.note',
        mediaType: 'text/plain',
        blob: defineBlob(new TextEncoder().encode('accepted-after-capture')),
      })
    );
    const acceptedSlot = must(listWorkspaceResources(accepted.graph, accepted.version.id))[0];
    if (!acceptedSlot) throw new Error('Expected accepted resource slot.');
    const advanced = applyWorkspaceMutation({
      graph: captured.graph,
      refName: MAIN_REF,
      expectedHead: accepted.version.id,
      operationId: must(parseOperationId('recovery-accepted-advance')),
      mutation: {
        kind: 'edit-resource',
        resourceId: acceptedSlot.resourceId,
        expectedRevision: acceptedSlot.revisionId,
        state: advancedState,
      },
    });
    if (advanced.kind !== 'changed') throw new Error('Expected accepted head advance.');
    const importedAfterAdvance = must(
      importCanonicalRecords(exportCanonicalClosure(advanced.graph))
    );
    const replay = captureRecoveryCandidate({ ...captureInput, graph: importedAfterAdvance });
    expect(replay.kind).toBe('replay');
    if (replay.kind !== 'replay') throw new Error('Expected historical recovery replay.');
    expect(replay.original).toEqual({
      operationId: captureInput.operationId,
      outcome: 'recovery-candidate',
      candidate: captured.candidate,
      recordWrites: captured.recordWrites,
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1])(
    'rejects invalid explicit expiry %s',
    (expiresAtEpochMs) => {
      const result = captureRecoveryCandidate({
        graph: emptyRecoveryGraph(),
        operationId: must(parseOperationId(`recovery-bad-expiry-${String(expiresAtEpochMs)}`)),
        candidate: {
          kind: 'invalid-working-state',
          workspaceId: must(parseWorkspaceId('workspace-recovery')),
          claimedResourceId: null,
          baseRevisionId: null,
          observedPath: must(parseWorkspacePath('incoming/invalid-expiry.bin')),
          payloads: [
            {
              role: 'observed-bytes',
              mediaType: 'application/octet-stream',
              blob: defineBlob(new Uint8Array([0])),
            },
          ],
          failure: { kind: 'parse-failed', code: 'UNSUPPORTED_FORMAT' },
          expiresAtEpochMs,
        },
      });
      expect(result).toEqual({
        kind: 'rejected',
        graph: expect.any(Object),
        error: { kind: 'invalid-expiry' },
      });
    }
  );

  it.each([
    { mediaType: 'application/\ud800', code: 'INVALID' },
    { mediaType: 'application/octet-stream', code: '\ud800' },
  ])('rejects non-scalar recovery text as invalid payload', ({ mediaType, code }) => {
    const result = captureRecoveryCandidate({
      graph: emptyRecoveryGraph(),
      operationId: must(parseOperationId('recovery-non-scalar-text')),
      candidate: {
        kind: 'invalid-working-state',
        workspaceId: must(parseWorkspaceId('workspace-recovery')),
        claimedResourceId: null,
        baseRevisionId: null,
        observedPath: must(parseWorkspacePath('incoming/invalid-text.bin')),
        payloads: [
          {
            role: 'observed-bytes',
            mediaType,
            blob: defineBlob(new Uint8Array([0])),
          },
        ],
        failure: { kind: 'parse-failed', code },
        expiresAtEpochMs: 2_000_000_000_000,
      },
    });
    expect(result).toEqual({
      kind: 'rejected',
      graph: expect.any(Object),
      error: { kind: 'invalid-payload' },
    });
  });
});

function emptyRecoveryGraph() {
  return createRevisionGraph({
    workspaceId: must(parseWorkspaceId('workspace-recovery')),
    acceptedRef: MAIN_REF,
  });
}

function must<Value, ErrorValue>(result: Result<Value, ErrorValue>): Value {
  if (!result.ok) throw new Error(`Expected success, received ${JSON.stringify(result.error)}`);
  return result.value;
}
