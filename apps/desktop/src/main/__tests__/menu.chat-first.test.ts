import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

type Item = { label?: string; role?: string; click?: () => void; submenu?: Item[] };
const state = vi.hoisted(() => ({ packaged: false, template: [] as Item[] }));
vi.mock('electron', () => ({
  app: {
    name: 'DNAForge',
    get isPackaged() {
      return state.packaged;
    },
    setAboutPanelOptions: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: {
    buildFromTemplate: (items: Item[]) => {
      state.template = items;
      return {};
    },
  },
}));
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }));
import { buildMenu } from '../menu';

afterEach(() => {
  vi.unstubAllEnvs();
  state.packaged = false;
});

it('keeps only chat and essential edit actions in the local chat-first experiment', () => {
  vi.stubEnv('VITE_CHAT_FIRST_INPUT', '1');
  const send = vi.fn();
  const window = { webContents: { send } };
  buildMenu(window as unknown as BrowserWindow);
  const items = state.template.flatMap((item) => item.submenu ?? []);
  expect(items.map((item) => item.label).filter(Boolean)).toEqual(['New Chat', 'Undo', 'Redo']);
  items.find((item) => item.label === 'New Chat')?.click?.();
  expect(send).toHaveBeenCalledWith('menu:new-chat');
});

it('retains the ordinary menus in packaged builds even if the experimental variable leaks in', () => {
  vi.stubEnv('VITE_CHAT_FIRST_INPUT', '1');
  state.packaged = true;
  buildMenu({ webContents: { send: vi.fn() } } as unknown as BrowserWindow);
  expect(
    state.template
      .flatMap((item) => item.submenu ?? [])
      .some((item) => item.label === 'Import Files...')
  ).toBe(true);
});
