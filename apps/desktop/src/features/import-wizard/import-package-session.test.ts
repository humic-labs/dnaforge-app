import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportPackageSession } from './import-package-session';
import { buildImportItemsFromPaths } from './build-import-wizard-state';

const native = vi.hoisted(() => ({
  openPreview: vi.fn(),
  resolvePreviewImportSource: vi.fn(),
  releasePreview: vi.fn(),
  savePreview: vi.fn(),
  previewImportDedup: vi.fn(),
  importFile: vi.fn(),
}));
vi.mock('../../platform', () => ({
  platform: () => ({ fileAssociations: native, workspace: native }),
}));

const external = '/incoming/collection.fasta';
const owned = '/preview/v1/original/collection.fasta';
const receipt = { familyId: 'fasta', packageId: 'collection-v1', acquisitionId: 'first-review' };
const request = { sourcePath: external, targetRoot: '/project' };

describe('package-backed import review', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    native.openPreview.mockResolvedValue(receipt);
    native.resolvePreviewImportSource.mockResolvedValue(owned);
    native.savePreview.mockResolvedValue({
      destPath: '/project/collection',
      relPath: 'collection',
      committed: true,
      records: [{ destPath: '/project/collection' }],
    });
  });

  it('reviews and saves a collection after capturing it, with no later read of the dropped file', async () => {
    const session = new ImportPackageSession();
    const readText = vi.fn();
    const items = await buildImportItemsFromPaths([external], {
      stat: async () => ({ size: 90, isDirectory: false }),
      readText,
      captureInput: session.capture.bind(session),
    });
    expect(items[0]).toMatchObject({
      path: external,
      name: 'collection.fasta',
      packageInputPath: owned,
    });
    expect(items[0].block).toBeUndefined();
    expect(readText).not.toHaveBeenCalled();
    native.previewImportDedup.mockResolvedValue([
      { sourcePath: owned, decision: { action: 'import-new' } },
    ]);
    expect(await session.previewDedup({ sourcePaths: [external], targetRoot: '/project' })).toEqual(
      [{ sourcePath: external, decision: { action: 'import-new' } }]
    );
    expect(native.previewImportDedup).toHaveBeenCalledWith({
      sourcePaths: [owned],
      targetRoot: '/project',
    });
    await session.importFile(request);
    expect(native.savePreview).toHaveBeenCalledWith({
      receipt,
      destination: { kind: 'existing-workspace', rootPath: '/project' },
    });
    expect(native.importFile).not.toHaveBeenCalled();
    await session.close();
    expect(native.releasePreview).toHaveBeenCalledExactlyOnceWith({ receipt });
  });

  it('honors explicit replacement against the verified package member', async () => {
    const session = new ImportPackageSession();
    await session.capture(external, 'fasta');
    const dedup = { mode: 'replace', expectedRelPath: 'previous/collection.gb' } as const;
    await session.importFile({ ...request, dedup });
    expect(native.importFile).toHaveBeenCalledWith({
      sourcePath: owned,
      targetRoot: '/project',
      dedup,
    });
    await session.close();
  });

  it('releases an in-flight acquisition even when the review closes before the package arrives', async () => {
    let finish!: (value: typeof receipt) => void;
    native.openPreview.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const session = new ImportPackageSession();
    const capture = session.capture(external, 'fasta');
    const duplicate = session.capture(external, 'fasta');
    const closed = session.close();
    finish(receipt);
    await Promise.all([capture, duplicate, closed]);
    expect(native.openPreview).toHaveBeenCalledTimes(1);
    expect(native.releasePreview).toHaveBeenCalledExactlyOnceWith({ receipt });
  });
});
