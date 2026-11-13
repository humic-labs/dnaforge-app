import { describe, it, expect, vi, beforeEach } from 'vitest';
import { userMessagePayload, withUserMessage } from '@waypoint/user-messages';
import type {
  SavedPrimerArtifact,
  WriteAndProjectedPrimerArtifact,
} from './primer-artifact-service';

const svc = vi.hoisted(() => ({
  savePrimerArtifact: vi.fn(),
  writeAndProjectPrimerArtifact: vi.fn(),
}));
const mutation = vi.hoisted(() => ({
  withRendererWorkspaceMutation: vi.fn(
    async (_workspaceRoot: string, operation: (mutationToken?: string) => Promise<unknown>) =>
      operation('primer-batch-token')
  ),
}));

vi.mock('../../services/workspace-mutation-transaction', () => mutation);

vi.mock('./primer-artifact-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./primer-artifact-service')>();
  return {
    ...actual,
    savePrimerArtifact: svc.savePrimerArtifact,
    writeAndProjectPrimerArtifact: svc.writeAndProjectPrimerArtifact,
  };
});

import { recordPrimers } from './record-primers';
import { PrimerProjectionError } from './primer-artifact-service';

function fakeWriteResult(name: string, created: boolean): WriteAndProjectedPrimerArtifact {
  return {
    artifactPath: `/ws/primers/${name}.primer.json`,
    artifact: {
      file: { workspaceRelativePath: `primers/${name}.primer.json` },
      id: `id-${name}`,
      name,
    } as WriteAndProjectedPrimerArtifact['artifact'],
    limsEntity: {} as WriteAndProjectedPrimerArtifact['limsEntity'],
    primer: {} as WriteAndProjectedPrimerArtifact['primer'],
    limsPathsBefore: new Set(),
    created,
  };
}

function fakeSaveResult(name: string): SavedPrimerArtifact {
  return {
    artifactPath: `/ws/primers/${name}.primer.json`,
    artifact: {
      file: { workspaceRelativePath: `primers/${name}.primer.json` },
      id: `id-${name}`,
      name,
    } as SavedPrimerArtifact['artifact'],
    limsEntity: {} as SavedPrimerArtifact['limsEntity'],
    primer: {} as SavedPrimerArtifact['primer'],
    gitCommitted: true,
    created: true,
  };
}

