import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrowserWindow } from 'electron';

type TemplateItem = {
  id?: string;
  label?: string;
  role?: string;
  accelerator?: string;
  type?: string;
  click?: (...args: unknown[]) => void;
  submenu?: TemplateItem[];
};

let capturedTemplate: TemplateItem[] | null = null;
const reloadSpy = vi.fn();
const reloadIgnoringCacheSpy = vi.fn();

const { showMessageBox, openExternal, setAboutPanelOptions } = vi.hoisted(() => ({
  showMessageBox: vi.fn(async (): Promise<{ response: number }> => ({ response: 1 })),
  openExternal: vi.fn(async () => undefined),
  setAboutPanelOptions: vi.fn(),
}));

vi.mock('../../lib/app-build', () => ({
  APP_BUILD: {
    kind: 'development',
    version: '0.9.8+dev.4.g535acc37d41f',
    sourceReleaseVersion: '0.9.8',
    sourceCommit: '535acc37d41f1794b20563a2f20a9e0d9051f420',
    sourceModified: false,
  },
}));

vi.mock('electron', () => ({
  app: { name: 'DNAForge', isPackaged: true, setAboutPanelOptions },
  BrowserWindow: vi.fn(),

  dialog: { showMessageBox },
  shell: { openExternal },
  Menu: {
    buildFromTemplate: vi.fn((template: TemplateItem[]) => {
      capturedTemplate = template;
      return { __isMenu: true };
    }),
    setApplicationMenu: vi.fn(),
  },
}));

vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false },
}));

const { dirtyState } = vi.hoisted(() => ({
  dirtyState: vi.fn((): { hasDirtyWork: boolean; details: string } => ({
    hasDirtyWork: false,
    details: '',
  })),
}));
const { showScientificStorageRecovery } = vi.hoisted(() => ({
  showScientificStorageRecovery: vi.fn(async () => undefined),
}));
vi.mock('../scientific-recovery-ui', () => ({ showScientificStorageRecovery }));
vi.mock('../dirty-state-cache', () => ({
  getDirtyState: () => dirtyState(),
}));

import { buildMenu, PUBLIC_PRODUCT_DOCS_URL } from '../menu';
import { configureUnsavedWorkSaver } from '../quit-consent';
import { APP_SHORTCUTS, electronAccelerator } from '../../keyboard/shortcutRegistry';

function makeWindow(): {
  window: BrowserWindow;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  const close = vi.fn();
  const window = {
    webContents: { send, reload: reloadSpy, reloadIgnoringCache: reloadIgnoringCacheSpy },
    close,
    isDestroyed: () => false,
  } as unknown as BrowserWindow;
  return { window, send, close };
}

function findByLabel(items: TemplateItem[], label: string): TemplateItem | null {
  for (const item of items) {
    if (item.label === label) return item;
    if (item.submenu) {
      const found = findByLabel(item.submenu, label);
      if (found) return found;
    }
  }
  return null;
}

function findByRole(items: TemplateItem[], role: string): TemplateItem | null {
  for (const item of items) {
    if (item.role === role) return item;
    if (item.submenu) {
      const found = findByRole(item.submenu, role);
      if (found) return found;
    }
  }
  return null;
}

function collect(items: TemplateItem[], out: TemplateItem[] = []): TemplateItem[] {
  for (const item of items) {
    out.push(item);
    if (item.submenu) collect(item.submenu, out);
  }
  return out;
}

