// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMockData, getMockFileContent, MockFsModule } from '../test/platform-mocks';
import { initializeTestSchema } from '../test/initializeTestSchema';
import { getCatalogEntity, getCatalogFilesForEntity } from './workspace-catalog';
import { readProjectMemory } from './project-memory';
import { materializeStructureCoordinateArtifact } from './structure-coordinate-artifact';

describe('structure coordinate artifacts', () => {
  beforeEach(async () => {
    clearMockData();
    await initializeTestSchema();
  });

  it('materializes exact provider bytes as a versionable workspace structure revision', async () => {
    const result = await materializeStructureCoordinateArtifact({
      workspaceRoot: '/lab',
      entityId: 'structure-asset-1',
      revisionId: 'structure-revision-1',
      structureId: 'structure:3OAA',
      label: '3OAA assembly 1',
      providerIdentityKey: 'RCSB:3OAA:ENTRY:ASSEMBLY:1',
      assemblyId: '1',
      format: 'mmcif',
      data: 'data_3OAA\n_atom_site.id 1\n',
    });

    expect(result.path).toBe('/lab/Structures/3OAA assembly 1.structure-asset-1.cif');
    expect(getMockFileContent(result.path)).toBe('data_3OAA\n_atom_site.id 1\n');
    expect(result.revision).toMatchObject({
      id: 'structure-revision-1',
      structureId: 'structure:3OAA',
      providerIdentityKey: 'RCSB:3OAA:ENTRY:ASSEMBLY:1',
      assemblyId: '1',
      coordinateDigestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      sourceArtifact: {
        entityId: 'structure-asset-1',
        path: 'Structures/3OAA assembly 1.structure-asset-1.cif',
      },
    });
    expect(await getCatalogEntity('structure-asset-1')).toMatchObject({
      type: 'structure',
      storage_type: 'file',
    });
    expect(await getCatalogFilesForEntity('structure-asset-1')).toEqual([
      expect.objectContaining({ path: result.path, file_kind: 'mmcif' }),
    ]);
    expect(await readProjectMemory('/lab')).toMatchObject({
      entities: [expect.objectContaining({ id: 'structure-asset-1', kind: 'structure' })],
      files: [expect.objectContaining({ entityId: 'structure-asset-1', fileKind: 'structure' })],
    });
  });

  it('keeps committed coordinate bytes successful when a repairable projection fails', async () => {
    const originalWrite = MockFsModule.writeTextFile;
    const writeSpy = vi
      .spyOn(MockFsModule, 'writeTextFile')
      .mockImplementation(async (path, text) => {
        if (path.includes('/.waypoint/project-memory/')) {
          throw new Error('project memory projection unavailable');
        }
        await originalWrite(path, text);
      });

    try {
      const result = await materializeStructureCoordinateArtifact({
        workspaceRoot: '/lab',
        entityId: 'structure-asset-warning',
        revisionId: 'structure-revision-warning',
        structureId: 'structure:3OAA',
        label: '3OAA warning path',
        format: 'mmcif',
        data: 'data_3OAA\n_atom_site.id 1\n',
      });

      expect(getMockFileContent(result.path)).toBe('data_3OAA\n_atom_site.id 1\n');
      expect(result.warnings).toEqual([
        expect.objectContaining({
          stage: 'project-memory',
          error: 'project memory projection unavailable',
        }),
      ]);
    } finally {
      writeSpy.mockRestore();
    }
  });
});
