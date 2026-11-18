import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrimerRecoveryInventory } from '../shared/primer-artifacts/primer-recovery-report';
import type { LegacyPrimerLibraryRecoveryResult } from '../shared/legacy-primer-library-recovery';
import type { RuntimeProvenance } from '../shared/runtime-profile';

const mocks = vi.hoisted(() => ({
  inventory: vi.fn(),
  recover: vi.fn(),
  createProject: vi.fn(),
  provenance: vi.fn(),
  profilePath: '/profiles/primer-retry-original',
  completed: false,
}));
vi.mock('../platform', () => ({
  platform: () => ({
    workspace: {
      recoverLegacyPrimerLibrary: mocks.recover,
      createEmptyWorkspace: mocks.createProject,
    },
    runtime: { getProvenance: mocks.provenance },
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
  refreshPrimerRecoveryInventory: mocks.inventory,
  getLatestPrimerRecoveryInventory: () => null,
}));

import { useFirstProjectBootstrap } from './useFirstProjectBootstrap';
import { useToastStore } from '../stores/toast-store';
import { WORKSPACE_SYNC_DATABASE_BUSY_MESSAGE } from '../shared/workspace-sync-errors';
import { WORKSPACE_FILES_CHANGED_EVENT } from '../services/workspace-files-changed-event';

const legacy: PrimerRecoveryInventory = {
  schema: 'dnaforge.primer-recovery-inventory/v1',
  recordedAt: 1,
  entries: [
    {
      id: 'retained-primer',
      name: 'Retained primer',
      source: 'legacy',
      workspaceId: null,
      projectUuid: null,
      status: 'legacy-library',
    },
  ],
};
const complete: Extract<LegacyPrimerLibraryRecoveryResult, { status: 'complete' | 'pending' }> = {
  status: 'complete',
  operationId: 'existing-primer-operation',
  workspaceRoot: '/managed/existing-recovered-primer-project/repo',
  workspaceUuid: 'existing-recovered-primer-project',
  recovered: 1,
  total: 1,
  errors: [],
};
const busy: typeof complete = {
  ...complete,
  status: 'pending',
  recovered: 0,
  errors: [{ primerId: '', message: WORKSPACE_SYNC_DATABASE_BUSY_MESSAGE }],
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
let notices: ReturnType<typeof vi.spyOn>;
let opened: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  mocks.inventory.mockReset();
  mocks.recover.mockReset();
  mocks.createProject.mockReset();
  mocks.provenance.mockReset();
  mocks.profilePath = '/profiles/primer-retry-original';
  mocks.completed = false;
  mocks.inventory.mockImplementation(async () =>
    mocks.completed ? { ...legacy, entries: [] } : legacy
  );
  mocks.recover.mockImplementation(async () => {
    mocks.completed = true;
    return complete;
  });
  mocks.createProject.mockRejectedValue(
    new Error('Automatic retry must reuse the native recovery owner.')
  );
  mocks.provenance.mockImplementation(
    async (): Promise<RuntimeProvenance> => ({
      kind: 'electron-main',
      appName: 'DNAForge',
      appVersion: 'test',
      isPackaged: false,
      isReleaseBuild: false,
      appPath: null,
      execPath: null,
      cwd: null,
      userDataPath: mocks.profilePath,
      projectRoot: null,
      apiUrl: null,
      pid: 5274,
      sidecarPid: null,
      startedAtMs: 1,
      desktopDevPort: null,
      desktopHmrPort: null,
      nodeEnv: 'test',
      waypointTest: '1',
      cacheContractToken: null,
      buildSourceFingerprint: null,
      sidecarSourceFingerprint: null,
    })
  );
  useToastStore.getState().clearToasts();
  notices = vi.spyOn(useToastStore.getState(), 'addRichToast');
  opened = vi.fn();
  window.addEventListener(WORKSPACE_FILES_CHANGED_EVENT, opened);
});
afterEach(async () => {
  cleanup();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  window.removeEventListener(WORKSPACE_FILES_CHANGED_EVENT, opened);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}
async function allowRetry(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
}
function definitions() {
  return notices.mock.calls.map(([toast]) => toast.definition);
}

describe('automatic primer recovery retries through the actual renderer service', () => {
  it('retries transient inventory database contention without a rerender or user action', async () => {
    mocks.inventory.mockRejectedValueOnce(new Error(WORKSPACE_SYNC_DATABASE_BUSY_MESSAGE));
    renderHook(() => useFirstProjectBootstrap(options));
    await settle();
    expect(mocks.inventory).toHaveBeenCalledOnce();
    expect(mocks.recover).not.toHaveBeenCalled();
    await allowRetry();
    expect(mocks.recover).toHaveBeenCalledOnce();
    expect(mocks.inventory.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(definitions()).toContain('primer-library-file-recovery-complete');
    expect(mocks.createProject).not.toHaveBeenCalled();
  });
  it('retries a returned global busy result through the same recovery owner and project', async () => {
    mocks.recover.mockResolvedValueOnce(busy);
    renderHook(() => useFirstProjectBootstrap(options));
    await settle();
    expect(mocks.recover).toHaveBeenCalledOnce();
    expect(definitions()).not.toContain('primer-library-file-recovery-complete');
    await allowRetry();
    expect(mocks.recover).toHaveBeenCalledTimes(2);
    expect(mocks.recover.mock.calls).toEqual([[], []]);
    expect(definitions()).toContain('primer-library-file-recovery-complete');
    const roots = opened.mock.calls.map(([event]) => event.detail.workspaceRoot);
    expect(roots.length).toBeGreaterThan(0);
    expect(new Set(roots)).toEqual(new Set([complete.workspaceRoot]));
    expect(mocks.createProject).not.toHaveBeenCalled();
  });
  it('does not automatically replay a changed-source conflict that needs manual recovery', async () => {
    mocks.recover.mockResolvedValue({
      ...complete,
      status: 'pending',
      recovered: 0,
      errors: [
        {
          primerId: 'retained-primer',
          message:
            'The primer changed after its retained recovery snapshot; its current record was preserved.',
        },
      ],
    });
    renderHook(() => useFirstProjectBootstrap(options));
    await settle();
    await allowRetry();
    expect(mocks.recover).toHaveBeenCalledOnce();
    expect(definitions()).not.toContain('primer-library-file-recovery-complete');
    expect(
      notices.mock.calls.some(([toast]) =>
        toast.actions?.some((action: { label: string }) => action.label === 'Retry primer recovery')
      )
    ).toBe(true);
  });
  it('does not migrate an already valid Registry oligo', async () => {
    mocks.inventory.mockResolvedValue({
      ...legacy,
      entries: [
        {
          id: 'existing-registry-oligo',
          name: 'Existing oligo',
          source: 'registry',
          workspaceId: null,
          projectUuid: null,
          status: 'document-backed',
        },
      ],
    });
    renderHook(() => useFirstProjectBootstrap(options));
    await settle();
    await allowRetry();
    expect(mocks.inventory).toHaveBeenCalledOnce();
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(definitions()).not.toContain('primer-library-file-recovery-complete');
  });
  it('cancels a pending automatic retry when the startup owner unmounts', async () => {
    mocks.recover.mockResolvedValueOnce(busy);
    const mounted = renderHook(() => useFirstProjectBootstrap(options));
    await settle();
    expect(mocks.recover).toHaveBeenCalledOnce();
    mounted.unmount();
    await allowRetry();
    expect(mocks.recover).toHaveBeenCalledOnce();
    expect(definitions()).not.toContain('primer-library-file-recovery-complete');
  });
  it('does not retry an earlier operation after the native profile changes', async () => {
    mocks.recover.mockResolvedValueOnce(busy);
    renderHook(() => useFirstProjectBootstrap(options));
    await settle();
    expect(mocks.recover).toHaveBeenCalledOnce();
    mocks.profilePath = '/profiles/different-profile';
    await allowRetry();
    expect(mocks.recover).toHaveBeenCalledOnce();
    expect(definitions()).not.toContain('primer-library-file-recovery-complete');
  });

  it('does not publish an earlier profile recovery that finishes after the native profile changes', async () => {
    let finish!: (value: LegacyPrimerLibraryRecoveryResult) => void;
    mocks.recover.mockImplementationOnce(
      () =>
        new Promise<LegacyPrimerLibraryRecoveryResult>((resolve) => {
          finish = resolve;
        })
    );
    renderHook(() => useFirstProjectBootstrap(options));
    await settle();
    expect(mocks.recover).toHaveBeenCalledOnce();
    expect(mocks.inventory).toHaveBeenCalledOnce();
    mocks.profilePath = '/profiles/different-profile';
    await act(async () => {
      finish(complete);
      await Promise.resolve();
    });
    await allowRetry();
    expect(opened).not.toHaveBeenCalled();
    expect(mocks.inventory).toHaveBeenCalledOnce();
    expect(definitions()).not.toContain('primer-library-file-recovery-complete');
    expect(mocks.recover).toHaveBeenCalledOnce();
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it('allows the current startup owner to recover after a coalesced earlier profile result is cancelled', async () => {
    let finishEarlier!: (value: LegacyPrimerLibraryRecoveryResult) => void;
    const currentResult = {
      ...complete,
      operationId: 'current-profile-primer-operation',
      workspaceRoot: '/managed/current-profile-primer-project/repo',
      workspaceUuid: 'current-profile-primer-project',
    };
    mocks.recover
      .mockImplementationOnce(
        () =>
          new Promise<LegacyPrimerLibraryRecoveryResult>((resolve) => {
            finishEarlier = resolve;
          })
      )
      .mockImplementationOnce(async () => {
        mocks.completed = true;
        return currentResult;
      });
    const earlier = renderHook(() => useFirstProjectBootstrap(options));
    await settle();
    expect(mocks.recover).toHaveBeenCalledOnce();
    earlier.unmount();
    mocks.profilePath = '/profiles/current-profile';
    renderHook(() => useFirstProjectBootstrap(options));
    await settle();
    expect(mocks.recover).toHaveBeenCalledOnce();
    await act(async () => {
      finishEarlier(complete);
      await Promise.resolve();
    });
    await allowRetry();
    expect(mocks.recover).toHaveBeenCalledTimes(2);
    expect(opened.mock.calls.map(([event]) => event.detail.workspaceRoot)).toEqual([
      currentResult.workspaceRoot,
    ]);
    expect(
      definitions().filter((name) => name === 'primer-library-file-recovery-complete')
    ).toHaveLength(1);
    expect(mocks.createProject).not.toHaveBeenCalled();
  });
});
