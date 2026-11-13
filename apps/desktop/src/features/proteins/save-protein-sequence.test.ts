import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeChecksum } from '@waypoint/sequence-utils';

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  writeWorkspaceTextFileAtomic: vi.fn(),
  stat: vi.fn(),
  reconcileEntityFile: vi.fn(),
  queryLimsEntities: vi.fn(),
  isGitRepo: vi.fn(),
  gitCommitPaths: vi.fn(),
  updateLimsEntity: vi.fn(),
  getCatalogWorkspaceRootForFilePath: vi.fn(),
  getCatalogEntityForFilePath: vi.fn(),
  getWorkspaceRootById: vi.fn(),
  resolveWorkspaceId: vi.fn(),
  bindCatalogEntityToFile: vi.fn(),
  recordCatalogEvent: vi.fn(),
  emitChanged: vi.fn(),
  archiveEntity: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    fs: {
      exists: async (path: string) => mocks.files.has(path),
      readTextFile: async (path: string) => mocks.files.get(path) ?? '',
      writeWorkspaceTextFileAtomic: mocks.writeWorkspaceTextFileAtomic,
      stat: mocks.stat,
    },
    lims: {
      archiveEntity: mocks.archiveEntity,
    },
  }),
}));
vi.mock('../../db/entity-substrate/adapter', () => ({
  reconcileEntityFile: mocks.reconcileEntityFile,
}));
vi.mock('../lims/operations', () => ({ queryLimsEntities: mocks.queryLimsEntities }));
vi.mock('../workspace/git', () => ({
  isGitRepo: mocks.isGitRepo,
  gitCommitPaths: mocks.gitCommitPaths,
}));
vi.mock('../lims/events', () => ({ emitLimsRegistrationChanged: mocks.emitChanged }));
vi.mock('../../db/workspace-catalog', () => ({
  getCatalogWorkspaceRootForFilePath: mocks.getCatalogWorkspaceRootForFilePath,
  getCatalogEntityForFilePath: mocks.getCatalogEntityForFilePath,
  getWorkspaceRootById: mocks.getWorkspaceRootById,
  resolveWorkspaceId: mocks.resolveWorkspaceId,
  bindCatalogEntityToFile: mocks.bindCatalogEntityToFile,
  recordCatalogEvent: mocks.recordCatalogEvent,
}));
vi.mock('../../services/lims-entity-mutations', () => ({
  updateLimsEntity: mocks.updateLimsEntity,
}));

import type { LimsEntity } from '../../shared/lims';
import { parseEntityArtifact, serializeEntityArtifact } from '../lims/entity-artifact';
import { resolveProteinEntityArtifactRevision, saveProteinSequence } from './save-protein-sequence';

const ARTIFACT_PATH = '/workspace/proteins/Reporter.entity.json';

function packageEntity(): LimsEntity {
  return {
    id: 'protein-1',
    kind: 'protein',
    schemaId: null,
    schemaRevisionId: 'revision-1',
    name: 'Reporter protein',
    registryId: null,
    fields: {
      sequence: { mode: 'inline', aminoAcids: 'MKT', length: 3 },
      artifact: { schema: 'waypoint.entity.v1', relativePath: 'proteins/Reporter.entity.json' },
    },
    registrationStatus: 'registered',
    domainStatus: null,
    workspaceId: 7,
    actor: null,
    eventSeq: 1,
    tombstone: false,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
  };
}

