import { afterEach, describe, expect, it } from 'vitest';
import { useCanvasStore, partializeCanvasState } from '../canvas/public/store';
import {
  finishGenomeViewFileOpen,
  pendingGenomeViewFileOpen,
  requestGenomeViewFileOpen,
  startPendingGenomeViewFileOpen,
} from './public/genome-view-open-request';

afterEach(() => {
  finishGenomeViewFileOpen(null);
  useCanvasStore.getState().reset();
});

describe('project-file genome view opening', () => {
  it('opens a transient tab immediately and cancels when that tab is closed', async () => {
    const opened = requestGenomeViewFileOpen('/project/Genes.dnaforge-track-view.json');
    const request = pendingGenomeViewFileOpen()!;
    const panel = Object.values(useCanvasStore.getState().panels).find((candidate) =>
      candidate.tabs.some((tab) => tab.id === request.tabId)
    )!;
    expect(panel.tabs.find((tab) => tab.id === request.tabId)).toMatchObject({
      label: 'Genes',
      loadStatus: 'pending',
      openingTrackViewPath: '/project/Genes.dnaforge-track-view.json',
    });
    expect(
      Object.values(partializeCanvasState(useCanvasStore.getState()).panels).flatMap(
        (candidate) => candidate.tabs
      )
    ).not.toContainEqual(expect.objectContaining({ id: request.tabId }));

    useCanvasStore.getState().closeTab(panel.id, request.tabId);
    await expect(opened).resolves.toBeNull();
    expect(pendingGenomeViewFileOpen()).toBeNull();
    expect(useCanvasStore.getState().recentlyClosed).not.toContainEqual(
      expect.objectContaining({ tab: expect.objectContaining({ id: request.tabId }) })
    );
  });

  it('joins repeated opens of the same file while the first is still opening', async () => {
    const first = requestGenomeViewFileOpen('/project/view.dnaforge-track-view.json');
    const second = requestGenomeViewFileOpen('/project/view.dnaforge-track-view.json');
    expect(second).toBe(first);
    expect(startPendingGenomeViewFileOpen()).toBe('/project/view.dnaforge-track-view.json');
    finishGenomeViewFileOpen('tab-1');
    await expect(second).resolves.toBe('tab-1');
  });

  it('hands one request to the recovery picker and resolves with its tab', async () => {
    const opened = requestGenomeViewFileOpen('/project/view.dnaforge-track-view.json');
    expect(startPendingGenomeViewFileOpen()).toBe('/project/view.dnaforge-track-view.json');
    expect(startPendingGenomeViewFileOpen()).toBeNull();
    finishGenomeViewFileOpen('tab-1');
    await expect(opened).resolves.toBe('tab-1');
    expect(pendingGenomeViewFileOpen()).toBeNull();
  });

  it('supersedes a stalled file open when a different view is requested', async () => {
    const first = requestGenomeViewFileOpen('/project/first.dnaforge-track-view.json');
    const firstRequestId = pendingGenomeViewFileOpen()!.id;
    expect(startPendingGenomeViewFileOpen()).toBe('/project/first.dnaforge-track-view.json');

    const second = requestGenomeViewFileOpen('/project/second.dnaforge-track-view.json');
    await expect(first).resolves.toBeNull();
    finishGenomeViewFileOpen('old-tab', firstRequestId);
    expect(pendingGenomeViewFileOpen()?.path).toBe('/project/second.dnaforge-track-view.json');
    expect(startPendingGenomeViewFileOpen()).toBe('/project/second.dnaforge-track-view.json');
    finishGenomeViewFileOpen('tab-2');
    await expect(second).resolves.toBe('tab-2');
  });

  it('does not let an old abort cancel a newer open', async () => {
    const firstController = new AbortController();
    const first = requestGenomeViewFileOpen(
      '/project/first.dnaforge-track-view.json',
      undefined,
      firstController.signal
    );
    finishGenomeViewFileOpen('tab-1');
    await expect(first).resolves.toBe('tab-1');

    const second = requestGenomeViewFileOpen('/project/second.dnaforge-track-view.json');
    firstController.abort();
    expect(pendingGenomeViewFileOpen()?.path).toBe('/project/second.dnaforge-track-view.json');
    finishGenomeViewFileOpen(null);
    await expect(second).resolves.toBeNull();
  });
});