const P = (name: string) => ({ name, sequence: 'ACGTACGTACGTACGTACGT' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordPrimers seam  / A7)', () => {
  it.each([false, true])(
    'preserves the exact parent across self-commit=%s and batch projection',
    async (deferCommit) => {
      const parentActionId = '550e8400-e29b-41d4-a716-446655440005';
      svc.savePrimerArtifact.mockResolvedValue(fakeSaveResult('Parent'));
      svc.writeAndProjectPrimerArtifact.mockResolvedValue(fakeWriteResult('Parent', true));
      await recordPrimers({
        primers: [P('Parent')],
        workspaceRoot: '/ws',
        origin: 'manual',
        deferCommit,
        parentActionId,
      });
      expect(
        deferCommit ? svc.writeAndProjectPrimerArtifact : svc.savePrimerArtifact
      ).toHaveBeenCalledWith(expect.objectContaining({ name: 'Parent' }), {
        mutationToken: 'primer-batch-token',
        parentActionId,
      });
    }
  );

  it('records each primer SEQUENTIALLY — never Promise.all over the shared git index', async () => {
    const order: string[] = [];
    svc.writeAndProjectPrimerArtifact.mockImplementation((input: { name: string }) => {
      order.push(`invoke:${input.name}`);
      return new Promise((resolve) =>
        setTimeout(() => {
          order.push(`resolve:${input.name}`);
          resolve(fakeWriteResult(input.name, true));
        }, 0)
      );
    });

    await recordPrimers({
      primers: [P('A'), P('B'), P('C')],
      workspaceRoot: '/ws',
      origin: 'assembly',
      deferCommit: true,
    });

    expect(order).toEqual([
      'invoke:A',
      'resolve:A',
      'invoke:B',
      'resolve:B',
      'invoke:C',
      'resolve:C',
    ]);
  });

  it('deferCommit:true uses writeAndProjectPrimerArtifact and performs ZERO commits (savePrimerArtifact never called)', async () => {
    svc.writeAndProjectPrimerArtifact.mockImplementation((input: { name: string }) =>
      Promise.resolve(fakeWriteResult(input.name, true))
    );

    const result = await recordPrimers({
      primers: [P('A'), P('B')],
      workspaceRoot: '/ws',
      origin: 'assembly',
      deferCommit: true,
    });

    expect(svc.writeAndProjectPrimerArtifact).toHaveBeenCalledTimes(2);
    expect(svc.savePrimerArtifact).not.toHaveBeenCalled();
    expect(result.recorded).toHaveLength(2);
  });

  it('deferCommit:false (drawer) uses the self-committing savePrimerArtifact', async () => {
    svc.savePrimerArtifact.mockImplementation((input: { name: string }) =>
      Promise.resolve(fakeSaveResult(input.name))
    );

    const result = await recordPrimers({
      primers: [P('A')],
      workspaceRoot: '/ws',
      origin: 'manual',
      deferCommit: false,
    });

    expect(svc.savePrimerArtifact).toHaveBeenCalledTimes(1);
    expect(svc.writeAndProjectPrimerArtifact).not.toHaveBeenCalled();
    expect(result.recorded).toHaveLength(1);
  });

  it('carries the selected schema revision and values through the shared recording seam', async () => {
    svc.savePrimerArtifact.mockResolvedValue(fakeSaveResult('qPCR_F1'));
    const entitySchema = {
      schemaId: 'schema-qpcr-primer',
      schemaRevisionId: 'schema-qpcr-primer-v2',
      name: 'qpcr_primer',
      displayName: 'qPCR primer',
      baseKind: 'primer' as const,
      version: 2,
      fields: [{ key: 'assayId', label: 'Assay ID', type: 'text', required: true }],
    };

    await recordPrimers({
      primers: [
        {
          ...P('qPCR_F1'),
          entitySchema,
          entityFields: { assayId: 'ASSAY-42' },
        },
      ],
      workspaceRoot: '/ws',
      origin: 'manual',
    });

    expect(svc.savePrimerArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        entitySchema,
        entityFields: { assayId: 'ASSAY-42' },
      }),
      expect.objectContaining({ mutationToken: 'primer-batch-token' })
    );
  });

  it('carries structured vendor chemistry through the shared recording seam', async () => {
    svc.savePrimerArtifact.mockResolvedValue(fakeSaveResult('modified'));
    const oligo = {
      vendor: 'idt',
      notation: '/5Phos/ACGTACGTACGTACGTACGT',
      modifications: [
        {
          chemistryId: 'phosphorylation',
          vendor: 'idt',
          vendorCode: '5Phos',
          placement: 'five-prime' as const,
          behavior: 'terminal-attachment' as const,
          anchor: { kind: 'terminus' as const, end: 'five-prime' as const },
        },
      ],
    };

    await recordPrimers({
      primers: [{ ...P('modified'), oligo }],
      workspaceRoot: '/ws',
      origin: 'manual',
    });

    expect(svc.savePrimerArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ oligo }),
      expect.objectContaining({ mutationToken: 'primer-batch-token' })
    );
  });

  it('classifies an existing byte-matching artifact (created:false) as skipped, not recorded', async () => {
    svc.writeAndProjectPrimerArtifact.mockImplementation((input: { name: string }) =>
      Promise.resolve(fakeWriteResult(input.name, input.name !== 'B'))
    );

    const result = await recordPrimers({
      primers: [P('A'), P('B'), P('C')],
      workspaceRoot: '/ws',
      origin: 'assembly',
      deferCommit: true,
    });

    expect(result.recorded.map((r) => r.artifact.name)).toEqual(['A', 'C']);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ reason: 'duplicate' });
    expect(result.skipped[0].input.name).toBe('B');
    expect(result.failed).toHaveLength(0);
  });

  it('a projection error on one primer becomes a per-item failure — the batch continues', async () => {
    svc.writeAndProjectPrimerArtifact.mockImplementation((input: { name: string }) => {
      if (input.name === 'B') {
        return Promise.reject(
          new PrimerProjectionError('/ws/primers/B.primer.json', new Error('db down'))
        );
      }
      return Promise.resolve(fakeWriteResult(input.name, true));
    });

    const result = await recordPrimers({
      primers: [P('A'), P('B'), P('C')],
      workspaceRoot: '/ws',
      origin: 'assembly',
      deferCommit: true,
    });

    expect(result.recorded.map((r) => r.artifact.name)).toEqual(['A', 'C']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ reason: 'projection' });
    expect(result.failed[0].input.name).toBe('B');
  });

  it('keeps the catalog message a failed save declares on its failure entry', async () => {
    svc.savePrimerArtifact.mockRejectedValue(
      withUserMessage(
        new Error('Save accepted; file delivery remains pending'),
        'document.saveRefreshPending'
      )
    );

    const result = await recordPrimers({
      primers: [P('A')],
      workspaceRoot: '/ws',
      origin: 'manual',
    });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].declaredMessage).toEqual(
      userMessagePayload('document.saveRefreshPending')
    );
  });

  it('a genuine path-collision surfaces as a first-class failure, never a silent skip', async () => {
    svc.writeAndProjectPrimerArtifact.mockRejectedValue(
      new Error('A different primer artifact already exists there. Choose a new file name.')
    );

    const result = await recordPrimers({
      primers: [P('A')],
      workspaceRoot: '/ws',
      origin: 'assembly',
      deferCommit: true,
    });

    expect(result.recorded).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toBe('path-collision');
  });

  it('derives artifactPath from artifactStem (assembly), honoring an explicit artifactPath override (drawer)', async () => {
    const seen: string[] = [];
    svc.writeAndProjectPrimerArtifact.mockImplementation(
      (input: { name: string; artifactPath: string; origin?: string }) => {
        seen.push(input.artifactPath);
        return Promise.resolve(fakeWriteResult(input.name, true));
      }
    );

    await recordPrimers({
      primers: [
        { name: 'F1', sequence: 'ACGTACGTACGTACGTACGT', artifactStem: 'F1-abc12345' },
        {
          name: 'Chosen',
          sequence: 'ACGTACGTACGTACGTACGT',
          artifactPath: '/ws/my-folder/Chosen.primer.json',
        },
      ],
      workspaceRoot: '/ws',
      origin: 'assembly',
      deferCommit: true,
    });

    expect(seen[0]).toBe('/ws/primers/F1-abc12345.primer.json');
    expect(seen[1]).toBe('/ws/my-folder/Chosen.primer.json');
  });

  it('a primer whose input mapping throws is reported as failed — later primers still run (no silent drop)', async () => {
    svc.writeAndProjectPrimerArtifact.mockImplementation((input: { name: string }) =>
      Promise.resolve(fakeWriteResult(input.name, true))
    );

    const result = await recordPrimers({
      primers: [P('A'), { name: null as unknown as string, sequence: 'ACGT' }, P('C')],
      workspaceRoot: '/ws',
      origin: 'assembly',
      deferCommit: true,
    });

    expect(result.recorded.map((r) => r.artifact.name)).toEqual(['A', 'C']);
    expect(result.failed).toHaveLength(1);

    expect(result.recorded.length + result.skipped.length + result.failed.length).toBe(3);
  });

  it('threads the batch origin onto every recording call', async () => {
    const origins: (string | undefined)[] = [];
    const mutationTokens: (string | undefined)[] = [];
    svc.writeAndProjectPrimerArtifact.mockImplementation(
      (input: { name: string; origin?: string }, options?: { mutationToken?: string }) => {
        origins.push(input.origin);
        mutationTokens.push(options?.mutationToken);
        return Promise.resolve(fakeWriteResult(input.name, true));
      }
    );

    await recordPrimers({
      primers: [P('A'), P('B')],
      workspaceRoot: '/ws',
      origin: 'assembly',
      deferCommit: true,
    });

    expect(origins).toEqual(['assembly', 'assembly']);
    expect(mutationTokens).toEqual(['primer-batch-token', 'primer-batch-token']);
  });
});

it('forwards a durable spreadsheet artifact identity to the existing primer owner', async () => {
  svc.writeAndProjectPrimerArtifact.mockResolvedValue(fakeWriteResult('Sheet primer', true));
  await recordPrimers({
    primers: [{ ...P('Sheet primer'), artifactId: 'sheet-row-id' }],
    workspaceRoot: '/ws',
    origin: 'import',
    deferCommit: true,
  });
  expect(svc.writeAndProjectPrimerArtifact).toHaveBeenCalledWith(
    expect.objectContaining({ artifactId: 'sheet-row-id' }),
    expect.anything()
  );
});
