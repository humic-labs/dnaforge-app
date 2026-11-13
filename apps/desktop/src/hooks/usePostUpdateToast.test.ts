import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { AppBuildIdentity } from '../shared/app-build-identity';
import { usePostUpdateToast } from './usePostUpdateToast';

const mocks = vi.hoisted(() => ({
  build: {
    kind: 'release',
    version: '0.9.3',
    sourceReleaseVersion: '0.9.3',
    sourceCommit: null,
    sourceModified: false,
  } as AppBuildIdentity,
  appDataDir: vi.fn(),
  exists: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  addRichToast: vi.fn(),
}));
vi.mock('../lib/app-build', () => ({ APP_BUILD: mocks.build }));
vi.mock('../platform', () => ({
  platform: () => ({
    path: { appDataDir: mocks.appDataDir },
    fs: {
      exists: mocks.exists,
      readTextFile: mocks.readTextFile,
      writeTextFile: mocks.writeTextFile,
    },
  }),
}));
vi.mock('../stores/toast-store', () => ({
  useToastStore: (selector: (state: { addRichToast: typeof mocks.addRichToast }) => unknown) =>
    selector({ addRichToast: mocks.addRichToast }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks.build, { kind: 'release', version: '0.9.3' });
  mocks.appDataDir.mockResolvedValue('/profile');
  mocks.exists.mockResolvedValue(true);
  mocks.readTextFile.mockResolvedValue('0.9.2');
  mocks.writeTextFile.mockResolvedValue(undefined);
});

describe('post-update release identity', () => {
  it.each(['development', 'local', 'test', 'unknown'] as const)(
    'does not announce or touch release markers in %s builds',
    (kind) => {
      Object.assign(mocks.build, { kind });
      renderHook(() => usePostUpdateToast(vi.fn()));
      expect(mocks.appDataDir).not.toHaveBeenCalled();
      expect(mocks.readTextFile).not.toHaveBeenCalled();
      expect(mocks.writeTextFile).not.toHaveBeenCalled();
      expect(mocks.addRichToast).not.toHaveBeenCalled();
    }
  );

  it('announces and records a changed installed release with a working notes action', async () => {
    const open = vi.fn();
    renderHook(() => usePostUpdateToast(open));
    await waitFor(() =>
      expect(mocks.writeTextFile).toHaveBeenCalledWith('/profile/.last-seen-version', '0.9.3')
    );
    expect(mocks.addRichToast).toHaveBeenCalledOnce();
    const toast = mocks.addRichToast.mock.calls[0][0];
    expect(toast.message).toBe('Updated to v0.9.3. See what changed.');
    toast.actions[0].onClick();
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith('0.9.3');
  });

  it('uses the latest accepted opener and passes only the validated installed release', async () => {
    const obsolete = vi.fn();
    const current = vi.fn();
    const { rerender } = renderHook(({ open }) => usePostUpdateToast(open), {
      initialProps: { open: obsolete },
    });
    await waitFor(() => expect(mocks.addRichToast).toHaveBeenCalledOnce());
    rerender({ open: current });
    mocks.addRichToast.mock.calls[0][0].actions[0].onClick();
    expect(obsolete).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledWith('0.9.3');
    expect(mocks.addRichToast).toHaveBeenCalledOnce();
  });

  it('does not announce a release without matching public notes', async () => {
    Object.assign(mocks.build, { kind: 'release', version: '9.9.9' });
    renderHook(() => usePostUpdateToast(vi.fn()));
    await waitFor(() =>
      expect(mocks.writeTextFile).toHaveBeenCalledWith('/profile/.last-seen-version', '9.9.9')
    );
    expect(mocks.addRichToast).not.toHaveBeenCalled();
  });

  it('forwards the actual toast action control with the validated installed version', async () => {
    const open = vi.fn();
    renderHook(() => usePostUpdateToast(open));
    await waitFor(() => expect(mocks.addRichToast).toHaveBeenCalledOnce());
    const sourceElement = document.createElement('button');
    mocks.addRichToast.mock.calls[0][0].actions[0].onClick(sourceElement);
    expect(open).toHaveBeenCalledWith('0.9.3', sourceElement);
  });

  it('records a first release install without falsely announcing an update', async () => {
    mocks.exists.mockResolvedValue(false);
    renderHook(() => usePostUpdateToast(vi.fn()));
    await waitFor(() =>
      expect(mocks.writeTextFile).toHaveBeenCalledWith('/profile/.last-seen-version', '0.9.3')
    );
    expect(mocks.addRichToast).not.toHaveBeenCalled();
  });
});
