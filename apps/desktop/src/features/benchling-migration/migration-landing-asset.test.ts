// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import {
  parseBenchlingMigrationLandingAsset,
  resolveBenchlingMigrationLandingAsset,
} from './migration-landing-asset';

const nativeCatalog = {
  schema: 'dnaforge.native-workspace-manifest.v1',
  entities: [
    {
      id: 'folder-root',
      type: 'folder',
      name: 'ARBR Lab Notebook',
      path: 'Benchling Imports/Folders/ARBR Lab Notebook',
      fileKind: 'folder',
      metadata: { selectedRoot: true },
    },
    {
      id: 'folder-child',
      type: 'folder',
      name: 'Experiments',
      path: 'Benchling Imports/Folders/ARBR Lab Notebook/Experiments',
      fileKind: 'folder',
    },
    {
      id: 'notebook-pcr',
      type: 'notebook',
      name: 'PCR optimization',
      path: 'Benchling Imports/Notebooks/PCR optimization',
      fileKind: 'waypoint-notebook',
    },
  ],
  links: [
    { sourceId: 'folder-root', relation: 'contains', targetId: 'folder-child' },
    { sourceId: 'folder-child', relation: 'contains', targetId: 'notebook-pcr' },
  ],
};

describe('Benchling migration landing asset', () => {
  it('uses the current receipt source even when an older workspace has notebooks', () => {
    const manifest = {
      schema: 'dnaforge.native-workspace-manifest.v2',
      entities: [
        {
          id: 'old-notebook',
          type: 'notebook',
          name: 'Old notebook',
          placement: {
            kind: 'package',
            rootRelativePath: 'Old notebook',
            primaryRelativePath: 'Old notebook/.forge/notebook.json',
            fileKind: 'waypoint-notebook',
          },
          migrationSource: {
            historyRunId: 'run',
            sourceId: 'external-zip-aaaaaaaaaaaaaaaaaaaaaaaa',
            sourceObjectId: 'etr_OLD001',
          },
        },
        {
          id: 'new-sequence',
          type: 'sequence',
          name: 'Incoming sequence',
          placement: { kind: 'file', relativePath: 'Incoming.gb', fileKind: 'genbank' },
          migrationSource: {
            historyRunId: 'run',
            sourceId: 'external-zip-bbbbbbbbbbbbbbbbbbbbbbbb',
            sourceObjectId: 'seq_NEW001',
          },
        },
      ],
      links: [],
    };
    expect(
      parseBenchlingMigrationLandingAsset(JSON.stringify(manifest), [
        'external-zip-bbbbbbbbbbbbbbbbbbbbbbbb',
      ])
    ).toMatchObject({ kind: 'sequence', revealRelativePath: 'Incoming.gb' });
    expect(
      parseBenchlingMigrationLandingAsset(JSON.stringify(manifest), ['missing-zip'])
    ).toBeNull();
  });
  it('opens a native notebook reached through native folder links', () => {
    expect(parseBenchlingMigrationLandingAsset(JSON.stringify(nativeCatalog))).toEqual({
      kind: 'notebook',
      openRelativePath: 'Benchling Imports/Notebooks/PCR optimization/.forge/notebook.json',
      revealRelativePath: 'Benchling Imports/Notebooks/PCR optimization',
      label: 'PCR optimization',
    });
  });

  it('falls back to the first native notebook when a selected root is absent', () => {
    const manifest = {
      ...nativeCatalog,
      entities: nativeCatalog.entities.map((entity) => ({
        ...entity,
        ...(entity.metadata ? { metadata: {} } : {}),
      })),
      links: [],
    };
    expect(parseBenchlingMigrationLandingAsset(JSON.stringify(manifest))).toMatchObject({
      kind: 'notebook',
      openRelativePath: 'Benchling Imports/Notebooks/PCR optimization/.forge/notebook.json',
      revealRelativePath: 'Benchling Imports/Notebooks/PCR optimization',
      label: 'PCR optimization',
    });
  });

  it('opens the newest imported notebook when a workspace contains earlier migrations', () => {
    const manifest = {
      ...nativeCatalog,
      entities: [
        ...nativeCatalog.entities,
        {
          id: 'folder-appended',
          type: 'folder',
          name: 'Appended Root',
          path: 'Benchling Imports/Folders/Appended Root',
          fileKind: 'folder',
          metadata: { selectedRoot: true },
        },
        {
          id: 'notebook-new',
          type: 'notebook',
          name: 'Deep notebook',
          path: 'Benchling Imports/Notebooks/Deep notebook',
          fileKind: 'waypoint-notebook',
        },
      ],
      links: [
        ...nativeCatalog.links,
        { sourceId: 'folder-appended', relation: 'contains', targetId: 'notebook-new' },
      ],
      events: [
        {
          id: 'old-import',
          entityId: 'notebook-pcr',
          eventType: 'imported',
          actor: 'migration',
          createdAt: 1,
        },
        {
          id: 'new-import',
          entityId: 'notebook-new',
          eventType: 'imported',
          actor: 'migration',
          createdAt: 1,
        },
      ],
    };

    expect(parseBenchlingMigrationLandingAsset(JSON.stringify(manifest))).toEqual({
      kind: 'notebook',
      openRelativePath: 'Benchling Imports/Notebooks/Deep notebook/.forge/notebook.json',
      revealRelativePath: 'Benchling Imports/Notebooks/Deep notebook',
      label: 'Deep notebook',
    });
  });

  it('opens the newest imported sequence when the migration contains no notebooks', () => {
    const manifest = {
      schema: 'dnaforge.native-workspace-manifest.v1',
      entities: [
        {
          id: 'folder-root',
          type: 'folder',
          name: 'Imported collection',
          path: 'Benchling Imports/Collections/imported-collection',
          fileKind: 'folder',
          metadata: { selectedRoot: true },
        },
        {
          id: 'sequence-old',
          type: 'sequence',
          name: 'Older plasmid',
          path: 'Benchling Imports/Older_plasmid/Older_plasmid.gb',
          fileKind: 'genbank',
        },
        {
          id: 'sequence-new',
          type: 'sequence',
          name: 'pGAL7.tRNA-Gly.BFP-gRNA.HDV.Term',
          path:
            'Benchling Imports/pGAL7.tRNA-Gly.BFP-gRNA.HDV.Term__d60de2f21f07aa72/' +
            'pGAL7.tRNA-Gly.BFP-gRNA.HDV.Term__d60de2f21f07aa72.gb',
          fileKind: 'genbank',
        },
      ],
      links: [
        { sourceId: 'folder-root', relation: 'contains', targetId: 'sequence-old' },
        { sourceId: 'folder-root', relation: 'contains', targetId: 'sequence-new' },
      ],
      events: [
        {
          id: 'old-import',
          entityId: 'sequence-old',
          eventType: 'imported',
          actor: 'migration',
          createdAt: 1,
        },
        {
          id: 'new-import',
          entityId: 'sequence-new',
          eventType: 'imported',
          actor: 'migration',
          createdAt: 1,
        },
      ],
    };

    expect(parseBenchlingMigrationLandingAsset(JSON.stringify(manifest))).toEqual({
      kind: 'sequence',
      openRelativePath:
        'Benchling Imports/pGAL7.tRNA-Gly.BFP-gRNA.HDV.Term__d60de2f21f07aa72/' +
        'pGAL7.tRNA-Gly.BFP-gRNA.HDV.Term__d60de2f21f07aa72.gb',
      revealRelativePath:
        'Benchling Imports/pGAL7.tRNA-Gly.BFP-gRNA.HDV.Term__d60de2f21f07aa72/' +
        'pGAL7.tRNA-Gly.BFP-gRNA.HDV.Term__d60de2f21f07aa72.gb',
      label: 'pGAL7.tRNA-Gly.BFP-gRNA.HDV.Term',
    });
  });

  it('rejects malformed manifests and unsafe paths', () => {
    expect(parseBenchlingMigrationLandingAsset('{')).toBeNull();
    expect(
      parseBenchlingMigrationLandingAsset(
        JSON.stringify({
          ...nativeCatalog,
          entities: nativeCatalog.entities.map((entity) =>
            entity.id === 'notebook-pcr' ? { ...entity, path: '../../outside-workspace' } : entity
          ),
        })
      )
    ).toBeNull();
  });

  it('reads the portable native catalog and fails safely when absent', async () => {
    const readTextFile = vi.fn().mockResolvedValue(JSON.stringify(nativeCatalog));

    await expect(
      resolveBenchlingMigrationLandingAsset('/managed/workspace/', readTextFile)
    ).resolves.toMatchObject({ label: 'PCR optimization' });
    expect(readTextFile).toHaveBeenCalledWith('/managed/workspace/.forge/catalog.json');

    await expect(
      resolveBenchlingMigrationLandingAsset('/managed/workspace', async () => {
        throw new Error('missing');
      })
    ).resolves.toBeNull();
  });
});
