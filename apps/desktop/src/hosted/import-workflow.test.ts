// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { runHostedImport } from './import-workflow';

describe('runHostedImport', () => {
  it('opens every accepted file and leaves the first selected file active', async () => {
    const files = [new File(['LOCUS one'], 'one.gb'), new File(['LOCUS two'], 'two.gb')];
    const paths = ['/workspace/sequences/one.gb', '/workspace/sequences/two.gb'];
    const handleFileSelect = vi.fn(async () => undefined);
    const bumpFileTreeRefresh = vi.fn();
    const revealPath = vi.fn();
    const setStatus = vi.fn();
    const importFiles = vi.fn(async () => ({ workspaceId: 'workspace', paths }));

    await runHostedImport(files, {
      handleFileSelect,
      bumpFileTreeRefresh,
      revealPath,
      setStatus,
      importFiles,
    });

    expect(importFiles).toHaveBeenCalledWith(files);
    expect(bumpFileTreeRefresh).toHaveBeenCalledOnce();
    expect(handleFileSelect.mock.calls).toEqual([
      [paths[0], 'sequence'],
      [paths[1], 'sequence'],
      [paths[0], 'sequence'],
    ]);
    expect(revealPath).toHaveBeenCalledWith(paths[0]);
    expect(setStatus).toHaveBeenNthCalledWith(1, 'Importing…');
    expect(setStatus).toHaveBeenNthCalledWith(2, 'Imported 2 files.');
  });

  it('surfaces importer failures without opening or revealing a file', async () => {
    const files = [new File(['LOCUS one'], 'one.gb')];
    const handleFileSelect = vi.fn(async () => undefined);
    const revealPath = vi.fn();
    const setStatus = vi.fn();

    await runHostedImport(files, {
      handleFileSelect,
      bumpFileTreeRefresh: vi.fn(),
      revealPath,
      setStatus,
      importFiles: vi.fn(async () => {
        throw new Error('Create or open a hosted project before importing files.');
      }),
    });

    expect(handleFileSelect).not.toHaveBeenCalled();
    expect(revealPath).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenNthCalledWith(
      2,
      'Create or open a hosted project before importing files.'
    );
  });
});