describe('buildMenu — app accelerators', () => {
  let send: ReturnType<typeof vi.fn>;
  let close: ReturnType<typeof vi.fn>;

  it('makes command-line access discoverable without opening a document tab', () => {
    const window = makeWindow();
    buildMenu(window.window);
    expect(findByLabel(capturedTemplate!, 'Command Line…')).toBeTruthy();
    expect(window.send).not.toHaveBeenCalled();
  });

  it('opens native Scientific Storage Recovery from File on every desktop platform', async () => {
    const originalPlatform = process.platform;
    try {
      for (const platform of ['darwin', 'win32', 'linux']) {
        Object.defineProperty(process, 'platform', { value: platform });
        const { window } = makeWindow();
        buildMenu(window);
        const file = findByLabel(capturedTemplate ?? [], 'File');
        const recovery = findByLabel(file?.submenu ?? [], 'Scientific Storage Recovery…');
        expect(recovery?.id).toBe('dnaforge-scientific-storage-recovery');
        recovery!.click?.();
        expect(showScientificStorageRecovery).toHaveBeenLastCalledWith(window);
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  beforeEach(() => {
    capturedTemplate = null;
    const w = makeWindow();
    send = w.send;
    close = w.close;
    buildMenu(w.window);
    expect(capturedTemplate).not.toBeNull();
  });

  it('binds Cmd/Ctrl-N to "New Chat" → menu:new-chat', () => {
    const item = findByLabel(capturedTemplate!, 'New Chat');
    expect(item).toBeTruthy();
    expect(item!.accelerator).toBe('CmdOrCtrl+N');
    item!.click?.();
    expect(send).toHaveBeenCalledWith('menu:new-chat');
  });

  it('routes native Edit undo and redo through the renderer command system', () => {
    const undo = findByLabel(capturedTemplate!, 'Undo');
    const redo = findByLabel(capturedTemplate!, 'Redo');

    expect(undo).toMatchObject({ accelerator: 'CmdOrCtrl+Z' });
    expect(redo).toMatchObject({ accelerator: 'CmdOrCtrl+Shift+Z' });
    expect(undo?.role).toBeUndefined();
    expect(redo?.role).toBeUndefined();

    undo?.click?.();
    redo?.click?.();
    expect(send).toHaveBeenNthCalledWith(1, 'menu:undo');
    expect(send).toHaveBeenNthCalledWith(2, 'menu:redo');
  });

  it('binds Cmd-W to "Close Tab" → menu:close-tab', () => {
    const item = findByLabel(capturedTemplate!, 'Close Tab');
    expect(item).toBeTruthy();
    expect(item!.accelerator).toBe('CmdOrCtrl+W');
    item!.click?.();
    expect(send).toHaveBeenCalledWith('menu:close-tab');
  });

  it('binds Cmd-Shift-T to "Reopen Closed Tab" → menu:reopen-closed-tab', () => {
    const item = findByLabel(capturedTemplate!, 'Reopen Closed Tab');
    expect(item).toBeTruthy();
    expect(item!.accelerator).toBe('CmdOrCtrl+Shift+T');
    item!.click?.();
    expect(send).toHaveBeenCalledWith('menu:reopen-closed-tab');
  });

  it('"Close Window" has NO accelerator and calls mainWindow.close()', () => {
    const closeWindow = findByLabel(capturedTemplate!, 'Close Window');
    expect(closeWindow).toBeTruthy();

    expect(closeWindow!.accelerator).toBeUndefined();

    expect(closeWindow!.role).toBeUndefined();
    closeWindow!.click?.();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('binds NO menu item to Cmd-Shift-W (reserved Chrome close-window shortcut)', () => {
    const offenders = collect(capturedTemplate!)
      .filter(
        (it) => it.accelerator === 'Shift+CmdOrCtrl+W' || it.accelerator === 'CmdOrCtrl+Shift+W'
      )
      .map((it) => it.label ?? it.role ?? 'unknown');
    expect(offenders).toEqual([]);
  });

  it('keeps Cmd-Q (role:quit) as the quit gesture', () => {
    expect(findByRole(capturedTemplate!, 'quit')).toBeTruthy();
  });

  it('no item other than "Close Tab" claims Cmd-W (no accidental quit re-bind)', () => {
    const offenders = collect(capturedTemplate!)
      .filter((it) => it.accelerator === 'CmdOrCtrl+W' && it.label !== 'Close Tab')
      .map((it) => it.label ?? it.role ?? 'unknown');
    expect(offenders).toEqual([]);
  });

  it('binds exactly the accelerators in the shortcut registry', () => {
    const fromRegistry = APP_SHORTCUTS.flatMap((shortcut) =>
      shortcut.inAppMenu ? [electronAccelerator(shortcut.id)] : []
    ).sort();
    const fromMenu = collect(capturedTemplate!)
      .flatMap((item) => (item.accelerator ? [item.accelerator] : []))
      .sort();
    expect(fromMenu).toEqual(fromRegistry);
  });

  it('puts Help → Product Documentation on macOS and opens the public docs index', () => {
    const help = findByRole(capturedTemplate!, 'help');
    expect(help).toBeTruthy();
    const item = findByLabel(help!.submenu ?? [], 'Product Documentation');
    expect(item?.id).toBe('dnaforge-product-documentation');
    expect(PUBLIC_PRODUCT_DOCS_URL).toBe('https://www.dnaforge.com/docs');
    item!.click?.();
    expect(openExternal).toHaveBeenCalledWith('https://www.dnaforge.com/docs');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('buildMenu — reload accelerators work in packaged builds', () => {
  beforeEach(() => {
    capturedTemplate = null;
    reloadSpy.mockClear();
    reloadIgnoringCacheSpy.mockClear();
    showMessageBox.mockClear();
    dirtyState.mockReturnValue({ hasDirtyWork: false, details: '' });
    buildMenu(makeWindow().window);
    expect(capturedTemplate).not.toBeNull();
  });

  it('binds Cmd-R to Reload even though is.dev is false', () => {
    const item = findByLabel(capturedTemplate ?? [], 'Reload');
    expect(item).not.toBeNull();
    expect(item?.accelerator).toBe('CmdOrCtrl+R');
  });

  it('binds Cmd-Shift-R to Force Reload even though is.dev is false', () => {
    const item = findByLabel(capturedTemplate ?? [], 'Force Reload');
    expect(item).not.toBeNull();
    expect(item?.accelerator).toBe('CmdOrCtrl+Shift+R');
  });

  it('reloads immediately when there is no unsaved work', async () => {
    findByLabel(capturedTemplate ?? [], 'Reload')?.click?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('force reload ignores the cache', async () => {
    findByLabel(capturedTemplate ?? [], 'Force Reload')?.click?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reloadIgnoringCacheSpy).toHaveBeenCalledTimes(1);
  });

  it('ASKS before discarding unsaved work, and does not reload if cancelled', async () => {
    dirtyState.mockReturnValue({ hasDirtyWork: true, details: '2 notebook pages' });
    showMessageBox.mockResolvedValueOnce({ response: 0 });
    capturedTemplate = null;
    buildMenu(makeWindow().window);
    findByLabel(capturedTemplate ?? [], 'Reload')?.click?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('saves first and reloads once nothing is left unsaved', async () => {
    const saveAll = vi.fn(async () => {
      dirtyState.mockReturnValue({ hasDirtyWork: false, details: '' });
    });
    configureUnsavedWorkSaver({ canSave: () => true, saveAll, readDirty: dirtyState });
    try {
      dirtyState.mockReturnValue({ hasDirtyWork: true, details: '2 notebook pages' });
      showMessageBox.mockResolvedValueOnce({ response: 2 });
      capturedTemplate = null;
      buildMenu(makeWindow().window);
      findByLabel(capturedTemplate ?? [], 'Reload')?.click?.();
      await vi.waitFor(() => expect(reloadSpy).toHaveBeenCalledTimes(1));
      expect(saveAll).toHaveBeenCalledOnce();
      expect(showMessageBox).toHaveBeenCalledWith(
        expect.objectContaining({
          buttons: ['Cancel', 'Reload Without Saving', 'Save and Reload'],
        })
      );
    } finally {
      configureUnsavedWorkSaver(null);
    }
  });

  it('reloads anyway when the user confirms', async () => {
    dirtyState.mockReturnValue({ hasDirtyWork: true, details: '2 notebook pages' });
    showMessageBox.mockResolvedValueOnce({ response: 1 });
    capturedTemplate = null;
    buildMenu(makeWindow().window);
    findByLabel(capturedTemplate ?? [], 'Reload')?.click?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });
});

describe('buildMenu — Help → Product Documentation on Windows/Linux', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    capturedTemplate = null;
    openExternal.mockClear();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    buildMenu(makeWindow().window);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('uses five Windows titlebar menus while retaining settings and window commands', () => {
    expect(
      capturedTemplate!.map((item) => item.label ?? (item.role === 'help' ? 'Help' : undefined))
    ).toEqual(['File', 'Edit', 'View', 'Help', 'Options']);
    const options = findByLabel(capturedTemplate!, 'Options');
    expect(findByLabel(options!.submenu!, 'Settings...')?.accelerator).toBe(
      electronAccelerator('app.settings')
    );
    const view = findByLabel(capturedTemplate!, 'View');
    expect(findByLabel(view!.submenu!, 'Close Tab')?.accelerator).toBe(
      electronAccelerator('tabs.close')
    );
    expect(findByLabel(view!.submenu!, 'Close Window')).toBeTruthy();
    expect(findByRole(view!.submenu!, 'minimize')).toBeTruthy();
  });

  it('preserves the macOS app and Window menus', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    buildMenu(makeWindow().window);
    expect(capturedTemplate!.map((item) => item.label ?? item.role)).toEqual([
      'DNAForge',
      'File',
      'Edit',
      'View',
      'Window',
      'help',
    ]);
    expect(findByLabel(capturedTemplate!, 'Options')).toBeNull();
    expect(findByLabel(capturedTemplate![0].submenu!, 'Settings...')).toBeTruthy();
  });

  it('keeps Command Line and Check for Updates on Help, and opens the exact docs URL', () => {
    const help = findByRole(capturedTemplate!, 'help');
    expect(help).toBeTruthy();
    expect(findByLabel(help!.submenu ?? [], 'Command Line…')).toBeTruthy();
    expect(findByLabel(help!.submenu ?? [], 'Check for Updates...')).toBeTruthy();
    const item = findByLabel(help!.submenu ?? [], 'Product Documentation');
    expect(item?.id).toBe('dnaforge-product-documentation');
    item!.click?.();
    expect(openExternal).toHaveBeenCalledWith('https://www.dnaforge.com/docs');
  });
});

it('sets the native About version from the same source-derived identity', () => {
  buildMenu(makeWindow().window);
  expect(setAboutPanelOptions).toHaveBeenCalledWith({
    applicationName: 'DNAForge',
    applicationVersion: '0.9.8+dev.4.g535acc37d41f',
    version: 'Development build',
    website: 'https://dnaforge.com',
  });
});
