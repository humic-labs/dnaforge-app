import { beforeEach, describe, expect, it } from 'vitest';
import { clearMockData, getMockData } from '../test/platform-mocks';
import { initializeTestSchema } from '../test/initializeTestSchema';
import { platform } from '../platform';
import {
  bindCatalogEntityToFile,
  deactivateCatalogWorkspacePlacement,
  deleteCatalogWorkspacePlacement,
  findWorkspaceRootForPath,
  getCatalogEntity,
  getCatalogEntityForFilePath,
  getCatalogFileForPath,
  getCatalogEventsForEntity,
  getCatalogFilesForEntity,
  getCatalogLinksForEntity,
  getCatalogWorkspacePlacementsForParent,
  getRecentlyEditedCatalogEntities,
  inferCatalogFileKind,
  markCatalogFileMissing,
  markCatalogPathMissing,
  moveCatalogWorkspacePlacement,
  normalizeCatalogSiblingName,
  recordCatalogEvent,
  rebindCatalogFilePath,
  registerCatalogEntity,
  repairDuplicateCurrentBindings,
  registerContextualCatalogEntity,
  registerWorkspaceFile,
  writeCatalogWorkspacePlacement,
} from './workspace-catalog';

describe('workspace catalog', () => {
  beforeEach(async () => {
    clearMockData();
    await initializeTestSchema();
  });

  it('writes, reads by exact parent, moves, deactivates, and deletes virtual placements', async () => {
    await registerCatalogEntity({
      id: 'strain-1',
      type: 'sample',
      name: 'CAFÉ',
      locator: 'entity://lims/strain-1',
      storageType: 'database',
      workspaceRoot: '/lab',
    });
    await registerCatalogEntity({
      id: 'strain-2',
      type: 'sample',
      name: 'Cafe duplicate elsewhere',
      locator: 'entity://lims/strain-2',
      storageType: 'database',
      workspaceRoot: '/lab',
    });

    const first = await writeCatalogWorkspacePlacement({
      entityId: 'strain-1',
      workspaceId: 1,
      parentRelativePath: 'Collections/Strains',
      displayName: 'CAFÉ',
      presentationKind: 'strain',
    });
    await writeCatalogWorkspacePlacement({
      entityId: 'strain-2',
      workspaceId: 1,
      parentRelativePath: 'Collections/Other',
      displayName: 'cafe\u0301',
      presentationKind: 'strain',
    });

    expect(first.normalized_sibling_name).toBe('café');
    expect(normalizeCatalogSiblingName('cafe\u0301')).toBe('café');
    await expect(
      getCatalogWorkspacePlacementsForParent({
        workspaceId: 1,
        parentRelativePath: 'Collections/Strains',
      })
    ).resolves.toEqual([expect.objectContaining({ entity_id: 'strain-1' })]);

    await moveCatalogWorkspacePlacement({
      entityId: 'strain-1',
      workspaceId: 1,
      parentRelativePath: 'Collections/Archived strains',
      displayName: 'Renamed strain',
    });
    await expect(
      getCatalogWorkspacePlacementsForParent({
        workspaceId: 1,
        parentRelativePath: 'Collections/Strains',
      })
    ).resolves.toEqual([]);
    await expect(
      getCatalogWorkspacePlacementsForParent({
        workspaceId: 1,
        parentRelativePath: 'Collections/Archived strains',
      })
    ).resolves.toEqual([
      expect.objectContaining({
        entity_id: 'strain-1',
        display_name: 'Renamed strain',
        normalized_sibling_name: 'renamed strain',
        status: 'active',
      }),
    ]);

    await expect(deactivateCatalogWorkspacePlacement('strain-1')).resolves.toBe(true);
    await expect(
      getCatalogWorkspacePlacementsForParent({
        workspaceId: 1,
        parentRelativePath: 'Collections/Archived strains',
      })
    ).resolves.toEqual([]);
    await expect(deleteCatalogWorkspacePlacement('strain-1')).resolves.toBe(true);
    await expect(deleteCatalogWorkspacePlacement('strain-1')).resolves.toBe(false);
  });

  it('rejects a virtual placement in a different workspace than its entity', async () => {
    await registerCatalogEntity({
      id: 'workspace-bound-strain',
      type: 'sample',
      name: 'Workspace-bound strain',
      locator: 'entity://lims/workspace-bound-strain',
      storageType: 'database',
      workspaceRoot: '/lab',
    });

    await expect(
      writeCatalogWorkspacePlacement({
        entityId: 'workspace-bound-strain',
        workspaceId: 2,
        parentRelativePath: 'Strains',
        displayName: 'Workspace-bound strain',
        presentationKind: 'strain',
      })
    ).rejects.toThrow(/must use its entity workspace/i);
  });

  it('repairDuplicateCurrentBindings collapses ≥2 current bindings to one canonical, non-destructively', async () => {
    await registerCatalogEntity({
      id: 'e1',
      type: 'notebook',
      name: 'Nb',
      locator: 'entity://page/e1',
      storageType: 'database',
      workspaceRoot: '/ws',
    });
    await bindCatalogEntityToFile({
      entityId: 'e1',
      path: '/ws/Nb 2',
      fileKind: 'waypoint-notebook',
      workspaceRoot: '/ws',
      status: 'current',
    });
    await bindCatalogEntityToFile({
      entityId: 'e1',
      path: '/ws/notebooks/Nb',
      fileKind: 'waypoint-notebook',
      workspaceRoot: '/ws',
      status: 'current',
    });

    await platform().db.execute('UPDATE catalog_entity_files SET status = ? WHERE path = ?', [
      'current',
      '/ws/Nb 2',
    ]);

    const result = await repairDuplicateCurrentBindings();
    expect(result).toEqual({ entities: 1, demoted: 1 });

    const files = await getCatalogFilesForEntity('e1');
    const current = files.filter((f) => f.status === 'current');
    expect(current).toHaveLength(1);
    expect(current[0].path).toBe('/ws/notebooks/Nb');

    expect(files.some((f) => f.path === '/ws/Nb 2' && f.status === 'historical')).toBe(true);

    expect(await repairDuplicateCurrentBindings()).toEqual({ entities: 0, demoted: 0 });
  });

  it('registers a workspace file as both an entity and file binding', async () => {
    const entity = await registerWorkspaceFile({
      path: '/lab/plasmids/pUC19.gb',
      name: 'pUC19.gb',
      entityType: 'sequence',
      fileKind: 'genbank',
      workspaceRoot: '/lab',
      sizeBytes: 2686,
      modifiedAt: 123,
      metadata: { source: 'test' },
    });

    expect(entity.type).toBe('sequence');
    expect(entity.locator).toBe('file:///lab/plasmids/pUC19.gb');
    expect(entity.workspace_id).toBe(1);
    expect(JSON.parse(entity.metadata ?? '{}')).toMatchObject({
      source: 'test',
      relativePath: 'plasmids/pUC19.gb',
      fileKind: 'genbank',
    });

    expect(getMockData('workspaces')).toMatchObject([{ id: 1, path: '/lab' }]);

    const files = await getCatalogFilesForEntity(entity.id);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      entity_id: entity.id,
      workspace_id: 1,
      path: '/lab/plasmids/pUC19.gb',
      relative_path: 'plasmids/pUC19.gb',
      file_kind: 'genbank',
      size_bytes: 2686,
      modified_at: 123,
      status: 'current',
    });
  });

  it('lets explicit root registration durably reclassify an existing workspace as reference', async () => {
    await registerWorkspaceFile({
      path: '/lab/discovered-first.txt',
      workspaceRoot: '/lab',
    });

    await registerWorkspaceFile({
      path: '/lab',
      name: 'Reference library',
      entityType: 'folder',
      fileKind: 'folder',
      workspaceRoot: '/lab',
      workspaceAccess: 'reference',
      metadata: { pinned: true },
    });

    expect(getMockData('workspaces')).toEqual([
      expect.objectContaining({ path: '/lab', access_mode: 'reference' }),
    ]);
  });

  it('resolves workspace roots and relative paths for Windows backslash paths', () => {
    const folders = [
      { path: 'C:\\Users\\user\\project' },
      { path: 'C:\\Users\\user\\project\\nested' },
    ];
    expect(findWorkspaceRootForPath(folders, 'C:\\Users\\user\\project\\seq.gb')).toBe(
      'C:\\Users\\user\\project'
    );

    expect(findWorkspaceRootForPath(folders, 'C:\\Users\\user\\project\\nested\\a.gb')).toBe(
      'C:\\Users\\user\\project\\nested'
    );

    expect(findWorkspaceRootForPath(folders, 'c:\\users\\user\\project\\x.gb')).toBe(
      'C:\\Users\\user\\project'
    );

    expect(findWorkspaceRootForPath(folders, 'D:\\other\\x.gb')).toBeNull();
  });

  it('stores workspace-relative paths for a Windows drive path', async () => {
    const entity = await registerWorkspaceFile({
      path: 'C:\\Users\\user\\lab\\plasmids\\pUC19.gb',
      entityType: 'sequence',
      fileKind: 'genbank',
      workspaceRoot: 'C:\\Users\\user\\lab',
    });
    expect(JSON.parse(entity.metadata ?? '{}')).toMatchObject({
      relativePath: 'plasmids/pUC19.gb',
    });
    const files = await getCatalogFilesForEntity(entity.id);
    expect(files[0]?.relative_path).toBe('plasmids/pUC19.gb');
  });

  it('updates existing file catalog rows instead of duplicating them', async () => {
    const first = await registerWorkspaceFile({
      path: '/lab/seq.fa',
      entityType: 'file',
      fileKind: 'fasta',
      workspaceRoot: '/lab',
      sizeBytes: 10,
    });
    const second = await registerWorkspaceFile({
      path: '/lab/seq.fa',
      entityType: 'sequence',
      fileKind: 'fasta',
      workspaceRoot: '/lab',
      sizeBytes: 20,
      modifiedAt: 456,
    });

    expect(second.id).toBe(first.id);
    expect(getMockData('catalog_entities')).toHaveLength(1);
    expect(getMockData('catalog_entity_files')).toHaveLength(1);

    const files = await getCatalogFilesForEntity(second.id);
    expect(files[0]).toMatchObject({
      file_kind: 'fasta',
      size_bytes: 20,
      modified_at: 456,
    });
  });

  it('converges concurrent workspace-file registrations on one current binding', async () => {
    const input = {
      path: '/lab/seq.fa',
      entityType: 'sequence' as const,
      fileKind: 'fasta',
      workspaceRoot: '/lab',
      sizeBytes: 10,
    };

    const [first, second] = await Promise.all([
      registerWorkspaceFile(input),
      registerWorkspaceFile(input),
    ]);

    expect(second.id).toBe(first.id);
    expect(getMockData('workspaces')).toHaveLength(1);
    expect(getMockData('catalog_entities')).toHaveLength(1);
    expect(getMockData('catalog_entity_files')).toHaveLength(1);
    expect(await getCatalogFilesForEntity(first.id)).toEqual([
      expect.objectContaining({
        entity_id: first.id,
        path: input.path,
        status: 'current',
      }),
    ]);
  });

  it('converges concurrent registrations for the same locator on one catalog entity', async () => {
    const input = {
      type: 'sequence' as const,
      name: 'pUC19',
      locator: 'file:///lab/pUC19.gb',
      storageType: 'file' as const,
      workspaceRoot: '/lab',
    };

    const [first, second] = await Promise.all([
      registerCatalogEntity(input),
      registerCatalogEntity(input),
    ]);

    expect(second.id).toBe(first.id);
  });

  it('keeps project catalog entities searchable after the owning workspace is archived', async () => {
    const entity = await registerWorkspaceFile({
      path: '/managed/project-a/repo/plasmids/pUC19.gb',
      name: 'pUC19.gb',
      entityType: 'sequence',
      fileKind: 'genbank',
      workspaceRoot: '/managed/project-a/repo',
      sizeBytes: 2686,
    });

    await platform().db.execute('UPDATE workspaces SET archived_at = ? WHERE path = ?', [
      Date.now(),
      '/managed/project-a/repo',
    ]);

    await expect(getCatalogEntity(entity.id)).resolves.toMatchObject({
      id: entity.id,
      name: 'pUC19.gb',
      workspace_id: 1,
    });
    await expect(
      getCatalogEntityForFilePath('/managed/project-a/repo/plasmids/pUC19.gb')
    ).resolves.toMatchObject({
      id: entity.id,
      type: 'sequence',
    });
    await expect(getCatalogFilesForEntity(entity.id)).resolves.toEqual([
      expect.objectContaining({
        path: '/managed/project-a/repo/plasmids/pUC19.gb',
        status: 'current',
      }),
    ]);
  });

  it('preserves richer git-index file metadata when a later open path re-registers the file', async () => {
    await registerWorkspaceFile({
      path: '/managed/project-a/repo/plasmids/pUC19.gb',
      name: 'pUC19.gb',
      entityType: 'sequence',
      fileKind: 'genbank',
      workspaceRoot: '/managed/project-a/repo',
      contentHash: 'git:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sizeBytes: 2686,
      modifiedAt: 123,
    });

    await registerWorkspaceFile({
      path: '/managed/project-a/repo/plasmids/pUC19.gb',
      name: 'pUC19.gb',
      entityType: 'sequence',
      fileKind: 'genbank',
      workspaceRoot: '/managed/project-a/repo',
    });

    await expect(
      getCatalogFileForPath('/managed/project-a/repo/plasmids/pUC19.gb')
    ).resolves.toEqual(
      expect.objectContaining({
        content_hash: 'git:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        size_bytes: 2686,
        modified_at: 123,
        status: 'current',
      })
    );
  });

  it('binds existing semantic entities to workspace files', async () => {
    const entity = await registerCatalogEntity({
      id: 'design-1',
      type: 'design',
      name: 'Assembly Draft',
      locator: 'entity://design/design-1',
      storageType: 'localStorage',
      workspaceRoot: '/lab',
    });

    await bindCatalogEntityToFile({
      entityId: entity.id,
      path: '/lab/assemblies/Assembly Draft.wpdesign.json',
      workspaceRoot: '/lab',
      sizeBytes: 128,
    });

    expect(
      await getCatalogEntityForFilePath('/lab/assemblies/Assembly Draft.wpdesign.json')
    ).toMatchObject({
      id: entity.id,
      type: 'design',
    });
    expect(await getCatalogFilesForEntity(entity.id)).toEqual([
      expect.objectContaining({
        path: '/lab/assemblies/Assembly Draft.wpdesign.json',
        file_kind: 'waypoint-design',
        relative_path: 'assemblies/Assembly Draft.wpdesign.json',
        size_bytes: 128,
      }),
    ]);
  });

  it('records provenance events for catalog entities', async () => {
    const entity = await registerCatalogEntity({
      id: 'page-1',
      type: 'notebook',
      name: 'Notebook',
      locator: 'entity://page/page-1',
      storageType: 'database',
      workspaceRoot: '/lab',
    });

    await recordCatalogEvent({
      entityId: entity.id,
      eventType: 'artifact_created',
      summary: 'Created notebook artifact file',
      payload: { filePath: '/lab/Notebook.wpnote.json' },
    });

    const events = await getCatalogEventsForEntity(entity.id);
    expect(events).toEqual([
      expect.objectContaining({
        entity_id: entity.id,
        event_type: 'artifact_created',
        actor: 'user',
        summary: 'Created notebook artifact file',
      }),
    ]);
    expect(JSON.parse(events[0].payload ?? '{}')).toMatchObject({
      filePath: '/lab/Notebook.wpnote.json',
    });
  });

  it('records notebook creation context for folder and file targets', async () => {
    const folderNotebook = await registerContextualCatalogEntity({
      id: 'page-folder',
      type: 'notebook',
      name: 'Folder Note',
      locator: 'entity://page/page-folder',
      storageType: 'database',
      workspaceRoot: '/lab',
      context: {
        targetPath: '/lab/experiments',
        targetKind: 'folder',
        parentPath: '/lab/experiments',
      },
    });
    const fileNotebook = await registerContextualCatalogEntity({
      id: 'page-file',
      type: 'notebook',
      name: 'File Note',
      locator: 'entity://page/page-file',
      storageType: 'database',
      workspaceRoot: '/lab',
      context: {
        targetPath: '/lab/experiments/result.txt',
        targetKind: 'file',
        parentPath: '/lab/experiments',
      },
    });

    const folderLinks = await getCatalogLinksForEntity(folderNotebook.id);
    const fileLinks = await getCatalogLinksForEntity(fileNotebook.id);

    expect(folderLinks).toEqual([
      expect.objectContaining({
        source_entity_id: folderNotebook.id,
        relation: 'created_in',
        confidence: 'confirmed',
      }),
    ]);
    expect(fileLinks).toEqual([
      expect.objectContaining({
        source_entity_id: fileNotebook.id,
        relation: 'created_beside',
        confidence: 'confirmed',
      }),
    ]);
  });

  it('uses longest workspace prefix and stable biology file kind inference', () => {
    expect(
      findWorkspaceRootForPath(
        [{ path: '/lab' }, { path: '/lab/project' }],
        '/lab/project/seq.gbff'
      )
    ).toBe('/lab/project');
    expect(inferCatalogFileKind('/lab/project/seq.gbff')).toBe('genbank');
    expect(inferCatalogFileKind('/lab/project/Untitled.wpnote.json')).toBe('waypoint-notebook');
    expect(inferCatalogFileKind('/lab/project/New Design.wpdesign.json')).toBe('waypoint-design');
    expect(inferCatalogFileKind('/lab/project/reads.fastq')).toBe('fastq');
    expect(inferCatalogFileKind('/lab/project/alignment.bam')).toBe('alignment');
    expect(inferCatalogFileKind('/lab/project/1FS0.pdb')).toBe('pdb');
    expect(inferCatalogFileKind('/lab/project/1FS0.mmcif')).toBe('mmcif');
    expect(inferCatalogFileKind('/lab/project/1FS0.cif')).toBe('mmcif');
    expect(inferCatalogFileKind('/lab/project/1FS0.bcif')).toBe('binary-cif');
  });

  it('rebinds file paths after rename without changing semantic identity', async () => {
    const entity = await registerCatalogEntity({
      id: 'page-1',
      type: 'notebook',
      name: 'Notebook',
      locator: 'entity://page/page-1',
      storageType: 'database',
      workspaceRoot: '/lab',
    });
    await bindCatalogEntityToFile({
      entityId: entity.id,
      path: '/lab/Old.wpnote.json',
      workspaceRoot: '/lab',
      sizeBytes: 10,
    });

    await rebindCatalogFilePath({
      oldPath: '/lab/Old.wpnote.json',
      newPath: '/lab/New.wpnote.json',
      workspaceRoot: '/lab',
    });

    expect(await getCatalogFileForPath('/lab/Old.wpnote.json')).toBeNull();
    expect(await getCatalogEntityForFilePath('/lab/New.wpnote.json')).toMatchObject({
      id: 'page-1',
      locator: 'entity://page/page-1',
    });
    expect(await getCatalogEventsForEntity('page-1')).toEqual([
      expect.objectContaining({ event_type: 'path_moved' }),
    ]);
  });

  it('keeps v2 direct-file placement metadata aligned with a catalog rebind', async () => {
    const entity = await registerCatalogEntity({
      id: 'sequence-portable',
      type: 'sequence',
      name: 'Portable sequence',
      locator: 'file:///lab/Sequences/old.gb',
      storageType: 'file',
      workspaceRoot: '/lab',
      metadata: {
        portableId: 'sequence-portable',
        placement: {
          kind: 'file',
          relativePath: 'Sequences/old.gb',
          fileKind: 'genbank',
        },
      },
    });
    await bindCatalogEntityToFile({
      entityId: entity.id,
      path: '/lab/Sequences/old.gb',
      workspaceRoot: '/lab',
    });

    await rebindCatalogFilePath({
      oldPath: '/lab/Sequences/old.gb',
      newPath: '/lab/Archive/new.gb',
      workspaceRoot: '/lab',
    });

    const rebound = await getCatalogEntity('sequence-portable');
    expect(JSON.parse(rebound?.metadata ?? '{}')).toMatchObject({
      portableId: 'sequence-portable',
      placement: { kind: 'file', relativePath: 'Archive/new.gb' },
      path: '/lab/Archive/new.gb',
      previousPath: '/lab/Sequences/old.gb',
    });
  });

  it('can explicitly mature the exact design binding to a plasmid package kind', async () => {
    const design = await registerCatalogEntity({
      id: 'design-maturation',
      type: 'design',
      name: 'Construct draft',
      locator: 'entity://design/design-maturation',
      storageType: 'localStorage',
      workspaceRoot: '/lab',
    });
    await bindCatalogEntityToFile({
      entityId: design.id,
      path: '/lab/Construct.wpdesign.json',
      fileKind: 'waypoint-design',
      workspaceRoot: '/lab',
    });

    await rebindCatalogFilePath({
      oldPath: '/lab/Construct.wpdesign.json',
      newPath: '/lab/Construct',
      workspaceRoot: '/lab',
      targetFileKind: 'waypoint-plasmid',
    });

    expect(await getCatalogFileForPath('/lab/Construct')).toMatchObject({
      entity_id: design.id,
      file_kind: 'waypoint-plasmid',
      status: 'current',
    });
    expect(await getCatalogFileForPath('/lab/Construct.wpdesign.json')).toBeNull();
  });

  it('preserves a plasmid package kind on an ordinary package directory rename', async () => {
    const design = await registerCatalogEntity({
      id: 'design-package-move',
      type: 'design',
      name: 'Construct',
      locator: 'entity://design/design-package-move',
      storageType: 'localStorage',
      workspaceRoot: '/lab',
    });
    await bindCatalogEntityToFile({
      entityId: design.id,
      path: '/lab/Construct',
      fileKind: 'waypoint-plasmid',
      workspaceRoot: '/lab',
    });

    await rebindCatalogFilePath({
      oldPath: '/lab/Construct',
      newPath: '/lab/Archive/Construct',
      workspaceRoot: '/lab',
    });

    expect(await getCatalogFileForPath('/lab/Archive/Construct')).toMatchObject({
      entity_id: design.id,
      file_kind: 'waypoint-plasmid',
      status: 'current',
    });
  });

  it('rebinds folder prefixes for known child files', async () => {
    const folder = await registerWorkspaceFile({
      path: '/lab/old-folder',
      entityType: 'folder',
      fileKind: 'folder',
      workspaceRoot: '/lab',
    });
    const file = await registerWorkspaceFile({
      path: '/lab/old-folder/seq.gb',
      entityType: 'sequence',
      fileKind: 'genbank',
      workspaceRoot: '/lab',
    });

    await rebindCatalogFilePath({
      oldPath: '/lab/old-folder',
      newPath: '/lab/new-folder',
      workspaceRoot: '/lab',
    });

    expect(await getCatalogEntityForFilePath('/lab/new-folder')).toMatchObject({ id: folder.id });
    expect(await getCatalogEntityForFilePath('/lab/new-folder/seq.gb')).toMatchObject({
      id: file.id,
      type: 'sequence',
    });
  });

  it('marks missing file bindings without deleting the entity', async () => {
    const entity = await registerWorkspaceFile({
      path: '/lab/missing.gb',
      entityType: 'sequence',
      fileKind: 'genbank',
      workspaceRoot: '/lab',
    });

    await markCatalogFileMissing('/lab/missing.gb', 'test');

    expect(await getCatalogEntity(entity.id)).toMatchObject({ id: entity.id });
    expect(await getCatalogFileForPath('/lab/missing.gb')).toMatchObject({
      status: 'missing',
      missing_since: expect.any(Number),
    });
    expect(await getCatalogEventsForEntity(entity.id)).toEqual([
      expect.objectContaining({ event_type: 'file_missing' }),
    ]);

    await markCatalogFileMissing('/lab/missing.gb', 'moved-to-trash');
    expect(
      (await getCatalogEventsForEntity(entity.id)).some(
        (event) => event.payload && JSON.parse(event.payload).reason === 'moved-to-trash'
      )
    ).toBe(true);
  });

  it('marks every known binding under a trashed folder as missing', async () => {
    const folder = await registerWorkspaceFile({
      path: '/lab/run-1',
      entityType: 'folder',
      fileKind: 'folder',
      workspaceRoot: '/lab',
    });
    const child = await registerWorkspaceFile({
      path: '/lab/run-1/alignment.bam',
      entityType: 'alignment',
      fileKind: 'alignment',
      workspaceRoot: '/lab',
    });
    const sibling = await registerWorkspaceFile({
      path: '/lab/run-2/alignment.bam',
      entityType: 'alignment',
      fileKind: 'alignment',
      workspaceRoot: '/lab',
    });

    await expect(markCatalogPathMissing('/lab/run-1', 'moved-to-trash')).resolves.toEqual({
      updated: 2,
    });

    expect(await getCatalogFileForPath('/lab/run-1')).toMatchObject({ status: 'missing' });
    expect(await getCatalogFileForPath('/lab/run-1/alignment.bam')).toMatchObject({
      status: 'missing',
    });
    expect(await getCatalogFileForPath('/lab/run-2/alignment.bam')).toMatchObject({
      entity_id: sibling.id,
      status: 'current',
    });
    expect(await getCatalogEventsForEntity(folder.id)).toEqual([
      expect.objectContaining({
        event_type: 'file_missing',
        payload: expect.stringContaining('moved-to-trash'),
      }),
    ]);
    expect(await getCatalogEventsForEntity(child.id)).toEqual([
      expect.objectContaining({
        event_type: 'file_missing',
        payload: expect.stringContaining('moved-to-trash'),
      }),
    ]);
  });

  it('preserves existing semantic target type when creating contextual links', async () => {
    const sequence = await registerWorkspaceFile({
      path: '/lab/seq.gb',
      entityType: 'sequence',
      fileKind: 'genbank',
      workspaceRoot: '/lab',
    });

    const notebook = await registerContextualCatalogEntity({
      id: 'page-beside-sequence',
      type: 'notebook',
      name: 'Beside Sequence',
      locator: 'entity://page/page-beside-sequence',
      storageType: 'database',
      workspaceRoot: '/lab',
      context: {
        targetPath: '/lab/seq.gb',
        targetKind: 'file',
        parentPath: '/lab',
      },
    });

    expect(await getCatalogEntity(sequence.id)).toMatchObject({ type: 'sequence' });
    expect(await getCatalogLinksForEntity(notebook.id)).toEqual([
      expect.objectContaining({
        relation: 'created_beside',
        target_entity_id: sequence.id,
      }),
    ]);
  });

  describe('getRecentlyEditedCatalogEntities', () => {
    it.each([
      { type: 'file' as const, kind: 'protein', path: '/ws-a/Protein.entity.json' },
      { type: 'primer' as const, kind: 'rna_oligo', path: '/ws-a/RNA.primer.json' },
    ])(
      'projects raw $kind from LIMS when catalog metadata is absent',
      async ({ type, kind, path }) => {
        const id = `home-${kind}`;
        await registerCatalogEntity({
          id,
          type,
          name: kind,
          locator: `file://${path}`,
          storageType: 'file',
          workspaceRoot: '/ws-a',
        });
        await bindCatalogEntityToFile({
          entityId: id,
          path,
          fileKind: type === 'file' ? 'waypoint-entity' : 'primer-artifact',
          workspaceRoot: '/ws-a',
          status: 'current',
        });
        await platform().db.execute('INSERT INTO lims_entity (id, kind) VALUES (?, ?)', [id, kind]);

        expect(await getRecentlyEditedCatalogEntities()).toEqual([
          expect.objectContaining({
            id,
            type,
            current_file_path: path,
            iconContext: { kind, path },
          }),
        ]);
      }
    );

    it('projects canonical RNA metadata for an explicitly included file beyond the recency cutoff', async () => {
      const path = '/ws-a/RNA.primer.json';
      await registerCatalogEntity({
        id: 'home-rna-old',
        type: 'primer',
        name: 'RNA oligo',
        locator: 'entity://primer/home-rna-old',
        storageType: 'file',
        workspaceRoot: '/ws-a',
        metadata: { entitySchema: { name: 'rna_oligo' } },
      });
      await bindCatalogEntityToFile({
        entityId: 'home-rna-old',
        path,
        fileKind: 'primer-artifact',
        workspaceRoot: '/ws-a',
        status: 'current',
      });
      await registerCatalogEntity({
        id: 'home-newer',
        type: 'design',
        name: 'Newer design',
        locator: 'entity://design/home-newer',
        storageType: 'database',
        workspaceRoot: '/ws-a',
      });
      await platform().db.execute('UPDATE catalog_entities SET updated_at = ? WHERE id = ?', [
        1,
        'home-rna-old',
      ]);
      await platform().db.execute('UPDATE catalog_entities SET updated_at = ? WHERE id = ?', [
        2,
        'home-newer',
      ]);
      const rows = await getRecentlyEditedCatalogEntities(1, [path]);
      expect(rows.find((row) => row.id === 'home-rna-old')).toMatchObject({
        current_file_path: path,
        iconContext: { kind: 'rna_oligo', path },
      });
      expect(rows.find((row) => row.id === 'home-newer')).toBeDefined();
    });

    it('pairs a readable primer name with only its current workspace-owned file binding', async () => {
      const path = '/ws-a/primers/sheet-cf5f97c9-a32a-4330-9b28-164d09c7092f-row.primer.json';
      await registerCatalogEntity({
        id: 'primer-readable',
        type: 'primer',
        name: 'Excel Forward A',
        locator: 'waypoint://primer/primer-readable',
        storageType: 'file',
        workspaceRoot: '/ws-a',
      });
      await bindCatalogEntityToFile({
        entityId: 'primer-readable',
        path,
        fileKind: 'primer-artifact',
        workspaceRoot: '/ws-a',
        status: 'current',
      });
      expect(await getRecentlyEditedCatalogEntities(10)).toEqual([
        expect.objectContaining({
          id: 'primer-readable',
          name: 'Excel Forward A',
          current_file_path: path,
        }),
      ]);
      await markCatalogPathMissing(path);
      expect(await getRecentlyEditedCatalogEntities(10)).toEqual([
        expect.objectContaining({ id: 'primer-readable', current_file_path: null }),
      ]);
      const foreign = await registerCatalogEntity({
        id: 'other-project',
        type: 'design',
        name: 'Other project',
        locator: 'entity://design/other-project',
        storageType: 'database',
        workspaceRoot: '/ws-b',
      });
      await platform().db.execute(
        'UPDATE catalog_entity_files SET status = ?, workspace_id = ? WHERE entity_id = ?',
        ['current', foreign.workspace_id, 'primer-readable']
      );
      expect(
        (await getRecentlyEditedCatalogEntities(10)).find((row) => row.id === 'primer-readable')
      ).toMatchObject({ current_file_path: null });
    });

    it('orders active non-notebook entities by updated_at DESC, with workspace name/path joined', async () => {
      const older = await registerCatalogEntity({
        id: 'design-1',
        type: 'design',
        name: 'Golden Gate assembly',
        locator: 'entity://design/design-1',
        storageType: 'database',
        workspaceRoot: '/ws-a',
      });
      const newer = await registerCatalogEntity({
        id: 'primer-1',
        type: 'primer',
        name: 'Fwd primer',
        locator: 'entity://primer/primer-1',
        storageType: 'database',
        workspaceRoot: '/ws-a',
      });
      await platform().db.execute('UPDATE catalog_entities SET updated_at = ? WHERE id = ?', [
        1000,
        older.id,
      ]);
      await platform().db.execute('UPDATE catalog_entities SET updated_at = ? WHERE id = ?', [
        2000,
        newer.id,
      ]);

      const results = await getRecentlyEditedCatalogEntities(10);

      expect(results).toEqual([
        expect.objectContaining({
          id: 'primer-1',
          type: 'primer',
          name: 'Fwd primer',
          workspace_path: '/ws-a',
          updated_at: 2000,
        }),
        expect.objectContaining({
          id: 'design-1',
          type: 'design',
          name: 'Golden Gate assembly',
          workspace_path: '/ws-a',
          updated_at: 1000,
        }),
      ]);
    });

    it('includes storage_type and locator so file-backed entities can be told apart from database-backed ones', async () => {
      await registerWorkspaceFile({
        path: '/ws-a/plasmids/pUC19.gb',
        entityType: 'sequence',
        fileKind: 'genbank',
        workspaceRoot: '/ws-a',
      });
      await registerCatalogEntity({
        id: 'design-db',
        type: 'design',
        name: 'Golden Gate assembly',
        locator: 'entity://design/design-db',
        storageType: 'database',
        workspaceRoot: '/ws-a',
      });

      const results = await getRecentlyEditedCatalogEntities(10);

      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'sequence',
            storage_type: 'file',
            locator: 'file:///ws-a/plasmids/pUC19.gb',
          }),
          expect.objectContaining({
            id: 'design-db',
            storage_type: 'database',
            locator: 'entity://design/design-db',
          }),
        ])
      );
    });

    it('excludes notebook-type entities (pages are queried separately, to avoid double-listing)', async () => {
      await registerCatalogEntity({
        id: 'nb-1',
        type: 'notebook',
        name: 'Lab notes',
        locator: 'entity://page/nb-1',
        storageType: 'database',
        workspaceRoot: '/ws-a',
      });

      expect(await getRecentlyEditedCatalogEntities(10)).toEqual([]);
    });

    it('excludes archived/missing/conflict entities', async () => {
      await registerCatalogEntity({
        id: 'design-archived',
        type: 'design',
        name: 'Old design',
        locator: 'entity://design/design-archived',
        storageType: 'database',
        workspaceRoot: '/ws-a',
        status: 'archived',
      });

      expect(await getRecentlyEditedCatalogEntities(10)).toEqual([]);
    });

    it('excludes missing and conflict status entities independently, not only archived', async () => {
      await registerCatalogEntity({
        id: 'design-missing',
        type: 'design',
        name: 'Missing',
        locator: 'entity://design/design-missing',
        storageType: 'database',
        workspaceRoot: '/ws-a',
        status: 'missing',
      });
      await registerCatalogEntity({
        id: 'design-conflict',
        type: 'design',
        name: 'Conflict',
        locator: 'entity://design/design-conflict',
        storageType: 'database',
        workspaceRoot: '/ws-a',
        status: 'conflict',
      });

      expect(await getRecentlyEditedCatalogEntities(10)).toEqual([]);
    });

    it('excludes entities whose workspace has been archived or trashed', async () => {
      await registerCatalogEntity({
        id: 'design-active-ws',
        type: 'design',
        name: 'In an active workspace',
        locator: 'entity://design/design-active-ws',
        storageType: 'database',
        workspaceRoot: '/ws-active',
      });
      await registerCatalogEntity({
        id: 'design-archived-ws',
        type: 'design',
        name: 'In an archived workspace',
        locator: 'entity://design/design-archived-ws',
        storageType: 'database',
        workspaceRoot: '/ws-archived',
      });
      await registerCatalogEntity({
        id: 'design-trashed-ws',
        type: 'design',
        name: 'In a trashed workspace',
        locator: 'entity://design/design-trashed-ws',
        storageType: 'database',
        workspaceRoot: '/ws-trashed',
      });
      await platform().db.execute('UPDATE workspaces SET archived_at = ? WHERE path = ?', [
        1700,
        '/ws-archived',
      ]);
      await platform().db.execute('UPDATE workspaces SET trashed_at = ? WHERE path = ?', [
        1700,
        '/ws-trashed',
      ]);

      const results = await getRecentlyEditedCatalogEntities(10);

      expect(results.map((r) => r.id)).toEqual(['design-active-ws']);
    });

    it('excludes every catalog entity owned by a reference workspace', async () => {
      await registerCatalogEntity({
        id: 'future-reference-entity',
        type: 'report',
        name: 'Reference report',
        locator: 'entity://report/future-reference-entity',
        storageType: 'database',
        workspaceRoot: '/ws-reference',
        workspaceAccess: 'reference',
      });
      await registerCatalogEntity({
        id: 'writable-design',
        type: 'design',
        name: 'Writable design',
        locator: 'entity://design/writable-design',
        storageType: 'database',
        workspaceRoot: '/ws-writable',
      });

      const results = await getRecentlyEditedCatalogEntities(10);

      expect(results.map((result) => result.id)).toEqual(['writable-design']);
    });

    it('clamps limit to a floor of 1 when zero or a negative number is passed', async () => {
      await registerCatalogEntity({
        id: 'design-1',
        type: 'design',
        name: 'A',
        locator: 'entity://design/design-1',
        storageType: 'database',
        workspaceRoot: '/ws-a',
      });
      await registerCatalogEntity({
        id: 'design-2',
        type: 'design',
        name: 'B',
        locator: 'entity://design/design-2',
        storageType: 'database',
        workspaceRoot: '/ws-a',
      });

      expect(await getRecentlyEditedCatalogEntities(0)).toHaveLength(1);
      expect(await getRecentlyEditedCatalogEntities(-5)).toHaveLength(1);
    });

    it('clamps limit to a ceiling of 100 when a value above the max is passed', async () => {
      for (let i = 0; i < 105; i++) {
        await registerCatalogEntity({
          id: `design-${i}`,
          type: 'design',
          name: `Design ${i}`,
          locator: `entity://design/design-${i}`,
          storageType: 'database',
          workspaceRoot: '/ws-a',
        });
      }

      expect(await getRecentlyEditedCatalogEntities(500)).toHaveLength(100);
    });

    it('floors a fractional limit down to an integer', async () => {
      for (const id of ['d1', 'd2', 'd3', 'd4', 'd5']) {
        await registerCatalogEntity({
          id,
          type: 'design',
          name: id,
          locator: `entity://design/${id}`,
          storageType: 'database',
          workspaceRoot: '/ws-a',
        });
      }

      expect(await getRecentlyEditedCatalogEntities(2.7)).toHaveLength(2);
    });

    it('defaults to a limit of 10 when no argument is passed', async () => {
      for (let i = 0; i < 12; i++) {
        await registerCatalogEntity({
          id: `design-${i}`,
          type: 'design',
          name: `Design ${i}`,
          locator: `entity://design/design-${i}`,
          storageType: 'database',
          workspaceRoot: '/ws-a',
        });
      }

      expect(await getRecentlyEditedCatalogEntities()).toHaveLength(10);
    });

    it('treats a NaN limit as invalid and falls back to the default, rather than silently returning nothing', async () => {
      await registerCatalogEntity({
        id: 'design-1',
        type: 'design',
        name: 'A',
        locator: 'entity://design/design-1',
        storageType: 'database',
        workspaceRoot: '/ws-a',
      });

      expect(await getRecentlyEditedCatalogEntities(Number('not-a-number'))).toHaveLength(1);
    });

    it('truncates to the limit, keeping the most recently updated entities when active entities exceed it', async () => {
      const ids = ['d1', 'd2', 'd3', 'd4', 'd5'];
      for (const id of ids) {
        await registerCatalogEntity({
          id,
          type: 'design',
          name: id,
          locator: `entity://design/${id}`,
          storageType: 'database',
          workspaceRoot: '/ws-a',
        });
      }
      for (let i = 0; i < ids.length; i++) {
        await platform().db.execute('UPDATE catalog_entities SET updated_at = ? WHERE id = ?', [
          (i + 1) * 1000,
          ids[i],
        ]);
      }

      const results = await getRecentlyEditedCatalogEntities(2);

      expect(results.map((r) => r.id)).toEqual(['d5', 'd4']);
    });

    it('resolves a dangling workspace_id (workspace row purged, e.g. after trash retention expiry) to null name/path without throwing', async () => {
      const entity = await registerCatalogEntity({
        id: 'design-orphan',
        type: 'design',
        name: 'Orphaned',
        locator: 'entity://design/design-orphan',
        storageType: 'database',
        workspaceRoot: '/ws-orphan',
      });

      await platform().db.execute('DELETE FROM workspaces WHERE id = ?', [entity.workspace_id]);

      const results = await getRecentlyEditedCatalogEntities(10);

      expect(results).toEqual([
        expect.objectContaining({
          id: 'design-orphan',
          workspace_id: entity.workspace_id,
          workspace_name: null,
          workspace_path: null,
        }),
      ]);
    });

    it('resolves a null workspace_id (entity registered with no workspace root) to null name/path', async () => {
      await registerCatalogEntity({
        id: 'design-contextless',
        type: 'design',
        name: 'No workspace',
        locator: 'entity://design/design-contextless',
        storageType: 'database',
      });

      const results = await getRecentlyEditedCatalogEntities(10);

      expect(results).toEqual([
        expect.objectContaining({
          id: 'design-contextless',
          workspace_id: null,
          workspace_name: null,
          workspace_path: null,
        }),
      ]);
    });

    it('attributes each entity to its OWN workspace when multiple workspaces are present', async () => {
      await registerCatalogEntity({
        id: 'design-a',
        type: 'design',
        name: 'In A',
        locator: 'entity://design/design-a',
        storageType: 'database',
        workspaceRoot: '/ws-a',
      });
      await registerCatalogEntity({
        id: 'design-b',
        type: 'design',
        name: 'In B',
        locator: 'entity://design/design-b',
        storageType: 'database',
        workspaceRoot: '/ws-b',
      });

      const results = await getRecentlyEditedCatalogEntities(10);

      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'design-a', workspace_path: '/ws-a' }),
          expect.objectContaining({ id: 'design-b', workspace_path: '/ws-b' }),
        ])
      );
    });
  });
});