function packageContent(): string {
  return serializeEntityArtifact({
    schema: 'waypoint.entity.v1',
    id: 'protein-1',
    kind: 'protein',
    name: 'Reporter protein',
    fields: packageEntity().fields,
    registrationStatus: 'registered',
    domainStatus: null,
    relationships: [],
    source: { type: 'manual', values: {} },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.files.clear();
  mocks.files.set(ARTIFACT_PATH, packageContent());
  mocks.writeWorkspaceTextFileAtomic.mockResolvedValue({
    path: ARTIFACT_PATH,
    contentHash: 'b'.repeat(64),
  });
  mocks.stat.mockResolvedValue({ size: 300, mtime: 200 });
  mocks.reconcileEntityFile.mockResolvedValue({ id: 'protein-1', outcome: 'updated' });
  mocks.getWorkspaceRootById.mockResolvedValue('/workspace');
  mocks.resolveWorkspaceId.mockResolvedValue(7);
  mocks.queryLimsEntities.mockResolvedValue([
    {
      ...packageEntity(),
      fields: {
        ...packageEntity().fields,
        sequence: { mode: 'inline', aminoAcids: 'MKTW*', length: 5 },
      },
    },
  ]);
  mocks.isGitRepo.mockResolvedValue(true);
});

describe('package-backed protein editing', () => {
  it('resolves the authoritative package by entity identity, not Registry contents alone', async () => {
    const resolution = await resolveProteinEntityArtifactRevision({
      entity: packageEntity(),
      workspaceRoots: [],
    });
    expect(resolution.status).toBe('ready');
    if (resolution.status !== 'ready') throw new Error('expected ready authority');
    const { revision } = resolution;
    expect(revision.artifactPath).toBe(ARTIFACT_PATH);
    expect(revision.artifact.id).toBe('protein-1');
    expect(revision.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('retains the Registry record when its authoritative file is unavailable', async () => {
    mocks.files.clear();

    await expect(
      resolveProteinEntityArtifactRevision({ entity: packageEntity(), workspaceRoots: [] })
    ).resolves.toEqual({ status: 'missing-authority' });
    expect(mocks.archiveEntity).not.toHaveBeenCalled();
    expect(mocks.updateLimsEntity).not.toHaveBeenCalled();
  });

  it('repairs a legacy ownerless projection from its one mounted authoritative file', async () => {
    mocks.getWorkspaceRootById.mockResolvedValue(null);
    const entity = { ...packageEntity(), workspaceId: null };

    const resolution = await resolveProteinEntityArtifactRevision({
      entity,
      workspaceRoots: ['/workspace'],
    });

    expect(resolution.status).toBe('ready');
    expect(mocks.reconcileEntityFile).toHaveBeenCalledWith(
      expect.anything(),
      packageContent(),
      ARTIFACT_PATH,
      200,
      { workspaceRoot: '/workspace', workspaceId: 7 }
    );
  });

  it('atomically replaces the package, reconciles Registry from it, and commits the package path', async () => {
    const openedHash = await computeChecksum(packageContent());
    const result = await saveProteinSequence({
      entity: packageEntity(),
      bases: 'mkt w*',
      expectedContentHash: openedHash,
      workspaceRoots: ['/workspace'],
    });

    const write = mocks.writeWorkspaceTextFileAtomic.mock.calls[0][0];
    expect(write).toMatchObject({
      workspaceRoot: '/workspace',
      path: ARTIFACT_PATH,
      mode: 'replace',
      expectedContentHash: openedHash.replace('sha256:', ''),
      artifactNoun: 'protein package',
    });
    expect(parseEntityArtifact(write.content).fields.sequence).toMatchObject({
      mode: 'inline',
      aminoAcids: 'MKTW*',
      length: 5,
    });
    expect(mocks.reconcileEntityFile).toHaveBeenCalledTimes(2);
    expect(mocks.reconcileEntityFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.writeWorkspaceTextFileAtomic.mock.invocationCallOrder[0]
    );
    expect(mocks.writeWorkspaceTextFileAtomic.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.reconcileEntityFile.mock.invocationCallOrder[1]
    );
    expect(mocks.gitCommitPaths).toHaveBeenCalledWith(
      '/workspace',
      'Update protein Reporter protein',
      ['proteins/Reporter.entity.json', '.waypoint/lims']
    );
    expect(mocks.emitChanged).toHaveBeenCalledWith({
      filePath: ARTIFACT_PATH,
      entityId: 'protein-1',
    });
    expect(result).toMatchObject({ bases: 'MKTW*', expectedContentHash: 'b'.repeat(64) });
  });

  it('refuses stale writes when the package changed after open', async () => {
    await expect(
      saveProteinSequence({
        entity: packageEntity(),
        bases: 'MKTW',
        expectedContentHash: `sha256:${'a'.repeat(64)}`,
        workspaceRoots: ['/workspace'],
      })
    ).rejects.toThrow(/changed after it was opened/i);
    expect(mocks.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
  });

  it('preserves both versions when the current protein projection conflicts with its file', async () => {
    mocks.reconcileEntityFile.mockResolvedValue({ id: 'protein-1', outcome: 'conflict' });
    await expect(
      saveProteinSequence({
        entity: packageEntity(),
        bases: 'MKTW',
        expectedContentHash: await computeChecksum(packageContent()),
        workspaceRoots: ['/workspace'],
      })
    ).rejects.toThrow(/disagree/i);
    expect(mocks.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
    expect(mocks.files.get(ARTIFACT_PATH)).toBe(packageContent());
    expect(mocks.archiveEntity).not.toHaveBeenCalled();
    expect(mocks.gitCommitPaths).not.toHaveBeenCalled();
  });
});

describe('legacy FASTA-backed protein editing', () => {
  it('keeps the established FASTA writer for legacy records', async () => {
    const entity = {
      ...packageEntity(),
      fields: {
        sequence: {
          mode: 'file',
          relPath: '/workspace/Proteins/Reporter.faa',
          length: 3,
          contentHash: `sha256:${'a'.repeat(64)}`,
          fileContentHash: `sha256:${'a'.repeat(64)}`,
          sourceFormat: 'fasta',
        },
      },
    } satisfies LimsEntity;
    mocks.getCatalogWorkspaceRootForFilePath.mockResolvedValue('/workspace');
    mocks.getCatalogEntityForFilePath.mockResolvedValue({ id: 'catalog-protein-1' });
    mocks.updateLimsEntity.mockResolvedValue(entity);

    await saveProteinSequence({
      entity,
      bases: 'MKTW',
      expectedContentHash: `sha256:${'a'.repeat(64)}`,
    });

    expect(mocks.writeWorkspaceTextFileAtomic.mock.calls[0][0].content).toBe(
      '>Reporter protein\nMKTW\n'
    );
    expect(mocks.updateLimsEntity).toHaveBeenCalledTimes(1);
  });
});
