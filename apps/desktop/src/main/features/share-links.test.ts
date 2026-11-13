// @vitest-environment node
import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  showMessageBox: vi.fn(async (_options: { message: string; type?: string }) => ({ response: 0 })),
  showErrorBox: vi.fn(),
  sendRendererIpc: vi.fn(),
  authStatus: { value: 'signed-out' },
  focus: vi.fn(),
  importShare: vi.fn(),
  prepareImport: vi.fn(),
  openProject: vi.fn(),
  row: vi.fn(),
}));

vi.mock('electron', () => ({
  dialog: { showMessageBox: mocks.showMessageBox, showErrorBox: mocks.showErrorBox },
}));
vi.mock('../../shared/ipc-contract', () => ({ sendRendererIpc: mocks.sendRendererIpc }));
vi.mock('../auth/controller', () => ({
  getAuthState: () => ({ status: mocks.authStatus.value }),
  getActiveSession: async () =>
    mocks.authStatus.value === 'signed-in'
      ? { accountId: 'owner', desktopSessionId: 'desktop-one', email: 'owner@example.test' }
      : null,
}));
vi.mock('../desktop-sync-client', () => ({ createDesktopSyncClient: () => ({}) }));
vi.mock('../background-window-mode', () => ({ focusWindowUnlessBackground: mocks.focus }));
vi.mock('../ipc/database', () => ({
  getDb: () => ({ prepare: () => ({ get: mocks.row }) }),
}));
vi.mock('../ipc/workspace-git', () => ({ managedRootDir: () => '/managed' }));
vi.mock('../workspace-sync-import-share', () => ({
  importShareIntoManagedWorkspace: mocks.importShare,
  prepareDeepShareImport: mocks.prepareImport,
  createAuthenticatedDeepShareImportClient: vi.fn(() => ({})),
}));
vi.mock('../workspace-sync-projects', () => ({ openWorkspaceSyncProject: mocks.openProject }));

import { isImportShareUrl } from '../workspace-sync-import-share-url';
import { isOpenOrganizationsUrl } from '../workspace-sync-open-organizations-url';
import { isOpenSharedProjectUrl } from '../workspace-sync-open-shared-project-url';
import type { MainFeature, MainFeatureContext } from './main-feature';
import { createShareLinksFeature } from './share-links';

const TOKEN = 't'.repeat(24);
const IMPORT = `dnaforge://import-share?shortId=shortid01&token=${TOKEN}`;
const IMPORT_NEXT = `dnaforge://import-share?shortId=shortid02&token=${TOKEN}`;
const WORKSPACE_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OPEN = `dnaforge://open-shared-project?workspaceId=${WORKSPACE_ID}`;
const ORGS = 'dnaforge://open-organizations';

function liveWindow(destroyed = false) {
  const webContents = { id: 7 };
  const window = { isDestroyed: () => destroyed, webContents } as BrowserWindow;
  return { window, webContents };
}

function open(feature: MainFeature, url: string, context: MainFeatureContext): void {
  const route = feature.protocolRoutes?.find((candidate) => candidate.matches(url));
  if (!route) throw new Error(`no route for ${url}`);
  route.open(url, context);
}

function messages(): string[] {
  return mocks.showMessageBox.mock.calls.map(([options]) => options.message);
}

const fork = (repoPath: string) => ({
  displayName: 'Fork',
  repoPath,
  lineage: { notice: 'Forked from a Deep Share.' },
  warnings: ['One warning.'],
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authStatus.value = 'signed-out';
  mocks.showMessageBox.mockImplementation(async (options) => ({
    response: options.type === 'question' ? 1 : 0,
  }));
  mocks.prepareImport.mockResolvedValue({
    review: {
      source: {
        artifactName: 'Reviewed sequence',
        fileCount: 2,
        conversationCount: 1,
        bundleSha256: 'reviewed-bundle',
      },
      destination: { displayName: 'Fork', repoPath: '/managed/fork' },
    },
  });
});

