import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSelectedDocument } from './open-selected-document';
import { openFileBrowserFile } from '../../components/open-file-browser-file';
import { useCanvasStore } from '../canvas/public/store';
import {
  finishGenomeViewFileOpen,
  startPendingGenomeViewFileOpen,
} from '../sequence/public/genome-view-open-request';

const state = vi.hoisted(() => ({
  session: vi.fn(),
  bind: vi.fn(),
  close: vi.fn(),
  toast: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('../../utils/environment', () => ({
  isBrowserOnly: () => false,
  isHostedBrowserRuntime: () => false,
}));
vi.mock('../../platform', () => ({ platform: () => ({ fs: { stat: state.stat } }) }));
vi.mock('../../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: state.toast }) },
}));
vi.mock('../workspace-session/public/electron-session', () => ({
  openElectronWorkspaceSessionFile: state.session,
  bindElectronWorkspaceSessionTab: state.bind,
  closeElectronWorkspaceSessionFile: state.close,
}));

const path = '/lab/Instant genes.dnaforge-track-view.json';
const sessionPath = '/lab/.native-session/Instant genes';

beforeEach(() => {
  vi.clearAllMocks();
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
  });
});
afterEach(() => finishGenomeViewFileOpen(null));

function pendingOpen() {
  const admission = Promise.withResolvers<string>();
  state.session.mockReturnValueOnce(admission.promise);
  const controller = new AbortController();
  let opening!: ReturnType<typeof openSelectedDocument>;
  void openFileBrowserFile({ path }, (selectedPath, tabType) => {
    opening = openSelectedDocument(selectedPath, tabType, undefined, controller.signal);
  });
  expect(opening).toBeDefined();
  return {
    admission,
    controller,
    opening,
    async cleanup() {
      controller.abort();
      admission.resolve(sessionPath);
      finishGenomeViewFileOpen(null);
      await opening;
    },
  };
}

function loadingTab() {
  const panel = useCanvasStore.getState().panels.main;
  expect(panel.tabs).toHaveLength(1);
  expect(panel.activeTabId).toBe(panel.tabs[0].id);
  expect(panel.tabs[0]).toMatchObject({
    type: 'sequence',
    label: 'Instant genes',
    loadStatus: 'pending',
  });
  return panel.tabs[0].id;
}

describe('Files Track View presentation while native admission is pending', () => {
  it('presents loading chrome immediately, gates the read, and retains the admitted tab identity', async () => {
    const pending = pendingOpen();
    try {
      const tabId = loadingTab();
      expect(state.session).toHaveBeenCalledWith(path);
      expect(startPendingGenomeViewFileOpen()).toBeNull();
      expect(state.bind).not.toHaveBeenCalled();
      expect(state.stat).not.toHaveBeenCalled();
      pending.admission.resolve(sessionPath);
      await vi.waitFor(() => expect(startPendingGenomeViewFileOpen()).toBe(path));
      expect(loadingTab()).toBe(tabId);
      finishGenomeViewFileOpen(tabId);
      await expect(pending.opening).resolves.toMatchObject({ status: 'presented', tabId });
      expect(state.bind).toHaveBeenCalledWith(tabId, sessionPath);
      expect(state.close).not.toHaveBeenCalled();
    } finally {
      await pending.cleanup();
    }
  });

  it('removes the loading tab on native refusal without starting the file read', async () => {
    const pending = pendingOpen();
    try {
      loadingTab();
      expect(startPendingGenomeViewFileOpen()).toBeNull();
      pending.admission.reject(new Error('Native project admission refused'));
      await expect(pending.opening).resolves.toMatchObject({
        status: 'blocked',
        message: 'Native project admission refused',
      });
      expect(useCanvasStore.getState().panels.main.tabs).toEqual([]);
      expect(startPendingGenomeViewFileOpen()).toBeNull();
      expect(state.bind).not.toHaveBeenCalled();
      expect(state.stat).not.toHaveBeenCalled();
      expect(state.toast).toHaveBeenCalledOnce();
    } finally {
      await pending.cleanup();
    }
  });

  it('cancels the loading tab and releases a late admitted native session without reading', async () => {
    const pending = pendingOpen();
    try {
      loadingTab();
      expect(startPendingGenomeViewFileOpen()).toBeNull();
      pending.controller.abort();
      pending.admission.resolve(sessionPath);
      await expect(pending.opening).resolves.toMatchObject({ status: 'cancelled' });
      expect(useCanvasStore.getState().panels.main.tabs).toEqual([]);
      expect(startPendingGenomeViewFileOpen()).toBeNull();
      expect(state.close).toHaveBeenCalledWith(sessionPath);
      expect(state.bind).not.toHaveBeenCalled();
      expect(state.stat).not.toHaveBeenCalled();
      expect(state.toast).not.toHaveBeenCalled();
    } finally {
      await pending.cleanup();
    }
  });
});
