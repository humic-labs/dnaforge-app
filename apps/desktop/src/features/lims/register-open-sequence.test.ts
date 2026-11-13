import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerOpenSequenceFile, sequenceEntityNameFromPath } from './register-open-sequence';
import { subscribeLimsRegistrationChanged } from './events';
import type { FileDnaSequenceRef, LimsEntity } from '../../shared/lims';

const mocks = vi.hoisted(() => ({
  buildFileDnaSequenceRef: vi.fn(),
  getCandidates: vi.fn(),
  logTelemetry: vi.fn(),
  registerLimsEntity: vi.fn(),
}));

vi.mock('./dna-sequence', () => ({
  buildFileDnaSequenceRef: mocks.buildFileDnaSequenceRef,
}));

vi.mock('./operations', () => ({
  getLimsRegistrationBadgeCandidates: mocks.getCandidates,
  logLimsTelemetry: mocks.logTelemetry,
  registerLimsEntity: mocks.registerLimsEntity,
}));

describe('registerOpenSequenceFile', () => {
  const documentId = 'sequence-document-puc19';
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCandidates.mockResolvedValue([]);
    mocks.logTelemetry.mockResolvedValue({});
    mocks.buildFileDnaSequenceRef.mockResolvedValue(
      fileSequence({ relPath: '/workspace/pUC19.gb' })
    );
    mocks.registerLimsEntity.mockImplementation(async (input) => entity(input));
  });

  it('registers an unregistered circular file-backed sequence as a DNA sequence', async () => {
    const events: unknown[] = [];
    const unsubscribe = subscribeLimsRegistrationChanged((detail) => events.push(detail));

    const result = await registerOpenSequenceFile({
      documentId,
      sourcePath: '/workspace/pUC19-alpha.gb',
      kind: 'sequence',
      actor: 'tester',
    });

    unsubscribe();
    expect(mocks.getCandidates).toHaveBeenCalledWith({ documentId });
    expect(mocks.buildFileDnaSequenceRef).toHaveBeenCalledWith('/workspace/pUC19-alpha.gb', {
      documentId,
    });
    expect(mocks.registerLimsEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'sequence',
        name: 'pUC19-alpha',
        registrationStatus: 'registered',
        actor: 'tester',
        fields: expect.objectContaining({
          notes: 'Registered from the open sequence tab.',
          sequence: expect.objectContaining({
            mode: 'file',
            relPath: '/workspace/pUC19.gb',
            topology: 'circular',
          }),
        }),
      })
    );
    expect(result).toMatchObject({
      alreadyRegistered: false,
      entity: expect.objectContaining({ id: 'entity-1', kind: 'sequence' }),
    });
    expect(events).toEqual([{ documentId, entityId: 'entity-1' }]);
  });

  it('does not turn a linear file-backed sequence into a chromosome record', async () => {
    mocks.buildFileDnaSequenceRef.mockResolvedValue(fileSequence({ topology: 'linear' }));

    await registerOpenSequenceFile({
      documentId: 'sequence-document-ecoli',
      sourcePath: '/workspace/ecoli-region.gb',
      kind: 'sequence',
    });

    expect(mocks.registerLimsEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'sequence',
        name: 'ecoli-region',
        fields: expect.objectContaining({
          sequence: expect.objectContaining({ topology: 'linear' }),
        }),
      })
    );
    expect(mocks.registerLimsEntity.mock.calls[0]?.[0].fields).not.toHaveProperty('moleculeType');
  });

  it('does not register without an explicit selected kind', async () => {
    await expect(
      registerOpenSequenceFile({
        documentId: 'sequence-document-ecoli',
        sourcePath: '/workspace/ecoli-region.gb',
      } as never)
    ).rejects.toThrow(/choose a LIMS registration type/i);

    expect(mocks.buildFileDnaSequenceRef).not.toHaveBeenCalled();
    expect(mocks.registerLimsEntity).not.toHaveBeenCalled();
  });

  it('returns an existing candidate instead of creating a duplicate', async () => {
    const existing = entity({
      kind: 'sequence',
      name: 'pUC19',
      fields: { sequence: fileSequence({ relPath: '/workspace/pUC19.gb' }) },
    });
    mocks.getCandidates.mockResolvedValue([
      { entity: existing, sequence: existing.fields.sequence },
    ]);

    const result = await registerOpenSequenceFile({
      documentId,
      sourcePath: '/workspace/pUC19.gb',
      kind: 'sequence',
    });

    expect(result).toEqual({ entity: existing, alreadyRegistered: true });
    expect(mocks.buildFileDnaSequenceRef).not.toHaveBeenCalled();
    expect(mocks.registerLimsEntity).not.toHaveBeenCalled();
  });

  it('derives display names from file paths', () => {
    expect(sequenceEntityNameFromPath('/tmp/workspace/plasmids/pUC19-alpha.gbk')).toBe(
      'pUC19-alpha'
    );
    expect(sequenceEntityNameFromPath('/tmp/workspace/reference.fasta')).toBe('reference');
  });
});

function fileSequence(overrides: Partial<FileDnaSequenceRef> = {}): FileDnaSequenceRef {
  return {
    mode: 'file',
    documentId: 'sequence-document-puc19',
    relPath: '/workspace/pUC19.gb',
    topology: 'circular',
    length: 2686,
    contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    fileContentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    normalizedSequenceHash:
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    sourceFormat: 'gb',
    sequenceId: 1,
    sizeBytes: 1024,
    modifiedAt: 200,
    ...overrides,
  };
}

function entity(
  input: Partial<LimsEntity> & { fields?: Record<string, unknown> } = {}
): LimsEntity {
  return {
    id: 'entity-1',
    kind: 'plasmid',
    schemaId: 'schema-entity-plasmid',
    schemaRevisionId: 'schema-entity-plasmid-v1',
    name: 'pUC19',
    fields: {},
    registrationStatus: 'registered',
    domainStatus: null,
    workspaceId: null,
    actor: 'local-user',
    eventSeq: 1,
    tombstone: false,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    ...input,
  };
}
