import { describe, expect, it } from 'vitest';
import type { SequencePackageEvidenceRun } from '../../../db/sequence-package';
import type { SequencePackageEvidenceRead } from '../../../db/sequence-package-history-io';
import { projectPackageEvidence } from './package-evidence';
import type { ReferenceVerificationState } from '../types';

const run: SequencePackageEvidenceRun = {
  id: 'run-one',
  sessionId: 'session-one',
  session: {
    name: 'Sequence confirmation',
    mode: 'multi-per-clone',
    createdAt: '2026-01-01T00:00:00Z',
  },
  createdAt: '2026-01-02T00:00:00Z',
  status: 'completed',
  managedOperationId: 'operation-one',
  inputRevision: 'input-one',
  reference: {
    artifact: {
      path: 'contents/evidence/run-one/reference.gb',
      sha256: `sha256:${'a'.repeat(64)}`,
    },
    sequenceRevision: 'reference-one',
    topology: 'linear',
    checkpointId: 'checkpoint-one',
  },
  queries: [
    {
      id: 'query-one',
      label: 'Read one',
      artifact: {
        path: 'contents/evidence/run-one/query-0.fasta',
        sha256: `sha256:${'b'.repeat(64)}`,
      },
    },
  ],
  result: { path: 'contents/evidence/run-one/result.json', sha256: `sha256:${'c'.repeat(64)}` },
};

const state = {
  schema: 'waypoint.sequence-evidence-state.v1',
  runId: run.id,
  tracks: [
    {
      queryId: 'query-one',
      label: 'Read one',
      alignment: {
        alignedReference: 'AACC',
        alignedQuery: 'AACC',
        identity: 100,
        coverageStart: 1,
        coverageEnd: 4,
        algorithm: 'pairwise',
      },
      mutations: [],
      status: 'pass',
      userStatus: 'variants',
      userOverrideReason: 'manual review',
      alignedAt: '2026-01-02T00:00:00Z',
    },
  ],
};

describe('package evidence projection', () => {
  it.each(['pass', 'variants', 'fail', 'incomplete'] as const)(
    'restores retained sequencing status %s without discarding its alignment',
    (status) => {
      const saved = { ...state, tracks: [{ ...state.tracks[0], status }] };
      const projected = projectPackageEvidence({
        documentId: 'entity-one',
        packageRoot: '/copied/entity',
        runs: [run],
        reads: new Map([
          [run.id, { status: 'available' as const, run, result: {}, states: [saved] }],
        ]),
      });
      expect(projected.sessions[0].tracks[0]).toMatchObject({
        status,
        alignment: state.tracks[0].alignment,
        mutations: state.tracks[0].mutations,
      });
    }
  );
  it('rebuilds a copied package review without any sidecar', () => {
    const reads = new Map<string, SequencePackageEvidenceRead>([
      [
        run.id,
        {
          status: 'available',
          run,
          result: {},
          states: [state],
        },
      ],
    ]);
    const projected = projectPackageEvidence({
      documentId: 'entity-one',
      packageRoot: '/copied/entity',
      runs: [run],
      reads,
    });
    expect(projected.activeSessionId).toBe('session-one');
    expect(projected.sessions[0].name).toBe('Sequence confirmation');
    expect(projected.sessions[0].mode).toBe('multi-per-clone');
    expect(projected.sessions[0].tracks[0]).toMatchObject({
      id: 'query-one',
      evidenceRunId: run.id,
      userStatus: 'variants',
      queryPath: '/copied/entity/contents/evidence/run-one/query-0.fasta',
      testedReference: { checkpointId: 'checkpoint-one' },
    });
  });

  it.each([
    { change: 'matching owner', patch: {}, retained: true },
    { change: 'other operation', patch: { id: 'other-operation' }, retained: false },
    { change: 'other input revision', patch: { inputRevision: 'other-input' }, retained: false },
    { change: 'other evidence run', patch: { evidenceRunId: 'other-run' }, retained: false },
    {
      change: 'private malformed alias',
      patch: { inputCorrelationId: '/private/input-name' },
      retained: false,
    },
  ])(
    'preserves only safe local correlation for the exact canonical run: $change',
    ({ patch, retained }) => {
      const alias = '550e8400-e29b-41d4-a716-446655440360';
      const sidecarState: ReferenceVerificationState = {
        documentId: 'entity-one',
        activeSessionId: run.sessionId,
        sessions: [
          {
            id: run.sessionId,
            name: 'Untrusted sidecar title',
            createdAt: run.createdAt,
            mode: 'one-per-clone',
            tracks: [],
            alignmentOperation: {
              id: run.managedOperationId!,
              inputRevision: run.inputRevision!,
              evidenceRunId: run.id,
              inputCorrelationId: alias,
              status: 'failed',
              queries: [],
              ...patch,
            },
          },
        ],
      };
      const projected = projectPackageEvidence({
        documentId: 'entity-one',
        packageRoot: '/copied/entity',
        sidecarState,
        runs: [run],
        reads: new Map([[run.id, { status: 'available', run, result: {}, states: [state] }]]),
      });
      const session = projected.sessions[0];
      expect(session.alignmentOperation?.inputCorrelationId).toBe(retained ? alias : undefined);
      expect(session.alignmentOperation).toMatchObject({
        id: run.managedOperationId,
        inputRevision: run.inputRevision,
        evidenceRunId: run.id,
        status: 'succeeded',
      });
      expect(session.name).toBe('Sequence confirmation');
      expect(session.tracks[0].alignment).toEqual(state.tracks[0].alignment);
    }
  );

  it('does not trust a sidecar result when its package evidence is unavailable', () => {
    const sidecarState: ReferenceVerificationState = {
      documentId: 'entity-one',
      activeSessionId: 'session-one',
      sessions: [
        {
          id: 'session-one',
          name: 'Sidecar title',
          mode: 'one-per-clone',
          createdAt: '2026-01-01T00:00:00Z',
          tracks: [
            {
              id: 'query-one',
              queryPath: '/unsafe/old.fasta',
              label: 'Unverified',
              alignment: state.tracks[0].alignment,
              mutations: [],
              status: 'pass',
              alignedAt: '2026-01-02T00:00:00Z',
              evidenceRunId: run.id,
            },
          ],
        },
      ],
    };
    const projected = projectPackageEvidence({
      documentId: 'entity-one',
      packageRoot: '/copied/entity',
      sidecarState,
      runs: [run],
      reads: new Map([[run.id, { status: 'unavailable', run, reason: 'tampered' }]]),
    });
    expect(projected.sessions[0].tracks).toEqual([]);
    expect(projected.sessions[0].name).toBe('Sequence confirmation');
  });

  it('uses the latest package review for renamed and archived session state', () => {
    const reads = new Map<string, SequencePackageEvidenceRead>([
      [
        run.id,
        {
          status: 'available',
          run,
          result: {},
          states: [
            state,
            {
              ...state,
              session: {
                name: 'Reviewed clone',
                mode: 'multi-per-clone',
                createdAt: '2026-01-01T00:00:00Z',
                archived: true,
              },
            },
          ],
        },
      ],
    ]);
    const projected = projectPackageEvidence({
      documentId: 'entity-one',
      packageRoot: '/copied/entity',
      runs: [run],
      reads,
    });
    expect(projected.sessions[0]).toMatchObject({ name: 'Reviewed clone', archived: true });
    expect(projected.activeSessionId).toBeNull();
  });
});
