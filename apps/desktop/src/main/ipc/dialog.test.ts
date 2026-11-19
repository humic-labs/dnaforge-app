import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type {
  LocalIndexedTrackAuthorityReceipt,
  LocalIndexedTrackAuthorityRequest,
} from '../../shared/local-indexed-track-authority';
import { SidecarSessionAuthority } from '../sidecar-session-authority';

const h = vi.hoisted(() => ({
  handle: vi.fn<(channel: string, handler: unknown) => void>(),
  on: vi.fn<(channel: string, handler: (event: unknown, path: string) => void) => void>(),
  remember: vi.fn(),
  showOpenDialog: vi.fn(),
  issue: vi.fn<(request: LocalIndexedTrackAuthorityRequest) => LocalIndexedTrackAuthorityReceipt>(),
  waitForReadySnapshot: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('../../shared/ipc-contract', async () => {
  const { contractEntries } = await vi.importActual<typeof import('../../shared/ipc/contract')>(
    '../../shared/ipc/contract'
  );
  return {
    mainIpc: { handle: h.handle, on: h.on },
    handleGroup: (
      contract: import('../../shared/ipc/contract').AnyContractGroup,
      handlers: Record<string, unknown>
    ) => {
      for (const { method, channel } of contractEntries(contract)) {
        if (handlers[method]) h.handle(channel, handlers[method]);
      }
      return () => undefined;
    },
  };
});
vi.mock('electron', () => ({
  dialog: { showOpenDialog: h.showOpenDialog },
  BrowserWindow: { fromWebContents: () => ({}) },
}));
vi.mock('../selected-preview-files', () => ({ rememberSelectedPreviewFile: h.remember }));
vi.mock('../local-indexed-track-authority', () => ({
  issueLocalIndexedTrackAuthority: h.issue,
  registerSelectedLocalIndexedTrackPaths: vi.fn(),
}));
vi.mock('../sidecar-session-runtime', () => ({
  sidecarSessionAuthority: { waitForReadySnapshot: h.waitForReadySnapshot },
}));

import { registerDialogHandlers } from './dialog';

let authority: SidecarSessionAuthority;
type AuthorizeHandler = (
  event: unknown,
  request: LocalIndexedTrackAuthorityRequest
) => Promise<LocalIndexedTrackAuthorityReceipt>;

function authorizeHandler(): AuthorizeHandler {
  const registration = h.handle.mock.calls.find(
    ([channel]) => channel === 'dialog:authorizeLocalIndexedTrack'
  );
  if (!registration) throw new Error('Local track authorization IPC was not registered.');
  return registration[1] as AuthorizeHandler;
}

beforeEach(() => {
  vi.clearAllMocks();
  authority = new SidecarSessionAuthority({ initialToken: 'current-sidecar-session' });
  h.waitForReadySnapshot.mockImplementation(() => authority.waitForReadySnapshot());
  h.issue.mockImplementation(({ path }) => ({
    canonicalPath: path,
    authority: authority.currentToken(),
  }));
  registerDialogHandlers();
});

afterEach(() => authority.markStopped());

describe('local track authorization IPC', () => {
  it('holds a native selection until a ready session can sign it', async () => {
    const request = { path: '/selected/instant-genes.bed' };
    const result = Promise.resolve()
      .then(() => authorizeHandler()({}, request))
      .then(
        (receipt) => ({ receipt }),
        (error: unknown) => ({ error })
      );
    await Promise.resolve();
    expect(h.issue).not.toHaveBeenCalled();
    expect(h.waitForReadySnapshot).toHaveBeenCalledTimes(1);

    authority.markReady(authority.snapshot().generation);
    await expect(result).resolves.toEqual({
      receipt: { canonicalPath: request.path, authority: 'current-sidecar-session' },
    });
    expect(h.issue).toHaveBeenCalledExactlyOnceWith(request);
  });

  it('rejects a stopped session without issuing file authority', async () => {
    const result = Promise.resolve().then(() =>
      authorizeHandler()({}, { path: '/selected/instant-genes.bed' })
    );
    await Promise.resolve();
    authority.markStopped();
    await expect(result).rejects.toThrow('SIDECAR_SESSION_UNAVAILABLE');
    expect(h.issue).not.toHaveBeenCalled();
  });

  it('preserves path-authorization refusal after the session becomes ready', async () => {
    authority.markReady(authority.snapshot().generation);
    h.issue.mockImplementation(() => {
      throw new Error('Select this local indexed track through the DNAForge file picker first.');
    });
    await expect(
      Promise.resolve().then(() => authorizeHandler()({}, { path: '/unselected/private.bed' }))
    ).rejects.toThrow('Select this local indexed track through the DNAForge file picker first.');
  });
});

it('admits chosen paths from the native picker and top-level native file drops on another drive', async () => {
  const [picked, dropped] = [
    String.raw`D:\Project Files\read.ab1`,
    String.raw`E:\Public data\model.cif`,
  ];
  const handler = h.handle.mock.calls.find(([channel]) => channel === 'dialog:open')?.[1] as (
    event: unknown,
    options: unknown
  ) => Promise<string>;
  h.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [picked] });
  const mainFrame = {};
  const sender = { mainFrame };
  expect(await handler({ sender }, {})).toBe(picked);
  expect(h.remember.mock.calls).toEqual([[picked]]);
  const drop = h.on.mock.calls.find(([channel]) => channel === 'file-association:native-drop')![1];
  drop({ sender, senderFrame: {} }, dropped);
  expect(h.remember.mock.calls).toEqual([[picked]]);
  drop({ sender, senderFrame: mainFrame }, dropped);
  expect(h.remember.mock.calls).toEqual([[picked], [dropped]]);
});
