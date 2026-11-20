import { describe, it, expect, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

type TemplateItem = {
  label?: string;
  role?: string;
  accelerator?: string;
  type?: string;
  click?: (...args: unknown[]) => void;
  submenu?: TemplateItem[];
};

let capturedTemplate: TemplateItem[] | null = null;

vi.mock('electron', () => ({
  app: { name: 'DNAForge', isPackaged: true, setAboutPanelOptions: vi.fn() },
  BrowserWindow: vi.fn(),
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined) },
  Menu: {
    buildFromTemplate: vi.fn((template: TemplateItem[]) => {
      capturedTemplate = template;
      return { __isMenu: true };
    }),
    setApplicationMenu: vi.fn(),
  },
}));

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));

import { buildMenu } from '../menu';

function makeWindow(): { window: BrowserWindow; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const window = { webContents: { send }, close: vi.fn() } as unknown as BrowserWindow;
  return { window, send };
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

describe(' File > Import menu', () => {
  it('nests Import entries under a File menu', () => {
    const { window } = makeWindow();
    buildMenu(window);
    const file = capturedTemplate!.find((m) => m.label === 'File');
    expect(file).toBeTruthy();
    expect(findByLabel(file!.submenu ?? [], 'Import Files...')).toBeTruthy();
    expect(findByLabel(file!.submenu ?? [], 'Import Folder...')).toBeTruthy();
    expect(findByLabel(file!.submenu ?? [], 'Bulk Import Registry Records...')).toBeTruthy();
  });

  it('assigns the Open shortcut to external previews', () => {
    const { window, send } = makeWindow();
    buildMenu(window);
    const item = findByLabel(capturedTemplate!, 'Open Files…');
    expect(item?.accelerator).toBe('CmdOrCtrl+O');
    expect(findByLabel(capturedTemplate!, 'Import Files...')?.accelerator).toBeUndefined();
    item!.click!();
    expect(send).toHaveBeenCalledWith('menu:open-files');
  });

  it('"Import Files..." fires menu:import-files', () => {
    const { window, send } = makeWindow();
    buildMenu(window);
    const item = findByLabel(capturedTemplate!, 'Import Files...');
    expect(item).toBeTruthy();
    item!.click!();
    expect(send).toHaveBeenCalledWith('menu:import-files');
  });

  it('"Import Folder..." fires menu:import-folder', () => {
    const { window, send } = makeWindow();
    buildMenu(window);
    const item = findByLabel(capturedTemplate!, 'Import Folder...');
    expect(item).toBeTruthy();
    item!.click!();
    expect(send).toHaveBeenCalledWith('menu:import-folder');
  });

  it('"Bulk Import Registry Records..." fires the shared Registry import event', () => {
    const { window, send } = makeWindow();
    buildMenu(window);
    const item = findByLabel(capturedTemplate!, 'Bulk Import Registry Records...');
    expect(item).toBeTruthy();
    item!.click!();
    expect(send).toHaveBeenCalledWith('menu:import-registry-records');
  });
});
