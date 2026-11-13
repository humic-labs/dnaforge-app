import { userMessage } from '@waypoint/user-messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { showMessageBox } = vi.hoisted(() => ({ showMessageBox: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: false }, dialog: { showMessageBox } }));
import { createQuitPromptBinding } from './quit-prompt-binding';
import { configureUnsavedWorkSaver, showUnsavedWorkDialog } from './quit-consent';
afterEach(() => {
  configureUnsavedWorkSaver(null);
  showMessageBox.mockReset();
});
describe('native dirty work during close', () => {
  it('keeps a pending close read from destroying the window after quit orchestration takes ownership', async () => {
    let resolve!: (dirty: { hasDirtyWork: boolean; details: string }) => void;
    const dirty = new Promise<{ hasDirtyWork: boolean; details: string }>((done) => {
      resolve = done;
    });
    const queued: Array<() => void> = [],
      destroy = vi.fn();
    const win = { isDestroyed: () => false, destroy };
    const binding = createQuitPromptBinding({
      isSuppressed: () => false,
      isCutoverBuild: () => false,
      getDirty: () => ({ hasDirtyWork: false, details: '' }),
      readDirty: () => dirty,
      isUpdateStaged: () => false,
      hasConsent: () => false,
      grantConsent: vi.fn(),
      showDialog: async () => 'cancel',
      getWindow: () => win,
      runQuit: async () => ({ cancelled: true }),
      schedule: (run) => queued.push(run),
    });
    binding.onWindowClose({ preventDefault: vi.fn() }, win);
    queued.shift()!();
    binding.onBeforeQuit({ preventDefault: vi.fn() });
    resolve({ hasDirtyWork: false, details: '' });
    await Promise.resolve();
    await Promise.resolve();
    expect(destroy).not.toHaveBeenCalled();
  });
  it('prevents a clean cached close until the fresh native read finishes', async () => {
    let resolve!: (dirty: { hasDirtyWork: boolean; details: string }) => void;
    const readDirty = vi.fn(
      () =>
        new Promise<{ hasDirtyWork: boolean; details: string }>((done) => {
          resolve = done;
        })
    );
    const preventDefault = vi.fn(),
      destroy = vi.fn(),
      dialog = vi.fn(async () => 'cancel' as const);
    let scheduled!: () => void;
    const win = { isDestroyed: () => false, destroy };
    const binding = createQuitPromptBinding({
      isSuppressed: () => false,
      isCutoverBuild: () => false,
      getDirty: () => ({ hasDirtyWork: false, details: '' }),
      readDirty,
      isUpdateStaged: () => false,
      hasConsent: () => false,
      grantConsent: vi.fn(),
      showDialog: dialog,
      getWindow: () => win,
      runQuit: async () => ({ cancelled: false }),
      schedule: (run) => {
        scheduled = run;
      },
    });
    binding.onWindowClose({ preventDefault }, win);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(readDirty).not.toHaveBeenCalled();
    scheduled();
    expect(destroy).not.toHaveBeenCalled();
    resolve({ hasDirtyWork: true, details: '1 text file' });
    await Promise.resolve();
    await Promise.resolve();
    expect(dialog).toHaveBeenCalledWith(win, { staged: false, details: '1 text file' });
    expect(destroy).not.toHaveBeenCalled();
  });
  it('shows the remaining work after a rejected save instead of unwinding into quit', async () => {
    const saveAll = vi.fn(async () => {
      throw new Error('Native revision changed.');
    });
    configureUnsavedWorkSaver({
      canSave: () => true,
      saveAll,
      readDirty: async () => ({ hasDirtyWork: true, details: '1 sequence' }),
    });
    showMessageBox.mockResolvedValueOnce({ response: 2 }).mockResolvedValueOnce({ response: 0 });
    expect(await showUnsavedWorkDialog(null, { staged: false, details: '1 sequence' })).toBe(
      'cancel'
    );
    expect(showMessageBox.mock.calls[1][0]).toMatchObject({
      title: 'Some Changes Were Not Saved',
      message: "DNAForge couldn't save 1 sequence.",
    });
  });
  it('keeps native recovery when an explicit discard could not cross the flush fence', async () => {
    configureUnsavedWorkSaver({
      canSave: () => true,
      saveAll: async () => {},
      readDirty: async () => ({ hasDirtyWork: true, details: '1 text file' }),
      discardRecoveryCopies: async () => {
        throw new Error('An editor transaction is pending.');
      },
    });
    showMessageBox.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 });
    expect(await showUnsavedWorkDialog(null, { staged: false, details: '1 text file' })).toBe(
      'cancel'
    );
    expect(showMessageBox.mock.calls[1][0]).toMatchObject({
      title: userMessage('dialog.discard-could-not-be-confirmed'),
      buttons: ['Cancel'],
    });
  });
});
