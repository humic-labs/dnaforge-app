import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  recordEntityArtifact: vi.fn(),
  queryLimsEntities: vi.fn(),
}));

vi.mock('../lims/record-entity-artifact', () => ({
  recordEntityArtifact: mocks.recordEntityArtifact,
  EntityArtifactCreationProjectionError: class EntityArtifactCreationProjectionError extends Error {
    artifactPath = '/ws/proteins/GFP.entity.json';
  },
}));

vi.mock('../lims/operations', () => ({ queryLimsEntities: mocks.queryLimsEntities }));

import {
  ProteinArtifactPathError,
  previewProteinArtifactPath,
  recordProtein,
  validateProteinArtifactPath,
} from './record-proteins';
import * as recordProteins from './record-proteins';

const WORKSPACE = '/ws';
const SEQUENCE = 'MSKGEELFTGVVPILVELDGDVNGHKFSVSGEG';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recordEntityArtifact.mockImplementation(async (input) => ({
    artifact: { id: input.id },
    artifactPath: `/ws/proteins/${input.artifactStem}.entity.json`,
    relativePath: `proteins/${input.artifactStem}.entity.json`,
    gitCommitted: true,
  }));
  mocks.queryLimsEntities.mockResolvedValue([
    { id: 'projected-protein', kind: 'protein', name: 'GFP', fields: {} },
  ]);
});

describe('recordProtein', () => {
  it.each(['MU', 'MO'])(
    'records recoded protein %s through preview and Registry projection',
    async (sequence) => {
      const preview = await previewProteinArtifactPath(WORKSPACE, 'Recoded', sequence);
      const recorded = await recordProtein({ name: 'Recoded', sequence, workspaceRoot: WORKSPACE });
      expect(recorded.artifactPath).toBe(preview);
      expect(mocks.recordEntityArtifact).toHaveBeenCalledWith(
        expect.objectContaining({
          fields: expect.objectContaining({
            sequence: expect.objectContaining({ aminoAcids: sequence, length: 2 }),
          }),
        })
      );
    }
  );

  it('records a portable inline protein through the shared entity-package writer', async () => {
    const result = await recordProtein({
      name: 'GFP',
      sequence: `msk gee\n${SEQUENCE.slice(6)}`,
      workspaceRoot: WORKSPACE,
      sourceCds: 'GFP-cds',
    });

    expect(mocks.recordEntityArtifact).toHaveBeenCalledTimes(1);
    const input = mocks.recordEntityArtifact.mock.calls[0][0];
    expect(input).toMatchObject({
      kind: 'protein',
      name: 'GFP',
      workspaceRoot: WORKSPACE,
      destinationDir: '/ws/proteins',
      fields: {
        sequence: { mode: 'inline', aminoAcids: SEQUENCE, length: SEQUENCE.length },
        sourceCds: 'GFP-cds',
      },
    });
    expect(input.fields.sequence).not.toHaveProperty('bases');
    expect(input.id).toMatch(/^protein-[0-9a-f]{32}$/);
    expect(input.artifactStem).toMatch(/^GFP-[0-9a-f]{8}$/);
    expect(result.artifactPath).toMatch(/^proteins\/GFP-[0-9a-f]{8}\.entity\.json$/);
    expect(result.limsEntity.id).toBe('projected-protein');
  });

  it('keeps explicit durable sheet-row identity and metadata through the protein owner', async () => {
    await recordProtein({
      name: 'GFP',
      sequence: SEQUENCE,
      workspaceRoot: WORKSPACE,
      id: 'sheet-protein-row',
      artifactStem: 'sheet-protein-row',
      entityFields: { notes: 'Mapped sheet notes' },
    });
    expect(mocks.recordEntityArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'sheet-protein-row',
        artifactStem: 'sheet-protein-row',
        fields: expect.objectContaining({
          notes: 'Mapped sheet notes',
          sequence: expect.objectContaining({ aminoAcids: SEQUENCE }),
        }),
      })
    );
  });

  it('uses the same deterministic package identity for normalized equivalent input', async () => {
    await recordProtein({ name: 'GFP', sequence: SEQUENCE, workspaceRoot: WORKSPACE });
    await recordProtein({
      name: 'GFP',
      sequence: SEQUENCE.toLowerCase(),
      workspaceRoot: WORKSPACE,
    });

    const [first, second] = mocks.recordEntityArtifact.mock.calls.map((call) => call[0]);
    expect(second.id).toBe(first.id);
    expect(second.artifactStem).toBe(first.artifactStem);
  });

  it('gives different sequences different package identities', async () => {
    await recordProtein({ name: 'GFP', sequence: SEQUENCE, workspaceRoot: WORKSPACE });
    await recordProtein({ name: 'GFP', sequence: `${SEQUENCE}A`, workspaceRoot: WORKSPACE });

    const [first, second] = mocks.recordEntityArtifact.mock.calls.map((call) => call[0]);
    expect(second.id).not.toBe(first.id);
    expect(second.artifactStem).not.toBe(first.artifactStem);
  });

  it('honors a chosen nested destination folder', async () => {
    await recordProtein({
      name: 'GFP',
      sequence: SEQUENCE,
      workspaceRoot: WORKSPACE,
      dir: '/ws/sequences/proteins',
    });
    expect(mocks.recordEntityArtifact.mock.calls[0][0].destinationDir).toBe(
      '/ws/sequences/proteins'
    );
  });

  it('rejects a destination outside the owning workspace before writing', async () => {
    await expect(
      recordProtein({
        name: 'GFP',
        sequence: SEQUENCE,
        workspaceRoot: WORKSPACE,
        dir: '/elsewhere',
      })
    ).rejects.toThrow(ProteinArtifactPathError);
    expect(mocks.recordEntityArtifact).not.toHaveBeenCalled();
  });

  it('rejects unsupported protein residues through the shared validator', async () => {
    await expect(
      recordProtein({ name: 'GFP', sequence: 'MSKZ', workspaceRoot: WORKSPACE })
    ).rejects.toThrow(/one-letter amino-acid/i);
    expect(mocks.recordEntityArtifact).not.toHaveBeenCalled();
  });
});

describe('protein package paths', () => {
  it('previews the default package path without exposing a FASTA extension', async () => {
    await expect(previewProteinArtifactPath(WORKSPACE, 'GFP', SEQUENCE)).resolves.toMatch(
      /^proteins\/GFP-[0-9a-f]{8}\.entity\.json$/
    );
  });

  it('previews a chosen nested folder', async () => {
    await expect(
      previewProteinArtifactPath(WORKSPACE, 'GFP', SEQUENCE, '/ws/custom')
    ).resolves.toMatch(/^custom\/GFP-[0-9a-f]{8}\.entity\.json$/);
  });

  it('validates workspace containment for package paths', () => {
    expect(validateProteinArtifactPath('/ws/proteins/GFP.entity.json', '/ws')).toEqual({
      valid: true,
      relativePath: 'proteins/GFP.entity.json',
    });
    expect(validateProteinArtifactPath('/elsewhere/GFP.entity.json', '/ws').valid).toBe(false);
  });
});

describe('protein record public surface', () => {
  it('does not export the retired ProteinHistoryError', () => {
    expect(recordProteins).not.toHaveProperty('ProteinHistoryError');
    expect(typeof recordProteins.recordProtein).toBe('function');
    expect(recordProteins.ProteinProjectionError).toBeInstanceOf(Function);
  });
});
