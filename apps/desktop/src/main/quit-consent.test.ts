import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import { configureUnsavedWorkSaver, showUnsavedWorkDialog } from './quit-consent';
import { SaveAllCancelled, SaveAllError } from '../shared/save-all-result';

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

describe('native save failure details', () => {
  it('returns to the dirty document when the user cancels the Save As picker', async () => {
    const discardRecoveryCopies = vi.fn();
    configureUnsavedWorkSaver({
      canSave: () => true,
      saveAll: async () => {
        throw new SaveAllCancelled();
      },
      readDirty: async () => ({ hasDirtyWork: true, details: '1 sequence' }),
      discardRecoveryCopies,
    });
    showMessageBox.mockResolvedValueOnce({ response: 2 });
    expect(
      await showUnsavedWorkDialog(windowFixture(), { staged: false, details: '1 sequence' })
    ).toBe('cancel');
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(discardRecoveryCopies).not.toHaveBeenCalled();
  });
  it.each([
    ['win32', false],
    ['win32', true],
    ['darwin', false],
    ['darwin', true],
  ] as const)(
    'names the failed file and reason while keeping Cancel safe on %s (restart=%s)',
    async (platform, staged) => {
      usePlatform(platform);
      const discardRecoveryCopies = vi.fn(async () => {});
      const path =
        platform === 'win32' ? 'C:\\workspace\\Blocked Save.txt' : '/workspace/Blocked Save.txt';
      configureUnsavedWorkSaver({
        canSave: () => true,
        saveAll: async () => {
          throw new SaveAllError([
            { documentId: 'doc-blocked', path, error: 'The text file is read-only.' },
          ]);
        },
        readDirty: async () => ({ hasDirtyWork: true, details: '1 text file' }),
        discardRecoveryCopies,
      });
      showMessageBox.mockResolvedValueOnce({ response: 2 }).mockResolvedValueOnce({ response: 0 });
      expect(
        await showUnsavedWorkDialog(windowFixture(), { staged, details: '2 text files' })
      ).toBe('cancel');
      const options = showMessageBox.mock.calls[1].at(-1) as MessageBoxOptions;
      expect(options).toMatchObject({
        detail: `Blocked Save.txt: The text file is read-only.\n\nCancel to keep working and try saving again, or ${staged ? 'restart' : 'close'} without them.`,
        buttons: ['Cancel', staged ? 'Restart Without Saving' : 'Close Without Saving'],
        defaultId: 0,
        cancelId: 0,
      });
      expect(options.detail).not.toContain('workspace');
      expect(discardRecoveryCopies).not.toHaveBeenCalled();
    }
  );

  it('does not proceed on a failed acknowledgement even when the dirty cache appears clean', async () => {
    configureUnsavedWorkSaver({
      canSave: () => true,
      saveAll: async () => {
        throw new SaveAllError([
          { documentId: null, error: 'Saving timed out before the editor confirmed completion.' },
        ]);
      },
      readDirty: () => ({ hasDirtyWork: false, details: '' }),
    });
    showMessageBox.mockResolvedValueOnce({ response: 2 }).mockResolvedValueOnce({ response: 0 });
    expect(
      await showUnsavedWorkDialog(windowFixture(), { staged: true, details: '1 text file' })
    ).toBe('cancel');
    expect(showMessageBox.mock.calls[1][1].detail).toContain('Saving timed out');
  });

  it('bounds native error details and removes the affected absolute path from its reason', async () => {
    configureUnsavedWorkSaver({
      canSave: () => true,
      saveAll: async () => {
        throw new SaveAllError(
          Array.from({ length: 6 }, (_, index) => ({
            documentId: `doc-${index}`,
            path: `/private/project/blocked-${index}.txt`,
            error: `EACCES: permission denied, open '/private/project/blocked-${index}.txt'\n${'x'.repeat(1000)}`,
          }))
        );
      },
      readDirty: () => ({ hasDirtyWork: true, details: '6 text files' }),
    });
    showMessageBox.mockResolvedValueOnce({ response: 2 }).mockResolvedValueOnce({ response: 0 });
    await showUnsavedWorkDialog(windowFixture(), { staged: false, details: '6 text files' });
    const detail = showMessageBox.mock.calls[1][1].detail as string;
    expect(detail).toContain('blocked-0.txt: EACCES: permission denied');
    expect(detail).not.toContain('/private/project');
    expect(detail).toContain('And 1 more save failure.');
    expect(detail.length).toBeLessThan(2000);
  });
});
