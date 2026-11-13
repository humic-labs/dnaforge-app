import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../main/__tests__/test-db';

const mocks = vi.hoisted(() => ({ select: vi.fn(), resolve: vi.fn(), findById: vi.fn() }));
vi.mock('../../platform', () => ({ platform: () => ({ db: { select: mocks.select } }) }));
vi.mock('./managed-sequence-repository', () => ({
  managedSequenceRepository: { resolve: mocks.resolve, findById: mocks.findById },
}));

import {
  resolveSequenceDocument,
  resolveSequenceDocumentById,
} from './sequence-document-repository';

const ref = {
  kind: 'managed-sequence' as const,
  packageId: 'sample-4e461e72',
  packageRoot: '/projects/ytk/pYTK009',
};
const file = {
  entity_id: ref.packageId,
  path: ref.packageRoot,
  file_kind: 'waypoint-sequence',
  status: 'current',
};

describe('sequence document identity resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.select.mockResolvedValue([file]);
    mocks.findById.mockResolvedValue(null);
    mocks.resolve.mockResolvedValue({
      ref,
      document: { id: ref.packageId, name: 'pYTK009' },
      productPath: `${ref.packageRoot}/pYTK009.gb`,
    });
  });

  it('reads a source-preview locator independently of application inventory', async () => {
    const preview = {
      kind: 'import-source-sequence' as const,
      documentId: 'preview-document-id',
      sourcePath: '/developer/wp-assets/reference.gb',
    };
    await expect(resolveSequenceDocument(preview)).resolves.toEqual({
      ref: preview,
      documentId: preview.documentId,
      sourcePath: preview.sourcePath,
    });
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each([ref.packageId, '8bbe96e2-d3c3-4fd6-9393-759d5741cffd'])(
    'resolves existing catalog/legacy reference %s as the current managed package',
    async (entityId) => {
      const result = await resolveSequenceDocument({ kind: 'catalog-sequence', entityId });
      expect(result).toEqual({
        ref,
        documentId: ref.packageId,
        sourcePath: `${ref.packageRoot}/pYTK009.gb`,
        name: 'pYTK009',
      });
      expect(mocks.resolve).toHaveBeenCalledWith(ref, {});
      const [sql, params] = mocks.select.mock.calls[0];
      expect(sql).toContain('object_uuid');
      expect(sql).toContain("f.status = 'current'");
      expect(params).toContain(entityId);
    }
  );

  it('uses the catalog identity before scanning unrelated project packages', async () => {
    await expect(
      resolveSequenceDocumentById(ref.packageId, ['/unrelated', '/projects/ytk'], {
        mutationToken: 'mount-mutation',
      })
    ).resolves.toMatchObject({ ref });
    expect(mocks.findById).not.toHaveBeenCalled();
    expect(mocks.resolve).toHaveBeenCalledWith(ref, { mutationToken: 'mount-mutation' });
  });

  it('refuses competing current bindings instead of picking a project', async () => {
    mocks.select.mockResolvedValue([file, { ...file, path: '/projects/other/pYTK009' }]);
    await expect(
      resolveSequenceDocument({ kind: 'catalog-sequence', entityId: ref.packageId })
    ).rejects.toThrow(/ambiguous/i);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('refuses a current identity owned by another project', async () => {
    await expect(resolveSequenceDocumentById(ref.packageId, ['/projects/other'])).rejects.toThrow(
      /requested project/
    );
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.findById).toHaveBeenCalledWith(ref.packageId, ['/projects/other'], {});
  });

  it('does not fall back to an unscoped lookup when the requested project has no identity', async () => {
    mocks.select.mockResolvedValueOnce([]).mockResolvedValue([file]);
    await expect(resolveSequenceDocumentById(ref.packageId, ['/projects/other'])).rejects.toThrow(
      /requested project/
    );
    expect(mocks.select).toHaveBeenCalledOnce();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('keeps a loose sequence as a catalog document', async () => {
    mocks.select.mockResolvedValue([
      {
        ...file,
        entity_id: 'loose-sequence',
        file_kind: 'genbank',
        path: '/projects/ytk/loose.gb',
      },
    ]);
    await expect(
      resolveSequenceDocument({ kind: 'catalog-sequence', entityId: 'loose-sequence' })
    ).resolves.toMatchObject({
      ref: { kind: 'catalog-sequence', entityId: 'loose-sequence' },
      sourcePath: '/projects/ytk/loose.gb',
    });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('resolves a loose sequence name from its catalog record rather than its physical filename', async () => {
    mocks.select
      .mockResolvedValueOnce([
        {
          ...file,
          entity_id: 'loose-sequence',
          file_kind: 'genbank',
          path: '/projects/ytk/unrelated-raw-import.gb',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'loose-sequence',
          type: 'sequence',
          name: 'pBR322 Follow-up',
        },
      ]);
    await expect(
      resolveSequenceDocument({ kind: 'catalog-sequence', entityId: 'loose-sequence' })
    ).resolves.toMatchObject({
      documentId: 'loose-sequence',
      name: 'pBR322 Follow-up',
      sourcePath: '/projects/ytk/unrelated-raw-import.gb',
    });
  });

  it('follows a historical file UUID to the current package using real SQLite', async () => {
    const db = createTestDb();
    try {
      db.exec(`
        CREATE TABLE catalog_entities (id TEXT, type TEXT, status TEXT);
        CREATE TABLE catalog_entity_files (entity_id TEXT, path TEXT, file_kind TEXT, status TEXT, object_uuid TEXT);
        INSERT INTO catalog_entities VALUES ('sample-4e461e72', 'sequence', 'active');
        INSERT INTO catalog_entity_files VALUES
          ('sample-4e461e72', '/old-project/pYTK009', 'waypoint-sequence', 'historical', '8bbe96e2-d3c3-4fd6-9393-759d5741cffd'),
          ('sample-4e461e72', '/projects/ytk/pYTK009', 'waypoint-sequence', 'current', 'new-file-index-id');
      `);
      mocks.select.mockImplementation(async (sql: string, params: (string | number | null)[]) =>
        db.prepare(sql).all(...params)
      );
      await expect(
        resolveSequenceDocument({
          kind: 'catalog-sequence',
          entityId: '8bbe96e2-d3c3-4fd6-9393-759d5741cffd',
        })
      ).resolves.toMatchObject({ ref });
      expect(mocks.resolve).toHaveBeenCalledWith(ref, {});
      db.exec("UPDATE catalog_entity_files SET status = 'historical'");
      await expect(
        resolveSequenceDocument({
          kind: 'catalog-sequence',
          entityId: '8bbe96e2-d3c3-4fd6-9393-759d5741cffd',
        })
      ).rejects.toThrow('no longer available');
    } finally {
      db.close();
    }
  });
});
