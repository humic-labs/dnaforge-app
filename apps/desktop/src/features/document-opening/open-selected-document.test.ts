import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentOpenResult } from '../canvas/public/document-presentation';
import { openSelectedDocument } from './open-selected-document';

const state = vi.hoisted(() => ({
  browser: false,
  hosted: false,
  session: vi.fn(),
  bind: vi.fn(),
  close: vi.fn(),
  open: vi.fn(),
  sourceKind: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('../../utils/environment', () => ({
  isBrowserOnly: () => state.browser,
  isHostedBrowserRuntime: () => state.hosted,
}));
vi.mock('../../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: state.toast }) },
}));
vi.mock('../workspace-session/public/electron-session', () => ({
  openElectronWorkspaceSessionFile: state.session,
  bindElectronWorkspaceSessionTab: state.bind,
  closeElectronWorkspaceSessionFile: state.close,
}));
vi.mock('./open-document', () => ({
  openDocument: state.open,
  resolveFileDocumentKindFromSource: state.sourceKind,
}));

const presented = {
  status: 'presented',
  tabId: 'opaque-tab',
  panelId: 'main',
  tabType: 'sequence',
  disposition: 'created',
  content: 'loading',
} satisfies DocumentOpenResult;

beforeEach(() => {
  vi.clearAllMocks();
  state.browser = false;
  state.hosted = false;
  state.session.mockResolvedValue('/PRIVATE_SESSION_PATH');
  state.open.mockResolvedValue(presented);
  state.sourceKind.mockImplementation(async (target) => target.tabType);
});

describe('selected-document guarded result authority', () => {
  it('passes an admitted saved genome view as a typed track-view target', async () => {
    const path = '/PRIVATE_GENOME_VIEW.dnaforge-track-view.json';
    await openSelectedDocument(path, 'sequence');
    expect(state.session).toHaveBeenCalledWith(path);
    expect(state.open).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'track-view', id: path } })
    );
    expect(state.bind).toHaveBeenCalledWith('opaque-tab', '/PRIVATE_SESSION_PATH');
  });

  it('returns the actual accepted result and binds the opened workspace session', async () => {
    await expect(
      openSelectedDocument('/PRIVATE_FILE.gb', 'sequence', 'PRIVATE_LABEL')
    ).resolves.toBe(presented);
    expect(state.open).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'file', path: '/PRIVATE_FILE.gb', tabType: 'sequence' },
      })
    );
    expect(state.bind).toHaveBeenCalledWith('opaque-tab', '/PRIVATE_SESSION_PATH');
    expect(state.close).not.toHaveBeenCalled();
  });

  it('returns verification refusal rather than a tab-type-shaped success', async () => {
    state.session.mockRejectedValue(new Error('PRIVATE_VERIFY_FAILURE'));
    await expect(openSelectedDocument('/PRIVATE_FILE.gb', 'sequence')).resolves.toEqual({
      status: 'blocked',
      message: 'PRIVATE_VERIFY_FAILURE',
    });
    expect(state.open).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledOnce();
    expect(state.toast).toHaveBeenCalledWith(
      '“PRIVATE_FILE.gb” could not be opened because its project record could not be verified. Reopen the project, then try again. Your file is preserved.',
      { definition: 'app-the-project-file-could-not-be-verified' }
    );
  });

  it('closes the acquired session when the actual destination refuses', async () => {
    const refused = {
      status: 'failed',
      message: 'PRIVATE_OPEN_FAILURE',
    } satisfies DocumentOpenResult;
    state.open.mockResolvedValue(refused);
    await expect(openSelectedDocument('/PRIVATE_FILE.gb', 'sequence')).resolves.toBe(refused);
    expect(state.close).toHaveBeenCalledWith('/PRIVATE_SESSION_PATH');
    expect(state.bind).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledOnce();
    expect(state.toast).toHaveBeenCalledWith(
      '“PRIVATE_FILE.gb” could not be opened. Your file is preserved.',
      { definition: 'project-verification-failed' }
    );
  });

  it('does not acquire or open after prior cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      openSelectedDocument('/PRIVATE_FILE.gb', 'sequence', undefined, controller.signal)
    ).resolves.toMatchObject({ status: 'cancelled' });
    expect(state.session).not.toHaveBeenCalled();
    expect(state.open).not.toHaveBeenCalled();
  });

  it('does not acquire a session or present after cancellation during native kind resolution', async () => {
    let finish!: (kind: 'protein') => void;
    state.sourceKind.mockReturnValueOnce(
      new Promise<'protein'>((resolve) => {
        finish = resolve;
      })
    );
    const controller = new AbortController();
    const opening = openSelectedDocument(
      '/PRIVATE_PROTEIN.fasta',
      'sequence',
      undefined,
      controller.signal
    );
    controller.abort();
    finish('protein');
    await expect(opening).resolves.toMatchObject({ status: 'cancelled' });
    expect(state.session).not.toHaveBeenCalled();
    expect(state.open).not.toHaveBeenCalled();
  });

  it('releases a late acquired session after cancellation without presenting', async () => {
    let finish!: (path: string) => void;
    state.session.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finish = resolve;
      })
    );
    const controller = new AbortController();
    const opening = openSelectedDocument(
      '/PRIVATE_FILE.gb',
      'sequence',
      undefined,
      controller.signal
    );
    controller.abort();
    finish('/PRIVATE_SESSION_PATH');
    await expect(opening).resolves.toMatchObject({ status: 'cancelled' });
    expect(state.close).toHaveBeenCalledWith('/PRIVATE_SESSION_PATH');
    expect(state.open).not.toHaveBeenCalled();
  });

  it('preserves the ordinary desktop nonsequence route without a sequence session gate', async () => {
    const image = { ...presented, tabType: 'image' } satisfies DocumentOpenResult;
    state.open.mockResolvedValue(image);
    await expect(openSelectedDocument('/PRIVATE_FILE.png', 'image')).resolves.toBe(image);
    expect(state.session).not.toHaveBeenCalled();
    expect(state.open).toHaveBeenCalledOnce();
  });

  it('keeps the hosted all-file verification gate on nonsequence targets', async () => {
    state.hosted = true;
    state.open.mockResolvedValue({ ...presented, tabType: 'image' });
    await openSelectedDocument('/PRIVATE_FILE.png', 'image');
    expect(state.session).toHaveBeenCalledWith('/PRIVATE_FILE.png');
    expect(state.bind).toHaveBeenCalledOnce();
  });

  it('keeps a browser-only route independent from native session authority', async () => {
    state.browser = true;
    await openSelectedDocument('/PRIVATE_FILE.gb', 'sequence');
    expect(state.session).not.toHaveBeenCalled();
    expect(state.open).toHaveBeenCalledOnce();
  });
});
