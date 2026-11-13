import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueRecentlyEditedPreparation,
  mountedWorkspaceAccessKey,
  prepareRecentlyEditedForMountedWorkspaces,
} from './prepare-recently-edited';

const mocks = vi.hoisted(() => ({
  refreshRecentlyEdited: vi.fn(),
  registerWorkspaceFile: vi.fn(),
}));

vi.mock('./recently-edited', () => ({
  refreshRecentlyEdited: mocks.refreshRecentlyEdited,
}));

vi.mock('../../db/workspace-catalog', () => ({
  registerWorkspaceFile: mocks.registerWorkspaceFile,
}));

vi.mock('../../shared/developer-import-sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/developer-import-sources')>();
  return {
    ...actual,
    isDeveloperImportSourcePath: (path: string) =>
      actual.isDeveloperImportSourcePath(path, ['/developer/wp-assets']),
  };
});

describe('prepareRecentlyEditedForMountedWorkspaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refreshRecentlyEdited.mockResolvedValue([]);
  });

  it('does not create a project for an import source, regardless of editing access', async () => {
    await prepareRecentlyEditedForMountedWorkspaces([
      { path: '/developer/wp-assets', name: 'Import material', addedAt: 1 },
      {
        path: '/developer/wp-assets/nested',
        name: 'More import material',
        addedAt: 1,
        pinned: true,
      },
      { path: '/projects/review', name: 'Real project', addedAt: 2, pinned: true },
    ]);
    expect(mocks.registerWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(mocks.registerWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/projects/review' })
    );
    expect(mocks.refreshRecentlyEdited).toHaveBeenCalledWith(50);
  });

  it('does not read recent activity until every mounted root has durable access ', async () => {
    const completions = new Map<string, () => void>();
    mocks.registerWorkspaceFile.mockImplementation(
      ({ path }: { path: string }) =>
        new Promise((resolve) => {
          completions.set(path, () => resolve({ id: path }));
        })
    );

    const preparation = prepareRecentlyEditedForMountedWorkspaces([
      { path: '/projects/writable', name: 'Writable', addedAt: 1 },
      { path: '/fixtures/reference', name: 'Reference', addedAt: 2, pinned: true },
    ]);

    expect(mocks.registerWorkspaceFile).toHaveBeenCalledTimes(2);
    expect(mocks.registerWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/projects/writable',
        workspaceAccess: 'writable',
      })
    );
    expect(mocks.registerWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/fixtures/reference',
        workspaceAccess: 'reference',
      })
    );
    expect(mocks.refreshRecentlyEdited).not.toHaveBeenCalled();

    completions.get('/projects/writable')?.();
    await Promise.resolve();
    expect(mocks.refreshRecentlyEdited).not.toHaveBeenCalled();

    completions.get('/fixtures/reference')?.();
    await preparation;
    expect(mocks.refreshRecentlyEdited).toHaveBeenCalledWith(50);
  });

  it('keys readiness by root path and access, not presentation order or entity kinds', () => {
    const writable = { path: '/projects/writable', name: 'Writable', addedAt: 1 };
    const reference = {
      path: '/fixtures/reference',
      name: 'Reference',
      addedAt: 2,
      pinned: true,
    };

    expect(mountedWorkspaceAccessKey([writable, reference])).toBe(
      mountedWorkspaceAccessKey([reference, writable])
    );
    expect(mountedWorkspaceAccessKey([writable, reference])).not.toBe(
      mountedWorkspaceAccessKey([writable, { ...reference, pinned: false }])
    );
  });

  it('does not publish a snapshot when any access registration fails', async () => {
    mocks.registerWorkspaceFile.mockRejectedValueOnce(new Error('catalog unavailable'));

    await expect(
      prepareRecentlyEditedForMountedWorkspaces([
        { path: '/fixtures/reference', name: 'Reference', addedAt: 2, pinned: true },
      ])
    ).rejects.toThrow('catalog unavailable');
    expect(mocks.refreshRecentlyEdited).not.toHaveBeenCalled();
  });

  it('serializes access changes so an older registration cannot overwrite the newest mode', async () => {
    let completeWritable!: () => void;
    mocks.registerWorkspaceFile
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeWritable = () => resolve({ id: 'workspace-root' });
          })
      )
      .mockResolvedValueOnce({ id: 'workspace-root' });

    const writable = enqueueRecentlyEditedPreparation(Promise.resolve(), [
      { path: '/shared/root', name: 'Root', addedAt: 1 },
    ]);
    const reference = enqueueRecentlyEditedPreparation(writable, [
      { path: '/shared/root', name: 'Root', addedAt: 1, pinned: true },
    ]);

    await vi.waitFor(() => expect(mocks.registerWorkspaceFile).toHaveBeenCalledTimes(1));
    completeWritable();
    await reference;

    expect(mocks.registerWorkspaceFile).toHaveBeenCalledTimes(2);
    expect(mocks.registerWorkspaceFile.mock.calls.map(([input]) => input.workspaceAccess)).toEqual([
      'writable',
      'reference',
    ]);
    expect(mocks.refreshRecentlyEdited).toHaveBeenCalledTimes(2);
  });
});
