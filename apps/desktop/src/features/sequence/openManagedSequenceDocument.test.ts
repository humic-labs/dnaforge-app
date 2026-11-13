import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../canvas/store';

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    fs: {
      stat: mocks.stat,
      exists: vi.fn(async () => false),
    },
  }),
}));

vi.mock('./managed-sequence-repository', () => ({
  managedSequenceRepository: {
    findByMemberPath: vi.fn(async () => null),
    resolve: mocks.resolve,
  },
}));

vi.mock('../../db/workspace-catalog', () => ({
  findWorkspaceRootForPath: vi.fn(() => null),
  inferCatalogFileKind: vi.fn(() => 'genbank'),
  registerWorkspaceFile: vi.fn(),
}));

vi.mock('../workspace-loader/public/project-edit-folders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace-loader/public/project-edit-folders')>()),
  listProjectEditFolders: vi.fn(async () => [
    { path: '/workspace', name: 'Workspace', lifecycle: 'active', pinned: false },
  ]),
}));

import { openManagedSequenceDocument } from './openSequenceFile';

const ref = {
  kind: 'managed-sequence' as const,
  packageId: 'stable-package-id',
  packageRoot: '/workspace/moved-package',
};

describe('openManagedSequenceDocument', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      panels: { main: { id: 'main', tabs: [], activeTabId: null } },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
      oversizeScanComplete: true,
    });
    mocks.stat.mockReset();
    mocks.resolve.mockReset();
    mocks.stat.mockResolvedValue({
      size: 1024,
      isFile: true,
      isDirectory: false,
      mtime: 1,
      ctime: 1,
    });
    mocks.resolve.mockResolvedValue({
      ref,
      productPath: '/workspace/moved-package/physical-file.gb',
      document: { id: ref.packageId, name: 'Logical sequence name' },
    });
  });

  it('keys the tab by package identity and keeps the physical product behind the ref', async () => {
    await openManagedSequenceDocument(ref, { label: 'fallback.gb' });

    const [tab] = useCanvasStore.getState().panels.main.tabs;
    expect(tab).toMatchObject({
      type: 'sequence',
      entityId: 'stable-package-id',
      label: 'Logical sequence name',
      sequenceDocument: ref,
      loadStatus: 'loaded',
    });
    expect(tab?.entityId).not.toContain('physical-file.gb');
  });
});