describe('inferCatalogFileKind — plasmid packages ', () => {
  it('recognizes the plasmid package meta path', () => {
    expect(inferCatalogFileKind('/lab/pMyConstruct/.forge/plasmid.json')).toBe('waypoint-sequence');
  });

  it('does not confuse the two package kinds', () => {
    expect(inferCatalogFileKind('/lab/Lab notes/.forge/notebook.json')).toBe('waypoint-notebook');
  });

  it('leaves the GenBank INSIDE a package classified as genbank', () => {
    expect(inferCatalogFileKind('/lab/pMyConstruct/pMyConstruct.gb')).toBe('genbank');
  });
});

describe('the durable object id must survive a move the app did not perform', () => {
  const HASH = 'sha256:aaaa';

  async function seedAt(path: string, contentHash: string): Promise<string> {
    await registerCatalogEntity({
      id: `ent-${path}`,
      type: 'sequence',
      name: 'seq',
      locator: `file://${path}`,
      storageType: 'file',
      workspaceRoot: '/w',
    });
    await bindCatalogEntityToFile({
      entityId: `ent-${path}`,
      path,
      workspaceRoot: '/w',
      contentHash,
      objectUuid: `object:${path}`,
    });
    const before = await getCatalogFileForPath(path);
    return before!.object_uuid!;
  }

  async function seedMissingAt(path: string, contentHash: string): Promise<string> {
    const objectUuid = await seedAt(path, contentHash);
    await markCatalogPathMissing(path, 'gone');
    return objectUuid;
  }

  it('adopts the id of the missing row whose content it matches', async () => {
    const original = await seedMissingAt('/w/old.gb', HASH);

    await registerWorkspaceFile({
      path: '/w/moved/new.gb',
      entityType: 'sequence',
      workspaceRoot: '/w',
      contentHash: HASH,
    });

    const moved = await getCatalogFileForPath('/w/moved/new.gb');
    expect(moved?.object_uuid).toBe(original);
    expect(await getCatalogFileForPath('/w/old.gb')).toBeNull();
  });

  it('mints fresh when TWO missing rows share that content', async () => {
    await seedAt('/w/a.gb', HASH);
    const second = await seedAt('/w/b.gb', HASH);
    await markCatalogPathMissing('/w/a.gb', 'gone');
    await markCatalogPathMissing('/w/b.gb', 'gone');

    await registerCatalogEntity({
      id: 'ent-amb',
      type: 'sequence',
      name: 'seq',
      locator: 'file:///w/moved/c.gb',
      storageType: 'file',
      workspaceRoot: '/w',
    });
    await bindCatalogEntityToFile({
      entityId: 'ent-amb',
      path: '/w/moved/c.gb',
      workspaceRoot: '/w',
      contentHash: HASH,
    });

    const moved = await getCatalogFileForPath('/w/moved/c.gb');
    expect(moved?.object_uuid).not.toBe(second);
    expect(moved?.object_uuid).toBeTruthy();
  });

  it('never adopts from a row that is still LIVE — that is a copy, not a move', async () => {
    await registerCatalogEntity({
      id: 'ent-live',
      type: 'sequence',
      name: 'seq',
      locator: 'file:///w/live.gb',
      storageType: 'file',
      workspaceRoot: '/w',
    });
    await bindCatalogEntityToFile({
      entityId: 'ent-live',
      path: '/w/live.gb',
      workspaceRoot: '/w',
      contentHash: HASH,
      objectUuid: 'object:/w/live.gb',
    });
    const live = await getCatalogFileForPath('/w/live.gb');

    await registerCatalogEntity({
      id: 'ent-copy',
      type: 'sequence',
      name: 'seq',
      locator: 'file:///w/copy.gb',
      storageType: 'file',
      workspaceRoot: '/w',
    });
    await bindCatalogEntityToFile({
      entityId: 'ent-copy',
      path: '/w/copy.gb',
      workspaceRoot: '/w',
      contentHash: HASH,
    });

    const copy = await getCatalogFileForPath('/w/copy.gb');
    expect(copy?.object_uuid).not.toBe(live?.object_uuid);
  });

  it('never crosses the git:/sha256: namespace', async () => {
    await seedMissingAt('/w/g.gb', 'git:abcd');

    await registerCatalogEntity({
      id: 'ent-ns',
      type: 'sequence',
      name: 'seq',
      locator: 'file:///w/moved/g.gb',
      storageType: 'file',
      workspaceRoot: '/w',
    });
    await bindCatalogEntityToFile({
      entityId: 'ent-ns',
      path: '/w/moved/g.gb',
      workspaceRoot: '/w',
      contentHash: 'sha256:abcd',
    });

    const moved = await getCatalogFileForPath('/w/moved/g.gb');
    const old = await getCatalogFileForPath('/w/g.gb');
    expect(moved?.object_uuid).not.toBe(old?.object_uuid);
  });
});
