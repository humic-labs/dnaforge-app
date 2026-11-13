import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CollectionProjection, NativeCollectionDocument } from './collection-projection';
import {
  nativeCollectionDocumentPath,
  nativeFolderPathMap,
  preserveNativeFolderPlacements,
  readCollectionProjection,
  writeCollectionProjection,
} from './collection-projection-writer';

describe('nativeFolderPathMap', () => {
  it('preserves an existing physical placement independently of current sibling count', () => {
    const survivor = folder('folder-bbbbbbbbbbbbbbbbbbbbbbbb', 'PCR* results');
    const current = {
      entities: [
        {
          id: survivor.id,
          type: 'folder',
          placement: {
            kind: 'file',
            relativePath: 'Root/PCR_ results-bbbbbbbb',
            fileKind: 'folder',
          },
        },
      ],
    } as const;
    const updated = preserveNativeFolderPlacements(projection([survivor]), current.entities);
    expect(nativeFolderPathMap(updated, 'native-v2').get(survivor.id)).toBe(
      'Root/PCR_ results-bbbbbbbb'
    );
  });
  it('preserves existing folder marker identity and refuses to overwrite edited marker bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collection-marker-preservation-'));
    try {
      const input = {
        workspacePath: root,
        projection: projection([folder('folder-aaaaaaaaaaaaaaaaaaaaaaaa', 'Existing')]),
        layout: 'native-v2' as const,
      };
      await writeCollectionProjection(input);
      const marker = join(root, 'Existing/.gitkeep');
      const before = await stat(marker);
      await writeCollectionProjection(input);
      const after = await stat(marker);
      expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({
        ino: before.ino,
        mtimeMs: before.mtimeMs,
      });
      await writeFile(marker, 'User-owned contents');
      await expect(writeCollectionProjection(input)).rejects.toThrow(/marker/);
      expect(await readFile(marker, 'utf8')).toBe('User-owned contents');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('uses exact readable folder names when siblings are unique', () => {
    const paths = nativeFolderPathMap(
      projection([
        folder('folder-aaaaaaaaaaaaaaaaaaaaaaaa', 'Characterization'),
        folder('folder-bbbbbbbbbbbbbbbbbbbbbbbb', 'Protocols'),
      ])
    );

    expect(paths).toEqual(
      new Map([
        ['folder-aaaaaaaaaaaaaaaaaaaaaaaa', 'Benchling Imports/Folders/Characterization'],
        ['folder-bbbbbbbbbbbbbbbbbbbbbbbb', 'Benchling Imports/Folders/Protocols'],
      ])
    );
  });

  it('does not delete an edited marker when a collection is removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collection-marker-removal-'));
    try {
      const original = projection([folder('folder-aaaaaaaaaaaaaaaaaaaaaaaa', 'Existing')]);
      await writeCollectionProjection({
        workspacePath: root,
        projection: original,
        layout: 'native-v2',
      });
      const marker = join(root, 'Existing/.gitkeep');
      await writeFile(marker, 'User-owned contents');
      await expect(
        writeCollectionProjection({
          workspacePath: root,
          projection: projection([]),
          layout: 'native-v2',
        })
      ).rejects.toThrow(/marker/);
      expect(await readFile(marker, 'utf8')).toBe('User-owned contents');
      expect(await readCollectionProjection(root)).toEqual(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('adds a stable suffix only when sibling names collide after sanitization', () => {
    const paths = nativeFolderPathMap(
      projection([
        folder('folder-aaaaaaaaaaaaaaaaaaaaaaaa', 'PCR: results'),
        folder('folder-bbbbbbbbbbbbbbbbbbbbbbbb', 'PCR/ results'),
      ])
    );

    expect(paths).toEqual(
      new Map([
        ['folder-aaaaaaaaaaaaaaaaaaaaaaaa', 'Benchling Imports/Folders/PCR_ results-aaaaaaaa'],
        ['folder-bbbbbbbbbbbbbbbbbbbbbbbb', 'Benchling Imports/Folders/PCR_ results-bbbbbbbb'],
      ])
    );
  });

  it('does not treat matching names under different parents as a collision', () => {
    const paths = nativeFolderPathMap(
      projection([
        folder('folder-aaaaaaaaaaaaaaaaaaaaaaaa', 'Lab A'),
        folder('folder-bbbbbbbbbbbbbbbbbbbbbbbb', 'Lab B'),
        folder('folder-cccccccccccccccccccccccc', 'Results', 'folder-aaaaaaaaaaaaaaaaaaaaaaaa'),
        folder('folder-dddddddddddddddddddddddd', 'Results', 'folder-bbbbbbbbbbbbbbbbbbbbbbbb'),
      ])
    );

    expect(paths.get('folder-cccccccccccccccccccccccc')).toBe(
      'Benchling Imports/Folders/Lab A/Results'
    );
    expect(paths.get('folder-dddddddddddddddddddddddd')).toBe(
      'Benchling Imports/Folders/Lab B/Results'
    );
  });

  it('uses the provider hierarchy directly for native v2 collections', () => {
    const root = folder('folder-aaaaaaaaaaaaaaaaaaaaaaaa', 'Selected Root');
    const child = folder(
      'folder-bbbbbbbbbbbbbbbbbbbbbbbb',
      'Alpha',
      'folder-aaaaaaaaaaaaaaaaaaaaaaaa'
    );
    root.childCollectionIds = [child.id];

    expect(nativeFolderPathMap(projection([root, child]), 'native-v2')).toEqual(
      new Map([
        [root.id, 'Selected Root'],
        [child.id, 'Selected Root/Alpha'],
      ])
    );
    expect(nativeCollectionDocumentPath(root, 'native-v2')).toBe(
      `.dnaforge/migration/collections/${root.id}.json`
    );
  });

  it('rewrites and reads back one merged nested collection graph', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'collection-projection-writer-'));
    try {
      const root = folder('folder-aaaaaaaaaaaaaaaaaaaaaaaa', 'Selected Root');
      const child = folder(
        'folder-bbbbbbbbbbbbbbbbbbbbbbbb',
        'Alpha',
        'folder-aaaaaaaaaaaaaaaaaaaaaaaa'
      );
      root.childCollectionIds = [child.id];
      const merged = projection([root, child]);

      await writeCollectionProjection({ workspacePath, projection: projection([root]) });
      const written = await writeCollectionProjection({ workspacePath, projection: merged });

      expect(await readCollectionProjection(workspacePath)).toEqual(merged);
      expect(written.nativeFolderPaths).toEqual([
        'Benchling Imports/Folders/Selected Root',
        'Benchling Imports/Folders/Selected Root/Alpha',
      ]);
      expect(
        await readFile(
          join(workspacePath, 'Benchling Imports/Folders/Selected Root/Alpha/.gitkeep'),
          'utf8'
        )
      ).toBe('');
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it('removes stale machine-owned collection files when authority contracts', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'collection-projection-writer-'));
    try {
      const root = folder('folder-aaaaaaaaaaaaaaaaaaaaaaaa', 'Selected Root');
      const child = folder(
        'folder-bbbbbbbbbbbbbbbbbbbbbbbb',
        'Alpha',
        'folder-aaaaaaaaaaaaaaaaaaaaaaaa'
      );
      root.childCollectionIds = [child.id];
      await writeCollectionProjection({ workspacePath, projection: projection([root, child]) });
      root.childCollectionIds = [];

      await writeCollectionProjection({ workspacePath, projection: projection([root]) });

      await expect(
        readFile(join(workspacePath, nativeCollectionDocumentPath(child)), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        readFile(
          join(workspacePath, 'Benchling Imports/Folders/Selected Root/Alpha/.gitkeep'),
          'utf8'
        )
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});

function folder(
  id: string,
  title: string,
  parentCollectionId: string | null = null
): NativeCollectionDocument {
  return {
    schema: 'dnaforge.collection.v1',
    kind: 'collection',
    id,
    title,
    editable: true,
    parentCollectionId,
    childCollectionIds: [],
    memberObjectIds: [],
    excludedChildFolders: [],
    provenance: {
      immutableSource: true,
      provider: 'benchling',
      sourceAccountHash: 'account-hash',
      sourceFolderId: id,
      sourceUrl: `https://example.benchling.com/folders/${id}`,
      sourceParentFolderId: null,
      selectedRoot: parentCollectionId === null,
      capturedAt: '2026-08-17T00:00:00.000Z',
    },
  };
}

function projection(collections: NativeCollectionDocument[]): CollectionProjection {
  return {
    schema: 'dnaforge.collection-projection.v1',
    scopeKind: 'folder_tree',
    sourceAccountHash: 'account-hash',
    selectedRootSourceIds: [],
    selectedSourceObjectIds: [],
    oneHopDependencySourceObjectIds: [],
    collections,
    objectMemberships: [],
  };
}
