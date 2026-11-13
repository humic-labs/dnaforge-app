// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_FILE_RELOCATED_EVENT } from '../../shared/workspace-relocate-types';

const relocateEntityFile = vi.fn();
vi.mock('../../platform', () => ({
  platform: () => ({ workspace: { relocateEntityFile } }),
}));

import { dispatchWorkspaceFileRelocated, relocateRegistryFile } from './relocate-registry-file';

const emptyCounts = {
  catalog: { updated: 1 },
  indexed: { indexedFilesMoved: 1, staleIndexedFilesMerged: 0, primerBindingsRepointed: 0 },
  lims: { rebasedEntityIds: ['p1'], workspaceIds: [1] },
};

describe('relocateRegistryFile — the ONE renderer seam', () => {
  afterEach(() => {
    relocateEntityFile.mockReset();
  });

  it('calls the relocate IPC exactly once with the input and returns its result', async () => {
    relocateEntityFile.mockResolvedValue({ newPath: '/w/new.gb', counts: emptyCounts });
    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener(WORKSPACE_FILE_RELOCATED_EVENT, listener);

    const result = await relocateRegistryFile({
      workspaceRoot: '/w',
      oldPath: '/w/old.gb',
      newPath: '/w/new.gb',
    });

    expect(relocateEntityFile).toHaveBeenCalledTimes(1);
    expect(relocateEntityFile).toHaveBeenCalledWith({
      workspaceRoot: '/w',
      oldPath: '/w/old.gb',
      newPath: '/w/new.gb',
    });
    expect(result.newPath).toBe('/w/new.gb');

    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({ oldPath: '/w/old.gb', newPath: '/w/new.gb' });
    window.removeEventListener(WORKSPACE_FILE_RELOCATED_EVENT, listener);
  });

  it('broadcasts the COMMITTED newPath even if the IPC resolved a different path than requested', async () => {
    relocateEntityFile.mockResolvedValue({ newPath: '/w/actually-here.gb', counts: emptyCounts });
    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener(WORKSPACE_FILE_RELOCATED_EVENT, listener);

    await relocateRegistryFile({ workspaceRoot: '/w', oldPath: '/w/old.gb', newPath: '/w/req.gb' });

    expect(events[0].detail).toEqual({ oldPath: '/w/old.gb', newPath: '/w/actually-here.gb' });
    window.removeEventListener(WORKSPACE_FILE_RELOCATED_EVENT, listener);
  });

  it('does NOT broadcast when the IPC throws (a failed move must not fire a retarget)', async () => {
    relocateEntityFile.mockRejectedValue(new Error('MOVE_EXISTS'));
    const listener = vi.fn();
    window.addEventListener(WORKSPACE_FILE_RELOCATED_EVENT, listener);

    await expect(
      relocateRegistryFile({ workspaceRoot: '/w', oldPath: '/w/old.gb', newPath: '/w/new.gb' })
    ).rejects.toThrow(/MOVE_EXISTS/);
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(WORKSPACE_FILE_RELOCATED_EVENT, listener);
  });

  it('dispatchWorkspaceFileRelocated fires the standalone event (the db-layer artifact-rename path)', () => {
    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener(WORKSPACE_FILE_RELOCATED_EVENT, listener);

    dispatchWorkspaceFileRelocated({ oldPath: '/w/a', newPath: '/w/b' });

    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({ oldPath: '/w/a', newPath: '/w/b' });
    window.removeEventListener(WORKSPACE_FILE_RELOCATED_EVENT, listener);
  });
});
