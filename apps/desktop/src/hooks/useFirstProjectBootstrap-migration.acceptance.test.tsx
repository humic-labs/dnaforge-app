import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrimerRecoveryInventory } from '../shared/primer-artifacts/primer-recovery-report';

const mocks = vi.hoisted(() => ({ refreshInventory: vi.fn(), recover: vi.fn() }));
vi.mock('../platform', () => ({
  platform: () => ({ workspace: { recoverLegacyPrimerLibrary: mocks.recover } }),
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

import { useFirstProjectBootstrap } from './useFirstProjectBootstrap';
import { useToastStore } from '../stores/toast-store';

const inventory: PrimerRecoveryInventory = {
  schema: 'dnaforge.primer-recovery-inventory/v1',
  recordedAt: 1,
  entries: [
    {
      id: 'legacy-primer-1',
      name: 'POP5_R',
      source: 'legacy',
      workspaceId: null,
      projectUuid: null,
      status: 'legacy-library',
    },
  ],
};
const complete = {
  status: 'complete' as const,
  operationId: 'legacy-file-migration',
  workspaceRoot: '/managed/recovered-primers/repo',
  workspaceUuid: 'recovered-primers',
  recovered: 1,
  total: 1,
  errors: [],
};
const options = {
  libraryLoaded: true,
  workspaceLoading: false,
  workspacePath: null,
  registeredProjectFolders: [],
  activeProjects: [],
  e2e: true,
  setWorkspacePath: vi.fn(),
  refreshWorkspaceLibrary: vi.fn(async () => undefined),
};

beforeEach(() => {
  mocks.refreshInventory.mockReset();
  mocks.recover.mockReset();
  mocks.refreshInventory.mockResolvedValue({ ...inventory, entries: [] });
  mocks.refreshInventory.mockResolvedValueOnce(inventory);
  mocks.recover.mockResolvedValue(complete);
  useToastStore.getState().clearToasts();
});
afterEach(cleanup);

describe('automatic legacy primer migration at application startup', () => {
  it('uses the existing recovery owner automatically once the library finishes loading', async () => {
    const { rerender } = renderHook(
      ({ libraryLoaded }) => useFirstProjectBootstrap({ ...options, libraryLoaded }),
      {
        initialProps: { libraryLoaded: false },
      }
    );
    expect(mocks.refreshInventory).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
    rerender({ libraryLoaded: true });
    await waitFor(() => expect(mocks.recover).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.refreshInventory).toHaveBeenCalledTimes(2));
    expect(
      useToastStore
        .getState()
        .toasts.some((toast) => toast.definition === 'primer-library-file-recovery-complete')
    ).toBe(true);
    rerender({ libraryLoaded: true });
    expect(mocks.recover).toHaveBeenCalledOnce();
  });

  it.each(['pending', 'failed'])(
    'retains %s native recovery without claiming completion',
    async (state) => {
      if (state === 'pending')
        mocks.recover.mockResolvedValue({
          ...complete,
          status: 'pending',
          recovered: 0,
          errors: [{ primerId: 'legacy-primer-1', message: 'Source publication remains pending' }],
        });
      else mocks.recover.mockRejectedValue(new Error('Source publication remains pending'));
      renderHook(() => useFirstProjectBootstrap(options));
      await waitFor(() => expect(mocks.recover).toHaveBeenCalledOnce());
      await waitFor(() =>
        expect(
          useToastStore
            .getState()
            .toasts.some((toast) => toast.definition === 'primer-library-file-recovery-pending')
        ).toBe(true)
      );
      expect(
        useToastStore
          .getState()
          .toasts.some((toast) => toast.definition === 'primer-library-file-recovery-complete')
      ).toBe(false);
      expect(mocks.refreshInventory).toHaveBeenCalledOnce();
    }
  );

  it('preserves native database Registry oligos as their existing representation', async () => {
    mocks.refreshInventory.mockReset();
    mocks.refreshInventory.mockResolvedValue({
      ...inventory,
      entries: [
        {
          id: 'native-registry-oligo',
          name: 'Native oligo',
          source: 'registry',
          workspaceId: null,
          projectUuid: null,
          status: 'document-backed',
        },
      ],
    });
    renderHook(() => useFirstProjectBootstrap(options));
    await waitFor(() => expect(mocks.refreshInventory).toHaveBeenCalledOnce());
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(
      useToastStore
        .getState()
        .toasts.some((toast) => toast.definition === 'primer-library-file-recovery-complete')
    ).toBe(false);
  });
});
