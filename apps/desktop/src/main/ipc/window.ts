import { handleGroup } from '../../shared/ipc-contract';
import { app, BrowserWindow, Menu, screen } from 'electron';
import {
  WINDOWS_MENU_IDS,
  type WindowsMenuId,
  type WindowMenuPosition,
} from '../../shared/window-menu';
import { getWindowsTitleBarOverlay } from '../window-chrome';
import { windowContract } from '../../shared/ipc/window.contract';
import { isWindowZoomFactor, type WindowZoomResult } from '../../shared/window-zoom';

type ZoomWindow = Pick<BrowserWindow, 'isDestroyed' | 'setTitleBarOverlay'> & {
  webContents: Pick<
    BrowserWindow['webContents'],
    'id' | 'isDestroyed' | 'setZoomFactor' | 'getZoomFactor'
  >;
};

export function applySendingWindowZoom(
  window: ZoomWindow | null,
  senderId: number,
  factor: number,
  windows: boolean,
  dark: boolean
): WindowZoomResult {
  if (!isWindowZoomFactor(factor)) return { status: 'refused', reason: 'invalid_factor' };
  if (
    !window ||
    window.isDestroyed() ||
    window.webContents.isDestroyed() ||
    window.webContents.id !== senderId
  )
    return { status: 'refused', reason: 'window_unavailable' };
  try {
    window.webContents.setZoomFactor(factor);
    if (window.isDestroyed() || window.webContents.isDestroyed())
      return { status: 'refused', reason: 'window_unavailable' };
    const actual = window.webContents.getZoomFactor();
    if (!isWindowZoomFactor(actual) || Math.abs(actual - factor) > 1e-6)
      throw new Error('Zoom not confirmed');
    if (windows) window.setTitleBarOverlay(getWindowsTitleBarOverlay(dark, actual));
    return { status: 'applied', factor: actual };
  } catch {
    let actual: number | null = null;
    try {
      const value = window.webContents.getZoomFactor();
      if (isWindowZoomFactor(value)) actual = value;
    } catch (_error) {
      void _error;
    }
    return { status: 'failed', reason: 'apply_failed', factor: actual };
  }
}

export function registerWindowHandlers(): void {
  const activeMenus = new WeakMap<BrowserWindow, { menu: Menu }>();
  const titleBarThemes = new WeakMap<BrowserWindow, boolean>();

  handleGroup(windowContract, {
    getDisplayColorSpace: (event) => {
      if (event.sender.isDestroyed()) return null;
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || window.isDestroyed()) return null;
      const content = window.getContentBounds();
      const profiles = new Set(
        screen
          .getAllDisplays()
          .filter(
            ({ bounds }) =>
              Math.min(content.x + content.width, bounds.x + bounds.width) >
                Math.max(content.x, bounds.x) &&
              Math.min(content.y + content.height, bounds.y + bounds.height) >
                Math.max(content.y, bounds.y)
          )
          .map((display) => display.colorSpace)
      );
      if (profiles.size !== 1) return null;
      const forced = app.commandLine.hasSwitch('force-color-profile')
        ? app.commandLine.getSwitchValue('force-color-profile')
        : null;
      if (
        profiles.has('{primaries:BT709, transfer:SRGB, matrix:RGB, range:FULL}') &&
        (forced === null || forced === 'srgb')
      )
        return 'srgb';
      if (
        profiles.has('{primaries:P3, transfer:SRGB, matrix:RGB, range:FULL}') &&
        (forced === null || forced === 'display-p3-d65')
      )
        return 'display-p3';
      return null;
    },
    setZoomLevel: (event, level) => {
      if (event.sender.isDestroyed()) return { status: 'refused', reason: 'window_unavailable' };
      const window = BrowserWindow.fromWebContents(event.sender);
      return applySendingWindowZoom(
        window,
        event.sender.id,
        level,
        process.platform === 'win32',
        window ? (titleBarThemes.get(window) ?? false) : false
      );
    },
    showMenu: async (event, menuId: WindowsMenuId, position: WindowMenuPosition): Promise<void> => {
      if (process.platform !== 'win32') return;
      if (
        !WINDOWS_MENU_IDS.includes(menuId) ||
        !position ||
        !Number.isFinite(position.x) ||
        !Number.isFinite(position.y)
      ) {
        throw new Error('Invalid title bar menu request');
      }
      const window = BrowserWindow.fromWebContents(event.sender);
      const submenu = Menu.getApplicationMenu()?.getMenuItemById(`titlebar-${menuId}`)?.submenu;
      if (!window || !submenu) return;
      const activeMenu = activeMenus.get(window);
      if (activeMenu) {
        activeMenu.menu.closePopup(window);
        if (activeMenu.menu === submenu) return;
      }
      const popup = { menu: submenu };
      activeMenus.set(window, popup);
      const zoom = window.webContents.getZoomFactor();
      const [width, height] = window.getContentSize();
      try {
        await new Promise<void>((resolve) => {
          submenu.popup({
            window,
            x: Math.max(0, Math.min(width - 1, Math.round(position.x * zoom))),
            y: Math.max(0, Math.min(height - 1, Math.round(position.y * zoom))),
            callback: resolve,
          });
        });
      } finally {
        if (activeMenus.get(window) === popup) activeMenus.delete(window);
      }
    },
    setTitleBarTheme: (event, dark: boolean): void => {
      if (process.platform !== 'win32') return;
      if (typeof dark !== 'boolean') throw new Error('Invalid title bar theme');
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return;
      titleBarThemes.set(window, dark);
      window.setTitleBarOverlay(
        getWindowsTitleBarOverlay(dark, window.webContents.getZoomFactor())
      );
    },
    minimize: (event) => {
      BrowserWindow.fromWebContents(event.sender)?.minimize();
    },
    maximize: (event) => {
      BrowserWindow.fromWebContents(event.sender)?.maximize();
    },
    unmaximize: (event) => {
      BrowserWindow.fromWebContents(event.sender)?.unmaximize();
    },
    close: (event) => {
      BrowserWindow.fromWebContents(event.sender)?.close();
    },
    isMaximized: (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false,
    setSize: (event, width: number, height: number) => {
      BrowserWindow.fromWebContents(event.sender)?.setSize(width, height);
    },
    setPosition: (event, x: number, y: number) => {
      BrowserWindow.fromWebContents(event.sender)?.setPosition(x, y);
    },
    getSize: (event) => {
      const [width, height] = BrowserWindow.fromWebContents(event.sender)?.getSize() ?? [1200, 800];
      return { width, height };
    },
    getPosition: (event) => {
      const [x, y] = BrowserWindow.fromWebContents(event.sender)?.getPosition() ?? [0, 0];
      return { x, y };
    },
  });
}
