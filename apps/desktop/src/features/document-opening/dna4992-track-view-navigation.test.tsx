import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useCanvasStore } from '../canvas/public/store';
import { presentDocument } from '../canvas/public/present-document';
import { ReferenceGenomePicker } from '../sequence/public/components/ReferenceGenomePicker';
import { validateTrackViewDocument, type SavedTrackView } from '../../shared/track-view';
import { trackViewFixture } from '../../shared/track-view-fixture';
import {
  finishGenomeViewFileOpen,
  pendingGenomeViewFileOpen,
  requestGenomeViewFileOpen,
} from '../sequence/public/genome-view-open-request';
import { openDocument } from './open-document';
import { openSelectedDocument } from './open-selected-document';

const ports = vi.hoisted(() => ({
  read: vi.fn(),
  session: vi.fn(),
  bind: vi.fn(),
  close: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('../../utils/environment', () => ({
  isBrowserOnly: () => false,
  isHostedBrowserRuntime: () => false,
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    fs: { stat: ports.stat },
    trackViews: { read: ports.read, list: async () => ({ views: [], errors: [] }) },
    referenceAssets: {
      listHosted: async () => [],
      listLocal: async () => [],
      onHostedInstallProgress: () => () => {},
      onPreparationProgress: () => () => {},
    },
    lims: { queryEntities: async () => [] },
  }),
}));
vi.mock('../workspace-session/public/electron-session', () => ({
  openElectronWorkspaceSessionFile: ports.session,
  bindElectronWorkspaceSessionTab: ports.bind,
  closeElectronWorkspaceSessionFile: ports.close,
}));
vi.mock('../sequence/openAssembly', () => ({
  openAssembly: () => {
    throw new Error('An existing saved view must not reopen its reference.');
  },
}));

const path = '/lab/Measured signal.dnaforge-track-view.json';
const sessionPath = '/lab/.native-session/Measured signal';

function savedView(): SavedTrackView {
  return {
    document: validateTrackViewDocument(trackViewFixture()),
    path,
    workspaceRoot: '/lab',
    revision: 'a'.repeat(64),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ports.stat.mockImplementation(async (path: string) => ({
    canonicalPath: path,
    isDirectory: false,
    isFile: true,
    size: 10,
    mtime: 0,
    ctime: 0,
    mtimeNs: '0',
    ctimeNs: '0',
  }));
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
  });
});

afterEach(() => {
  cleanup();
  finishGenomeViewFileOpen(null);
});

async function openLater(kind: 'page' | 'file') {
  const result = await openDocument({
    target:
      kind === 'page'
        ? { kind: 'record', tabType: 'page', entityId: 'latest-notebook' }
        : { kind: 'file', path: '/lab/selection.txt', tabType: 'file' },
    label: 'Latest destination',
    placement: { kind: 'focused' },
    source: 'unknown',
  });
  expect(result.status).toBe('presented');
  if (result.status !== 'presented') throw new Error('The later destination was not presented.');
  expect(useCanvasStore.getState().panels.main.activeTabId).toBe(result.tabId);
  return result.tabId;
}

async function openLatest(kind: 'page' | 'file' | 'page-file-page') {
  if (kind !== 'page-file-page') return openLater(kind);
  const page = await openLater('page');
  const file = await openLater('file');
  expect(file).not.toBe(page);
  expect(await openLater('page')).toBe(page);
  return page;
}

function mountExistingView(saved: SavedTrackView) {
  const result = presentDocument({
    type: 'sequence',
    entityId: saved.document.id,
    label: saved.document.name,
    sequenceDocument: { kind: 'indexed-sequence', documentId: saved.document.id },
    trackView: saved,
  });
  if (result.status !== 'presented') throw new Error('The original view was not presented.');
  return result.tabId;
}

describe(' saved view completion preserves later navigation', () => {
  it.each(['page', 'file', 'page-file-page'] as const)(
    'native admission cannot reactivate a loading view after a later %s opens',
    async (kind) => {
      const admission = Promise.withResolvers<string>();
      ports.session.mockReturnValueOnce(admission.promise);
      const opening = openSelectedDocument(path, 'sequence');
      const loading = pendingGenomeViewFileOpen()!;
      expect(loading.path).toBe(path);
      expect(useCanvasStore.getState().panels.main.activeTabId).toBe(loading.tabId);
      const latest = await openLatest(kind);

      admission.resolve(sessionPath);
      await admission.promise;
      finishGenomeViewFileOpen(loading.tabId, loading.id);
      await expect(opening).resolves.toMatchObject({ status: 'presented', tabId: loading.tabId });

      const panel = useCanvasStore.getState().panels.main;
      expect(panel.tabs.map((tab) => tab.id)).toEqual(
        expect.arrayContaining([loading.tabId, latest])
      );
      expect(panel.activeTabId).toBe(latest);
      expect(ports.bind).toHaveBeenCalledWith(loading.tabId, sessionPath);
      expect(ports.close).not.toHaveBeenCalled();
      expect(pendingGenomeViewFileOpen()).toBeNull();
    }
  );

  it.each(['page', 'file', 'page-file-page'] as const)(
    'a delayed saved view read cannot reactivate its existing tab after a later %s opens',
    async (kind) => {
      const saved = savedView();
      const existing = mountExistingView(saved);
      const read = Promise.withResolvers<SavedTrackView>();
      ports.read.mockReturnValueOnce(read.promise);
      const opening = requestGenomeViewFileOpen(saved.document.id);
      const requestId = pendingGenomeViewFileOpen()!.id;
      const onClose = vi.fn();
      render(
        <ReferenceGenomePicker
          open
          backgroundFileOpen
          backgroundFileOpenRequestId={requestId}
          onClose={onClose}
        />
      );
      await waitFor(() => expect(ports.read).toHaveBeenCalledWith(saved.document.id));
      const latest = await openLatest(kind);

      await act(async () => {
        read.resolve(saved);
        await expect(opening).resolves.toBe(existing);
      });

      const panel = useCanvasStore.getState().panels.main;
      expect(panel.activeTabId).toBe(latest);
      expect(panel.tabs.find((tab) => tab.id === existing)?.trackView).toEqual(saved);
      expect(panel.tabs.map((tab) => tab.id)).toEqual(expect.arrayContaining([existing, latest]));
      expect(panel.tabs).toHaveLength(kind === 'page-file-page' ? 3 : 2);
      expect(pendingGenomeViewFileOpen()).toBeNull();
      expect(onClose).toHaveBeenCalledOnce();
    }
  );

  it('an ordinary current saved-view request activates its existing tab without duplicating it', async () => {
    const saved = savedView();
    const existing = mountExistingView(saved);
    const page = await openLater('page');
    ports.read.mockResolvedValueOnce(saved);
    const opening = requestGenomeViewFileOpen(saved.document.id);
    const requestId = pendingGenomeViewFileOpen()!.id;
    render(
      <ReferenceGenomePicker
        open
        backgroundFileOpen
        backgroundFileOpenRequestId={requestId}
        onClose={() => {}}
      />
    );
    await act(async () => {
      await expect(opening).resolves.toBe(existing);
    });
    const panel = useCanvasStore.getState().panels.main;
    expect(panel.activeTabId).toBe(existing);
    expect(panel.tabs.map((tab) => tab.id)).toEqual(expect.arrayContaining([existing, page]));
    expect(panel.tabs).toHaveLength(2);
    expect(panel.tabs.find((tab) => tab.id === existing)?.trackView).toEqual(saved);
    expect(pendingGenomeViewFileOpen()).toBeNull();
  });
});
