import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryEntities: vi.fn(),
  registerEntity: vi.fn(),
  updateEntity: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    lims: {
      queryEntities: mocks.queryEntities,
      registerEntity: mocks.registerEntity,
      updateEntity: mocks.updateEntity,
    },
  }),
}));

import {
  ensureNotebookRegisteredInLims,
  notebookPackageRootFromAdapterPath,
} from './register-notebook-entity';

describe('ensureNotebookRegisteredInLims', () => {
  beforeEach(() => {
    mocks.queryEntities.mockReset();
    mocks.registerEntity.mockReset();
    mocks.updateEntity.mockReset();
  });

  it('strips .forge/notebook.json to the package root', () => {
    expect(notebookPackageRootFromAdapterPath('/lab/Miniprep/.forge/notebook.json')).toBe(
      '/lab/Miniprep'
    );
    expect(notebookPackageRootFromAdapterPath('/lab/legacy.wpnote.json')).toBe(
      '/lab/legacy.wpnote.json'
    );
  });

  it('registers a missing notebook with the catalog id', async () => {
    mocks.queryEntities.mockResolvedValue([]);
    mocks.registerEntity.mockResolvedValue({ id: 'ws1::page-1' });

    await ensureNotebookRegisteredInLims({
      id: 'ws1::page-1',
      name: 'Miniprep',
      packagePath: '/lab/Miniprep',
      workspaceId: 7,
    });

    expect(mocks.registerEntity).toHaveBeenCalledWith(
      {
        id: 'ws1::page-1',
        kind: 'notebook',
        name: 'Miniprep',
        fields: { packagePath: '/lab/Miniprep' },
        workspaceId: 7,
        registrationStatus: 'registered',
      },
      undefined
    );
  });

  it('joins an open workspace mutation instead of taking a second lease', async () => {
    mocks.queryEntities.mockResolvedValue([]);
    mocks.registerEntity.mockResolvedValue({ id: 'ws1::page-1' });

    await ensureNotebookRegisteredInLims({
      id: 'ws1::page-1',
      name: 'Miniprep',
      packagePath: '/lab/Miniprep',
      mutationToken: 'lease-1',
    });

    expect(mocks.registerEntity).toHaveBeenCalledWith(expect.any(Object), 'lease-1');
  });

  it('does not register twice for the same id', async () => {
    mocks.queryEntities.mockResolvedValue([
      {
        id: 'ws1::page-1',
        kind: 'notebook',
        name: 'Miniprep',
        fields: { packagePath: '/lab/Miniprep' },
        workspaceId: null,
        eventSeq: 12,
      },
    ]);

    await ensureNotebookRegisteredInLims({
      id: 'ws1::page-1',
      name: 'Miniprep',
      packagePath: '/lab/Miniprep',
    });

    expect(mocks.registerEntity).not.toHaveBeenCalled();
    expect(mocks.updateEntity).not.toHaveBeenCalled();
  });

  it('refreshes existing notebook name, package path, and owner through the current lease', async () => {
    mocks.queryEntities.mockResolvedValue([
      {
        id: 'ws1::page-1',
        kind: 'notebook',
        name: 'Miniprep',
        fields: { packagePath: '/lab/Miniprep', retained: 'Registry metadata' },
        workspaceId: 7,
        eventSeq: 12,
      },
    ]);

    await ensureNotebookRegisteredInLims({
      id: 'ws1::page-1',
      name: 'Renamed Miniprep',
      packagePath: '/lab/experiments/Renamed Miniprep',
      workspaceId: 8,
      mutationToken: 'rename-lease',
    });

    expect(mocks.updateEntity).toHaveBeenCalledWith(
      {
        id: 'ws1::page-1',
        name: 'Renamed Miniprep',
        fields: { packagePath: '/lab/experiments/Renamed Miniprep' },
        workspaceId: 8,
        actor: 'workspace-reconcile',
        expectedEventSeq: 12,
      },
      'rename-lease'
    );
    expect(mocks.registerEntity).not.toHaveBeenCalled();
  });

  it('refreshes an archived notebook without replacing its archive or review state', async () => {
    mocks.queryEntities.mockResolvedValue([
      {
        id: 'ws1::page-1',
        kind: 'notebook',
        name: 'Miniprep',
        fields: { packagePath: '/lab/Miniprep' },
        workspaceId: 7,
        eventSeq: 14,
        tombstone: true,
        registrationStatus: 'drifted',
      },
    ]);

    await ensureNotebookRegisteredInLims({
      id: 'ws1::page-1',
      name: 'Archived Miniprep',
      packagePath: '/lab/Archived Miniprep',
      workspaceId: 7,
    });

    const update = mocks.updateEntity.mock.calls[0]?.[0];
    expect(update).toMatchObject({ name: 'Archived Miniprep', expectedEventSeq: 14 });
    expect(update).not.toHaveProperty('registrationStatus');
    expect(update).not.toHaveProperty('domainStatus');
    expect(update).not.toHaveProperty('tombstone');
  });
});
