import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useFirstProjectBootstrap } from './useFirstProjectBootstrap';
import { useToastStore } from '../stores/toast-store';

const mocks = vi.hoisted(() => ({
  getOriginalDefaultProject: vi.fn(),
  createEmptyWorkspace: vi.fn(),
  refreshInventory: vi.fn(),
}));

vi.mock('../platform', () => ({
  platform: () => ({
    workspace: {
      getOriginalDefaultProject: mocks.getOriginalDefaultProject,
      createEmptyWorkspace: mocks.createEmptyWorkspace,
    },
  }),
}));
vi.mock('../utils/environment', () => ({
  isDesktopRuntime: () => true,
  isBrowserOnly: () => false,
}));
vi.mock('../stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ folders: [] }) },
}));
vi.mock('../features/workspace-loader/workspace-telemetry', () => ({
  beginProjectLifecycle: vi.fn(),
  bindProjectLifecycle: vi.fn(),
}));
vi.mock('../features/primers/public/primer-recovery-report', () => ({
  refreshPrimerRecoveryInventory: mocks.refreshInventory,
  getLatestPrimerRecoveryInventory: () => null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  useToastStore.getState().clearToasts();
  mocks.getOriginalDefaultProject.mockResolvedValue({
    status: 'unresolved',
    reason: 'identity-not-recorded',
    message: 'The original My Project has not been identified.',
  });
  mocks.refreshInventory.mockResolvedValue({
    schema: 'dnaforge.primer-recovery-inventory/v1',
    recordedAt: 1,
    entries: [],
  });
});

afterEach(cleanup);

it('opens an existing project without demanding historical identity when no records need recovery', async () => {
  const path = '/managed-workspaces/2afe0eda-3720-4024-8b55-1a8f9d60325a/repo';
  renderHook(() =>
    useFirstProjectBootstrap({
      libraryLoaded: true,
      waitForStartupProjectMounts: completedMounts,
      workspaceLoading: false,
      workspacePath: path,
      registeredProjectFolders: [
        {
          path,
          name: 'My Project',
          repoUuid: '2afe0eda-3720-4024-8b55-1a8f9d60325a',
          originPath: null,
          lifecycle: 'active',
          pinned: false,
        },
      ],
      activeProjects: [{ repoPath: path, name: 'My Project' }],
      e2e: false,
      setWorkspacePath: vi.fn(),
      refreshWorkspaceLibrary: vi.fn(),
    })
  );
  await waitFor(() => expect(mocks.refreshInventory).toHaveBeenCalledOnce());
  expect(useToastStore.getState().toasts).toEqual([]);
  expect(mocks.getOriginalDefaultProject).not.toHaveBeenCalled();
  expect(mocks.createEmptyWorkspace).not.toHaveBeenCalled();
});

async function completedMounts(): Promise<void> {}