describe('share links main feature', () => {
  it('routes import-share, open-shared-project and open-organizations links, in that order', () => {
    const feature = createShareLinksFeature();

    expect(feature.protocolRoutes?.map((route) => route.matches)).toEqual([
      isImportShareUrl,
      isOpenSharedProjectUrl,
      isOpenOrganizationsUrl,
    ]);
    expect(feature.protocolRoutes?.some((route) => route.matches('dnaforge://auth?code=1'))).toBe(
      false
    );
  });

  it('asks a signed-out user to sign in, then resumes each held link on sign-in', async () => {
    const feature = createShareLinksFeature();
    const { window, webContents } = liveWindow();
    const context = { getMainWindow: () => window };

    open(feature, IMPORT, context);
    open(feature, OPEN, context);
    open(feature, ORGS, context);

    expect(messages()).toEqual([
      'Sign in to import this Deep Share',
      'Sign in to open this shared project',
      'Sign in to open your organizations',
    ]);
    expect(mocks.focus.mock.calls).toEqual([[window], [window], [window]]);
    expect(mocks.importShare).not.toHaveBeenCalled();

    mocks.authStatus.value = 'signed-in';
    mocks.importShare.mockResolvedValue(fork('/managed/fork'));
    mocks.openProject.mockResolvedValue({ ok: true, workspaceUuid: 'uuid-1' });
    mocks.row.mockReturnValue({ path: '/managed/shared', name: 'Shared' });
    feature.onSignedIn?.(context);

    expect(mocks.sendRendererIpc).toHaveBeenCalledWith(webContents, 'menu:organizations');
    await vi.waitFor(() =>
      expect(mocks.importShare).toHaveBeenCalledWith(
        expect.objectContaining({
          shortId: 'shortid01',
          token: '',
          managedRootDir: '/managed',
          prepared: expect.anything(),
          assertAuthority: expect.any(Function),
        })
      )
    );
    expect(mocks.prepareImport).toHaveBeenCalledWith(
      expect.objectContaining({ shortId: 'shortid01', token: TOKEN, managedRootDir: '/managed' })
    );
    expect(mocks.prepareImport.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.importShare.mock.invocationCallOrder[0] ?? 0
    );
    await vi.waitFor(() =>
      expect(mocks.openProject).toHaveBeenCalledWith(expect.anything(), {
        remoteWorkspaceId: WORKSPACE_ID,
        managedRootDir: '/managed',
      })
    );
    await vi.waitFor(() =>
      expect(mocks.sendRendererIpc).toHaveBeenCalledWith(
        webContents,
        'workspace:set-path',
        '/managed/shared',
        expect.any(String),
        'managed_sync'
      )
    );
    feature.onSignedIn?.(context);
    expect(mocks.importShare).toHaveBeenCalledTimes(1);
  });

  it('opens a signed-in import in the window and holds a second link until it finishes', async () => {
    mocks.authStatus.value = 'signed-in';
    const feature = createShareLinksFeature();
    const { window, webContents } = liveWindow();
    const context = { getMainWindow: () => window };
    let finish!: (value: ReturnType<typeof fork>) => void;
    mocks.importShare
      .mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
      .mockResolvedValueOnce(fork('/managed/next'));

    open(feature, IMPORT, context);
    open(feature, IMPORT_NEXT, context);

    await vi.waitFor(() => expect(mocks.importShare).toHaveBeenCalledTimes(1));
    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'question',
        buttons: ['Cancel', 'Import private fork'],
        defaultId: 0,
        cancelId: 0,
      })
    );
    expect(messages()).not.toContain('Private fork opened');
    finish(fork('/managed/first'));

    await vi.waitFor(() => expect(mocks.importShare).toHaveBeenCalledTimes(2));
    expect(mocks.importShare.mock.calls[1]?.[0]).toMatchObject({ shortId: 'shortid02' });
    expect(mocks.sendRendererIpc).toHaveBeenCalledWith(
      webContents,
      'workspace:set-path',
      '/managed/first',
      expect.any(String),
      'managed_sync'
    );
    expect(mocks.showMessageBox).toHaveBeenCalledWith({
      type: 'info',
      message: 'Private fork opened',
      detail: [
        'Imported as a private local fork. Changes do not affect the sender.',
        'Opened “Fork” as a new local project. Enable cloud backup if you want it on this account.',
        'Import notices: 1. Review the imported project before continuing.',
      ].join('\n\n'),
    });
  });

  it('reports a failed import with the error box', async () => {
    mocks.authStatus.value = 'signed-in';
    const feature = createShareLinksFeature();
    mocks.importShare.mockRejectedValue(new Error('bundle refused'));

    open(feature, IMPORT, { getMainWindow: () => null });

    await vi.waitFor(() =>
      expect(mocks.showErrorBox).toHaveBeenCalledWith(
        'Could not open shared project',
        'We couldn’t open this shared project. Try again.'
      )
    );
  });

  it('cancels the exact human import review without writing or exposing its capability', async () => {
    mocks.authStatus.value = 'signed-in';
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    const feature = createShareLinksFeature();
    open(feature, IMPORT, { getMainWindow: () => liveWindow().window });
    await vi.waitFor(() =>
      expect(mocks.showMessageBox).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'question' })
      )
    );
    expect(JSON.stringify(mocks.showMessageBox.mock.calls)).not.toContain(TOKEN);
    expect(mocks.importShare).not.toHaveBeenCalled();
    expect(mocks.sendRendererIpc).not.toHaveBeenCalled();
  });

  it('reports a refused shared-project open and a missing local record', async () => {
    mocks.authStatus.value = 'signed-in';
    const feature = createShareLinksFeature();
    const context = { getMainWindow: () => liveWindow().window };
    mocks.openProject.mockResolvedValueOnce({ ok: false, message: 'No access.' });

    open(feature, OPEN, context);
    await vi.waitFor(() =>
      expect(mocks.showErrorBox).toHaveBeenCalledWith(
        'Could not open shared project',
        'We couldn’t open this shared project. Try again.'
      )
    );

    mocks.openProject.mockResolvedValueOnce({ ok: true, workspaceUuid: 'uuid-2' });
    mocks.row.mockReturnValueOnce(undefined);
    open(feature, OPEN, context);
    await vi.waitFor(() =>
      expect(mocks.showErrorBox).toHaveBeenLastCalledWith(
        'Could not open shared project',
        'The project was downloaded but its local record was not found.'
      )
    );
    expect(mocks.sendRendererIpc).not.toHaveBeenCalled();
  });

  it('shows warnings after opening a shared project', async () => {
    mocks.authStatus.value = 'signed-in';
    const feature = createShareLinksFeature();
    mocks.openProject.mockResolvedValue({
      ok: true,
      workspaceUuid: 'uuid-3',
      warnings: ['a', 'b'],
    });
    mocks.row.mockReturnValue({ path: '/managed/shared', name: 'Shared' });

    open(feature, OPEN, { getMainWindow: () => liveWindow().window });

    await vi.waitFor(() =>
      expect(mocks.showMessageBox).toHaveBeenCalledWith({
        type: 'info',
        message: 'Opened “Shared”',
        detail: 'The project opened with 2 notices. Review the project before continuing.',
      })
    );
  });

  it('sends the organizations command only to a live window', () => {
    mocks.authStatus.value = 'signed-in';
    const feature = createShareLinksFeature();
    const destroyed = liveWindow(true);

    open(feature, ORGS, { getMainWindow: () => destroyed.window });
    open(feature, ORGS, { getMainWindow: () => null });
    expect(mocks.sendRendererIpc).not.toHaveBeenCalled();
    expect(mocks.focus).not.toHaveBeenCalled();

    const live = liveWindow();
    open(feature, ORGS, { getMainWindow: () => live.window });
    expect(mocks.focus).toHaveBeenCalledWith(live.window);
    expect(mocks.sendRendererIpc).toHaveBeenCalledWith(live.webContents, 'menu:organizations');
  });
});
