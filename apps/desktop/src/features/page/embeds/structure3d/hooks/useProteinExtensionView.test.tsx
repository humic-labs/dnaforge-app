import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MolstarPlugin } from '../molstar/cache';
import { useProteinExtensionView } from './useProteinExtensionView';

const handlers = vi.hoisted(() => ({
  available: vi.fn(),
  list: vi.fn(),
  run: vi.fn(),
  activate: vi.fn(),
  release: vi.fn(),
}));
vi.mock('../installed-protein-extensions', () => ({
  supportsProteinExtensions: handlers.available,
  listInstalledProteinExtensions: handlers.list,
  runProteinExtension: handlers.run,
}));
vi.mock('../molstar/molViewSpec', () => ({
  getMolViewSpecCoordinates: () => ({ text: 'molecule', format: 'pdb' }),
}));
vi.mock('../molstar/extension-render', () => ({ activateExtensionRender: handlers.activate }));

const viewer = {} as MolstarPlugin;
const id = 'vendor.protein';

describe('installed protein views', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    handlers.available.mockReturnValue(true);
    handlers.list.mockResolvedValue([{ id, label: 'Protein' }]);
    handlers.run.mockResolvedValue({ mesh: true });
    handlers.activate.mockResolvedValue(handlers.release);
  });

  it('skips discovery and saved activation when extensions are unavailable', () => {
    handlers.available.mockReturnValue(false);
    const read = vi.spyOn(Storage.prototype, 'getItem');
    const { result, unmount } = renderHook(() => useProteinExtensionView(viewer, 'hosted/view'));
    expect(result.current.available).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(handlers.list).not.toHaveBeenCalled();
    expect(handlers.run).not.toHaveBeenCalled();
    read.mockRestore();
    unmount();
  });

  it('restores the selected extension only on the same source and reports a missing package', async () => {
    const read = () => useProteinExtensionView(viewer, 'workspace/view/source-v1');
    const first = renderHook(read);
    act(() => first.result.current.select(id));
    await waitFor(() => expect(first.result.current.active).toBe(id));
    expect(handlers.run).toHaveBeenCalledWith(
      id,
      { filename: 'structure.pdb', text: 'molecule' },
      expect.any(AbortSignal)
    );
    first.unmount();
    expect(handlers.release).toHaveBeenCalledOnce();
    const second = renderHook(read);
    await waitFor(() => expect(second.result.current.active).toBe(id));
    second.unmount();
    handlers.list.mockResolvedValue([]);
    const missing = renderHook(read);
    await waitFor(() => expect(missing.result.current.error).toContain(id));
    expect(missing.result.current.active).toBeNull();
    missing.unmount();
    handlers.list.mockResolvedValue([{ id, label: 'Protein' }]);
    const other = renderHook(() => useProteinExtensionView(viewer, 'workspace/view/source-v2'));
    await waitFor(() => expect(other.result.current.installed).toHaveLength(1));
    expect(other.result.current.active).toBeNull();
    expect(handlers.activate).toHaveBeenCalledTimes(2);
    other.unmount();
  });

  it('drops a late package result when the user switches back to a built-in view', async () => {
    let finish: ((result: unknown) => void) | undefined;
    handlers.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const { result, unmount } = renderHook(() =>
      useProteinExtensionView(viewer, 'workspace/view/source')
    );
    act(() => result.current.select(id));
    await waitFor(() => expect(finish).toBeDefined());
    const signal: AbortSignal = handlers.run.mock.calls[0][2];
    act(() => result.current.select(null));
    expect(signal.aborted).toBe(true);
    await act(async () => {
      finish?.({});
    });
    expect(handlers.activate).not.toHaveBeenCalled();
    expect(result.current.active).toBeNull();
    unmount();
  });
});
