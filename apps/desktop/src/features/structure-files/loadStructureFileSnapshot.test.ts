import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Structure3dAttrs } from '../page/embeds/structure3d/types';

const { mockReadTextFile, mockReadFile, mockGetCurrentCatalogFileForEntity } = vi.hoisted(() => ({
  mockReadTextFile: vi.fn(),
  mockReadFile: vi.fn(),
  mockGetCurrentCatalogFileForEntity: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    fs: { readTextFile: mockReadTextFile, readFile: mockReadFile },
  }),
}));

vi.mock('../../db/workspace-catalog', () => ({
  getCurrentCatalogFileForEntity: mockGetCurrentCatalogFileForEntity,
}));

import {
  loadStructureFileSnapshot,
  structureFileSnapshotLocatorFromAttrs,
} from './loadStructureFileSnapshot';
import {
  acquireStructureFileSnapshotLease,
  clearStructureFileSnapshotsForTests,
  getStructureFileSnapshot,
  getStructureFileSnapshotCacheDiagnostics,
  registerStructureFileSnapshot,
} from './structure-file-snapshots';

async function sha256(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function attrsFor(
  data: string | Uint8Array,
  format: 'pdb' | 'mmcif' | 'binary-cif' = 'pdb'
): Promise<Structure3dAttrs> {
  const digest = await sha256(data);
  return {
    source: 'file',
    sourceId: '/old/path/1FS0.pdb',
    coordinateFilePath: '/old/path/1FS0.pdb',
    structureViewIdentity: { schemaVersion: 1, structureViewId: `view:${digest}`, bindingId: null },
    structureArtifactRef: {
      entityId: 'catalog-1fs0',
      revisionId: `revision:${digest}`,
      structureId: `structure:${digest}`,
      coordinateDigestSha256: digest,
      artifactPath: '/old/path/1FS0.pdb',
      format,
    },
  };
}

describe('loadStructureFileSnapshot', () => {
  beforeEach(() => {
    clearStructureFileSnapshotsForTests();
    mockReadTextFile.mockReset();
    mockReadFile.mockReset();
    mockGetCurrentCatalogFileForEntity.mockReset().mockResolvedValue(null);
  });

  it('reuses the ephemeral open snapshot without another filesystem read', async () => {
    const text = 'HEADER TEST\nATOM 1\nEND\n';
    const attrs = await attrsFor(text);
    const viewId = attrs.structureViewIdentity!.structureViewId;
    registerStructureFileSnapshot({
      structureViewId: viewId,
      revisionId: attrs.structureArtifactRef!.revisionId,
      filePath: '/old/path/1FS0.pdb',
      coordinateDigestSha256: attrs.structureArtifactRef!.coordinateDigestSha256,
      parser: 'pdb',
      encoding: 'text',
      data: text,
    });

    await expect(
      loadStructureFileSnapshot(structureFileSnapshotLocatorFromAttrs(attrs), [])
    ).resolves.toBe(getStructureFileSnapshot(viewId));
    expect(mockReadTextFile).not.toHaveBeenCalled();
  });

  it('rehydrates from the catalog current path after rename and verifies the pinned digest', async () => {
    const text = 'HEADER TEST\nATOM 1\nEND\n';
    const attrs = await attrsFor(text);
    mockGetCurrentCatalogFileForEntity.mockResolvedValue({ path: '/lab/renamed/complex.pdb' });
    mockReadTextFile.mockResolvedValue(text);

    const snapshot = await loadStructureFileSnapshot(structureFileSnapshotLocatorFromAttrs(attrs), [
      { path: '/lab' },
    ]);

    expect(mockReadTextFile).toHaveBeenCalledWith('/lab/renamed/complex.pdb');
    expect(snapshot).toMatchObject({
      filePath: '/lab/renamed/complex.pdb',
      parser: 'pdb',
      encoding: 'text',
      data: text,
    });
  });

  it('does not retain bytes when the owning tab closes during the filesystem read', async () => {
    const text = 'HEADER TEST\nATOM 1\nEND\n';
    const attrs = await attrsFor(text);
    const viewId = attrs.structureViewIdentity!.structureViewId;
    let finishRead: (value: string) => void = () => undefined;
    mockReadTextFile.mockReturnValue(
      new Promise<string>((resolve) => {
        finishRead = resolve;
      })
    );
    const lease = acquireStructureFileSnapshotLease(viewId);

    const pending = loadStructureFileSnapshot(
      structureFileSnapshotLocatorFromAttrs(attrs),
      [],
      lease
    );
    lease.release();
    finishRead(text);
    await pending;

    expect(getStructureFileSnapshotCacheDiagnostics()).toEqual({
      viewIds: [],
      leasedViewIds: [],
      inactiveBytes: 0,
      registrationSequence: 0,
    });
  });

  it('rejects changed bytes instead of silently mutating a pinned view', async () => {
    const attrs = await attrsFor('HEADER ORIGINAL\nATOM 1\nEND\n');
    mockReadTextFile.mockResolvedValue('HEADER CHANGED\nATOM 1\nEND\n');

    await expect(
      loadStructureFileSnapshot(structureFileSnapshotLocatorFromAttrs(attrs), [])
    ).rejects.toMatchObject({
      code: 'revision-changed',
    });
  });

  it('rejects empty and generic non-macromolecular CIF input before mounting Molstar', async () => {
    const emptyAttrs = await attrsFor('', 'mmcif');
    mockReadTextFile.mockResolvedValue('');
    await expect(
      loadStructureFileSnapshot(structureFileSnapshotLocatorFromAttrs(emptyAttrs), [])
    ).rejects.toMatchObject({
      code: 'empty-file',
    });

    const generic = 'data_small_molecule\n_cell.length_a 12.0\n#\n';
    const genericAttrs = await attrsFor(generic, 'mmcif');
    mockReadTextFile.mockResolvedValue(generic);
    await expect(
      loadStructureFileSnapshot(structureFileSnapshotLocatorFromAttrs(genericAttrs), [])
    ).rejects.toMatchObject({
      code: 'unsupported-cif',
    });
  });

  it('rehydrates BinaryCIF as bytes with an explicit mmCIF parser', async () => {
    const bytes = new Uint8Array([131, 165, 100, 97, 116, 97, 1, 2, 3]);
    const attrs = await attrsFor(bytes, 'binary-cif');
    mockReadFile.mockResolvedValue(bytes);

    const snapshot = await loadStructureFileSnapshot(
      structureFileSnapshotLocatorFromAttrs(attrs),
      []
    );

    expect(mockReadFile).toHaveBeenCalledWith('/old/path/1FS0.pdb');
    expect(mockReadTextFile).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({ parser: 'mmcif', encoding: 'binary', data: bytes });
  });
});
