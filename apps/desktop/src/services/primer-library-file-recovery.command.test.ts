import { beforeEach, expect, it, vi } from 'vitest';
import { useToastStore } from '../stores/toast-store';
import { saveLegacyPrimerLibraryAsFiles } from './primer-library-file-recovery';

const mocks = vi.hoisted(() => ({ recover: vi.fn(), refresh: vi.fn() }));
vi.mock('../platform', () => ({
  platform: () => ({ workspace: { recoverLegacyPrimerLibrary: mocks.recover } }),
}));
vi.mock('../features/primers/public/primer-recovery-report', () => ({
  getLatestPrimerRecoveryInventory: () => null,
  refreshPrimerRecoveryInventory: mocks.refresh,
}));
const result = {
  status: 'complete' as const,
  operationId: 'migration',
  workspaceRoot: '/recovered/project',
  workspaceUuid: 'project-id',
  total: 375,
  recovered: 375,
  errors: [],
};
beforeEach(() => {
  mocks.recover.mockReset();
  mocks.refresh.mockReset();
  mocks.refresh.mockResolvedValue({
    schema: 'dnaforge.primer-recovery-inventory/v1',
    recordedAt: 1,
    entries: [],
  });
  useToastStore.getState().clearToasts();
});
it('mounts the recovered project and refreshes actual inventory only after completed native recovery', async () => {
  const opened = vi.fn();
  window.addEventListener('waypoint:workspace-files-changed', opened);
  try {
    mocks.recover.mockResolvedValue(result);
    await saveLegacyPrimerLibraryAsFiles();
    expect(mocks.recover).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls[0][0].detail).toMatchObject({
      workspaceRoot: result.workspaceRoot,
      createdNewWorkspace: true,
      createdWorkspaceName: 'Recovered primers',
    });
    expect(useToastStore.getState().toasts.map((toast) => toast.definition)).toEqual([
      'primer-library-file-recovery-complete',
    ]);
  } finally {
    window.removeEventListener('waypoint:workspace-files-changed', opened);
  }
});
it('coalesces repeated actions while native recovery is running', async () => {
  let finish!: (value: typeof result) => void;
  mocks.recover.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  const first = saveLegacyPrimerLibraryAsFiles();
  const second = saveLegacyPrimerLibraryAsFiles();
  expect(first).toBe(second);
  expect(mocks.recover).toHaveBeenCalledTimes(1);
  finish(result);
  await first;
});
it.each(['pending', 'error'])(
  'retains a retry action without claiming completion for %s',
  async (state) => {
    if (state === 'pending')
      mocks.recover.mockResolvedValue({
        ...result,
        status: 'pending',
        recovered: 5,
        errors: [{ primerId: 'primer', message: 'Conflicting file' }],
      });
    else mocks.recover.mockRejectedValue(new Error('Native recovery unavailable'));
    await saveLegacyPrimerLibraryAsFiles();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts.map((toast) => toast.definition)).toEqual([
      'primer-library-file-recovery-pending',
    ]);
    expect(useToastStore.getState().toasts[0].actions?.[0].label).toBe('Retry primer recovery');
  }
);
