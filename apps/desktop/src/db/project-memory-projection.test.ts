import { beforeEach, describe, expect, it } from 'vitest';
import { clearMockData, setFileTree, setMockFileContent } from '../test/platform-mocks';
import { initializeTestSchema } from '../test/initializeTestSchema';
import { expectNoProjectMemoryFilesWritten } from '../test/project-memory-guards';
import {
  clearCatalogProjectionForWorkspaceRoot,
  getCatalogEntity,
  getCatalogEntityForFilePath,
  getCatalogEventsForEntity,
  getCatalogFilesForEntity,
  registerCatalogEntity,
  resolveWorkspaceScope,
} from './workspace-catalog';
import { createDesignArtifactFile } from './workspace-artifacts';
import { rebuildWorkspaceCatalogProjection } from './project-memory-projection';
import { scopedProjectionId } from '../shared/workspace-scoped-identity';

describe('project memory catalog projection', () => {
  beforeEach(async () => {
    clearMockData();
    await initializeTestSchema();
  });

  it('rebuilds catalog entities, file bindings, and events after SQLite projection loss', async () => {
    await registerCatalogEntity({
      id: 'design-rebuild',
      type: 'design',
      name: 'Rebuild Design',
      locator: 'entity://design/design-rebuild',
      storageType: 'localStorage',
      workspaceRoot: '/lab',
    });
    await createDesignArtifactFile({
      entityId: 'design-rebuild',
      designId: 'design-rebuild',
      name: 'Rebuild Design',
      design: null,
      workspaceRoot: '/lab',
      context: { targetPath: '/lab', targetKind: 'folder', parentPath: '/lab' },
    });

    await clearCatalogProjectionForWorkspaceRoot('/lab');
    expect(await getCatalogEntity('design-rebuild')).toBeNull();
    expect(await getCatalogEntityForFilePath('/lab/Rebuild Design.wpdesign.json')).toBeNull();

    const result = await rebuildWorkspaceCatalogProjection({
      workspaceRoot: '/lab',
      scanFilesystem: false,
    });

    expect(result.projectMemory).toMatchObject({
      events: 1,
      entities: 1,
      files: 1,
      conflicts: [],
    });
    expect(await getCatalogEntity('design-rebuild')).toMatchObject({
      id: 'design-rebuild',
      type: 'design',
      name: 'Rebuild Design',
      locator: 'entity://design/design-rebuild',
      storage_type: 'localStorage',
    });
    expect(await getCatalogFilesForEntity('design-rebuild')).toEqual([
      expect.objectContaining({
        entity_id: 'design-rebuild',
        path: '/lab/Rebuild Design.wpdesign.json',
        relative_path: 'Rebuild Design.wpdesign.json',
        file_kind: 'waypoint-design',
        status: 'current',
      }),
    ]);
    expect(await getCatalogEventsForEntity('design-rebuild')).toEqual([
      expect.objectContaining({
        id: expect.stringContaining('pm-'),
        event_type: 'artifact_created',
        summary: 'Replayed project memory event: artifact_created',
      }),
    ]);
  });

  it('can rebuild from native DNAForge artifact files when Project Memory is empty', async () => {
    setMockFileContent(
      '/lab/recovered/Recovered.wpnote.json',
      JSON.stringify({
        schema: 'waypoint.notebook.v1',
        kind: 'notebook',
        id: 'page-recovered',
        title: 'Recovered',
        content: { type: 'doc', content: [] },
      })
    );
    setFileTree('/lab', [{ name: 'recovered', isDirectory: true }]);
    setFileTree('/lab/recovered', [{ name: 'Recovered.wpnote.json', isDirectory: false }]);

    const result = await rebuildWorkspaceCatalogProjection({
      workspaceRoot: '/lab',
      scanFilesystem: true,
    });

    expect(result.projectMemory).toMatchObject({ events: 0, entities: 0, files: 0 });
    expect(result.filesystemScan).toMatchObject({
      scanned: 1,
      registered: 2,
      repaired: 1,
    });
    expect(await getCatalogEntityForFilePath('/lab/recovered')).toMatchObject({
      type: 'folder',
      name: 'recovered',
    });
    const scopedId = scopedProjectionId(await resolveWorkspaceScope('/lab'), 'page-recovered');
    expect(scopedId).toMatch(/::page-recovered$/);
    expect(await getCatalogEntity(scopedId)).toMatchObject({
      id: scopedId,
      type: 'notebook',
      name: 'Recovered',
    });
    expect(await getCatalogFilesForEntity(scopedId)).toEqual([
      expect.objectContaining({
        path: '/lab/recovered/Recovered.wpnote.json',
        relative_path: 'recovered/Recovered.wpnote.json',
        file_kind: 'waypoint-notebook',
        status: 'current',
      }),
    ]);
    expectNoProjectMemoryFilesWritten('/lab');
  });
});
