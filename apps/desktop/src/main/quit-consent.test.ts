import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import { configureUnsavedWorkSaver, showUnsavedWorkDialog } from './quit-consent';

const { showMessageBox } = vi.hoisted(() => ({ showMessageBox: vi.fn() }));
vi.mock('electron', () => ({
  app: { isPackaged: false },
  dialog: { showMessageBox },
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
function usePlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function windowFixture(destroyed = false): BrowserWindow {
  return { isDestroyed: () => destroyed, show: vi.fn() } as unknown as BrowserWindow;
}

beforeEach(() => {
  showMessageBox.mockReset().mockResolvedValue({ response: 0, checkboxChecked: false });
  usePlatform('win32');
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  configureUnsavedWorkSaver(null);
});

describe('unsaved-work native warning', () => {
  it.each([false, true])(
    'owns the Windows warning and keeps cancel safe (staged=%s)',
    async (staged) => {
      const win = windowFixture();
      expect(await showUnsavedWorkDialog(win, { staged, details: '2 sequences' })).toBe('cancel');
      expect(win.show).toHaveBeenCalledOnce();
      expect(showMessageBox).toHaveBeenCalledWith(
        win,
        expect.objectContaining({
          title: 'Unsaved Changes',
          message: 'You have unsaved changes in 2 sequences.',
          buttons: ['Cancel', staged ? 'Restart Anyway' : 'Close Anyway'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          detail: expect.stringContaining('Ctrl+S'),
        })
      );
    }
  );

  it('preserves the parentless macOS warning and Cmd+S copy', async () => {
    usePlatform('darwin');
    await showUnsavedWorkDialog(windowFixture(), { staged: false, details: '2 sequences' });
    expect(showMessageBox.mock.calls[0]).toHaveLength(1);
    const options = showMessageBox.mock.calls[0][0] as MessageBoxOptions;
    expect(options.detail).toContain('Cmd+S');
    expect(options.noLink).toBeUndefined();
    expect(options.buttons).toEqual(['Cancel', 'Close Anyway']);
  });

  it.each([null, windowFixture(true)])(
    'does not attach to a missing or destroyed owner',
    async (win) => {
      await showUnsavedWorkDialog(win, { staged: false, details: '2 sequences' });
      expect(showMessageBox.mock.calls[0]).toHaveLength(1);
      expect(showMessageBox.mock.calls[0][0]).toMatchObject({ noLink: true, cancelId: 0 });
      if (win) expect(win.show).not.toHaveBeenCalled();
    }
  );

  it.each([
    [-1, 'cancel'],
    [0, 'cancel'],
    [1, 'proceed'],
    [2, 'cancel'],
  ] as const)('requires explicit discard consent (response=%s)', async (response, decision) => {
    showMessageBox.mockResolvedValueOnce({ response, checkboxChecked: false });
    expect(
      await showUnsavedWorkDialog(windowFixture(), {
        staged: false,
        details: '2 sequences',
      })
    ).toBe(decision);
  });

  it('shares an open warning across close, quit, and update, then prompts again after cancel', async () => {
    let answer!: (result: MessageBoxReturnValue) => void;
    showMessageBox.mockImplementationOnce(
      () =>
        new Promise<MessageBoxReturnValue>((resolve) => {
          answer = resolve;
        })
    );
    const win = windowFixture();
    const close = showUnsavedWorkDialog(win, { staged: false, details: '2 sequences' });
    const quit = showUnsavedWorkDialog(win, { staged: false, details: '2 sequences' });
    const update = showUnsavedWorkDialog(win, { staged: true, details: '2 sequences' });
    expect(showMessageBox).toHaveBeenCalledOnce();
    answer({ response: 0, checkboxChecked: false });
    expect(await Promise.all([close, quit, update])).toEqual(['cancel', 'cancel', 'cancel']);
    await showUnsavedWorkDialog(win, { staged: false, details: '2 sequences' });
    expect(showMessageBox).toHaveBeenCalledTimes(2);
  });

  it('allows a fresh warning after native dialog failure', async () => {
    showMessageBox.mockRejectedValueOnce(new Error('native dialog unavailable'));
    await expect(
      showUnsavedWorkDialog(windowFixture(), {
        staged: false,
        details: '2 sequences',
      })
    ).rejects.toThrow('native dialog unavailable');
    expect(
      await showUnsavedWorkDialog(windowFixture(), {
        staged: false,
        details: '2 sequences',
      })
    ).toBe('cancel');
    expect(showMessageBox).toHaveBeenCalledTimes(2);
  });
});

describe('saving from the unsaved-work warning ', () => {
  const discardRecoveryCopies = vi.fn(async () => undefined);
  function saverFixture(canSave: boolean, dirtyAfterSave: boolean) {
    const saveAll = vi.fn(async () => undefined);
    discardRecoveryCopies.mockClear();
    configureUnsavedWorkSaver({
      canSave: () => canSave,
      saveAll,
      discardRecoveryCopies,
      readDirty: () =>
        dirtyAfterSave
          ? { hasDirtyWork: true, details: '1 sequence' }
          : { hasDirtyWork: false, details: '' },
    });
    return saveAll;
  }

  it('offers Save when the window can answer, and proceeds once everything saved', async () => {
    const saveAll = saverFixture(true, false);
    const win = windowFixture();
    showMessageBox.mockResolvedValueOnce({ response: 2, checkboxChecked: false });
    expect(await showUnsavedWorkDialog(win, { staged: false, details: '2 sequences' })).toBe(
      'proceed'
    );
    expect(saveAll).toHaveBeenCalledWith(win);
    expect(showMessageBox).toHaveBeenCalledOnce();
    expect(showMessageBox.mock.calls[0][1]).toMatchObject({
      buttons: ['Cancel', 'Close Without Saving', 'Save and Close'],
      defaultId: 2,
      cancelId: 0,
    });
  });

  it('asks again instead of closing when something could not be saved', async () => {
    saverFixture(true, true);
    showMessageBox
      .mockResolvedValueOnce({ response: 2, checkboxChecked: false })
      .mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    expect(
      await showUnsavedWorkDialog(windowFixture(), { staged: true, details: '2 sequences' })
    ).toBe('cancel');
    expect(showMessageBox.mock.calls[1][1]).toMatchObject({
      message: "DNAForge couldn't save 1 sequence.",
      buttons: ['Cancel', 'Restart Without Saving'],
    });
  });

  it('offers no Save button when the window has stopped responding, and says why', async () => {
    const saveAll = saverFixture(false, true);
    showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    expect(
      await showUnsavedWorkDialog(windowFixture(), {
        staged: false,
        details: '2 sequences',
        action: 'reload',
      })
    ).toBe('proceed');
    expect(saveAll).not.toHaveBeenCalled();
    expect(showMessageBox.mock.calls[0][1]).toMatchObject({
      buttons: ['Cancel', 'Reload Anyway'],
      detail: expect.stringContaining("isn't responding"),
    });
  });

  it('drops recovery copies on an explicit discard from a live window only', async () => {
    saverFixture(true, false);
    showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    await showUnsavedWorkDialog(windowFixture(), { staged: false, details: '2 sequences' });
    expect(discardRecoveryCopies).toHaveBeenCalledOnce();

    saverFixture(false, true);
    showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    await showUnsavedWorkDialog(windowFixture(), { staged: false, details: '2 sequences' });
    expect(discardRecoveryCopies).not.toHaveBeenCalled();
  });
});
