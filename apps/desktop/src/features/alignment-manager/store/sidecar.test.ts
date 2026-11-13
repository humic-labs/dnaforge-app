// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { sidecarToState, stateToSidecar, serializeSidecar, parseSidecar } from './sidecar';
import type { ReferenceVerificationState } from '../types';

describe('sidecarToState', () => {
  it('returns referenceChecksum from sidecar data', () => {
    const sidecar = {
      type: 'alignment-history' as const,
      version: '2.0' as const,
      reference: { name: 'pUC19', checksum: 'sha256:abc123' },
      savedAt: '2026-03-24T00:00:00Z',
      activeSessionId: null,
      sessions: [],
      viewPreferences: {},
    };

    const result = sidecarToState(sidecar, '/path/to/pUC19.gb');

    expect(result.referenceChecksum).toBe('sha256:abc123');
  });

  it('returns empty string when checksum is missing', () => {
    const sidecar = {
      type: 'alignment-history' as const,
      version: '2.0' as const,
      reference: { name: 'pUC19', checksum: '' },
      savedAt: '2026-03-24T00:00:00Z',
      activeSessionId: null,
      sessions: [],
      viewPreferences: {},
    };

    const result = sidecarToState(sidecar, '/path/to/pUC19.gb');

    expect(result.referenceChecksum).toBe('');
  });

  it('round-trips checkedMutations through sidecar', () => {
    const refState: ReferenceVerificationState = {
      documentId: 'document-ref',
      sessions: [
        {
          id: 'session-1',
          name: 'Test',
          createdAt: '2026-01-01T00:00:00Z',
          mode: 'one-per-clone',
          tracks: [
            {
              id: 'track-1',
              queryPath: '/path/clone.ab1',
              label: 'clone',
              alignment: {
                alignedReference: 'ATCG',
                alignedQuery: 'ATCG',
                identity: 100,
                coverageStart: 1,
                coverageEnd: 4,
                algorithm: 'MAFFT',
              },
              mutations: [],
              status: 'pass',
              alignedAt: '2026-01-01T00:00:00Z',
              checkedMutations: ['mut-0', 'mut-2'],
            },
          ],
        },
      ],
      activeSessionId: 'session-1',
    };

    const sidecar = stateToSidecar('ref', refState, {}, 'sha256:abc');
    const json = serializeSidecar(sidecar);
    const parsed = parseSidecar(json);
    const result = sidecarToState(parsed, '/path/ref.gb');

    expect(result.refState.sessions[0].tracks[0].checkedMutations).toEqual(['mut-0', 'mut-2']);
  });

  it('round-trips the durable session operation identity without sequence bytes', () => {
    const refState: ReferenceVerificationState = {
      documentId: 'document-ref',
      sessions: [
        {
          id: 'session-1',
          name: 'Held operation',
          createdAt: '2026-09-16T00:00:00Z',
          mode: 'one-per-clone',
          tracks: [],
          alignmentOperation: {
            id: 'operation-1',
            inputCorrelationId: '550e8400-e29b-41d4-a716-446655440360',
            inputRevision: `pairwise-session-alignment-v1:sha256:${'a'.repeat(64)}`,
            status: 'active',
            queries: [
              {
                id: `pairwise-query:${'b'.repeat(64)}`,
                queryPath: 'queries/clone-1.fasta',
                label: 'clone-1',
              },
            ],
          },
        },
      ],
      activeSessionId: 'session-1',
    };

    const encoded = serializeSidecar(stateToSidecar('ref', refState, {}, 'sha256:old'));
    const result = sidecarToState(parseSidecar(encoded), 'document-ref');

    expect(result.refState.sessions[0].alignmentOperation).toEqual(
      refState.sessions[0].alignmentOperation
    );
    expect(encoded).not.toContain('referenceSequence');
  });
});
