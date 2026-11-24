import { sendRendererIpc } from '../shared/ipc-contract';
import { Menu, BrowserWindow, app, shell } from 'electron';
import { is } from '@electron-toolkit/utils';

import { PRODUCTION_WWW_ORIGIN } from './auth/web-api-origin';
import { getDirtyState } from './dirty-state-cache';
import { showUnsavedWorkDialog } from './quit-consent';
import { showDesktopCliHelp } from './desktop-cli-help';
import { showScientificStorageRecovery } from './scientific-recovery-ui';
import { isSafeExternalProtocol } from './security';
import { electronAccelerator } from '../keyboard/shortcutRegistry';
import { APP_BUILD } from '../lib/app-build';
import { nativeAboutBuildOptions } from '../shared/app-build-identity';

export const PUBLIC_PRODUCT_DOCS_URL = `${PRODUCTION_WWW_ORIGIN}/docs`;

function openPublicProductDocs(): void {
  if (!isSafeExternalProtocol(PUBLIC_PRODUCT_DOCS_URL)) return;
  void shell.openExternal(PUBLIC_PRODUCT_DOCS_URL);
}

async function reloadGuarded(mainWindow: BrowserWindow, ignoreCache: boolean): Promise<void> {
  const dirty = getDirtyState();
  if (dirty.hasDirtyWork) {
    const decision = await showUnsavedWorkDialog(mainWindow, {
      staged: false,
      details: dirty.details || 'this project',
      action: 'reload',
    });
    if (decision !== 'proceed') return;
  }
  if (ignoreCache) {
    mainWindow.webContents.reloadIgnoringCache();
  } else {
    mainWindow.webContents.reload();
  }
}

export function buildMenu(mainWindow: BrowserWindow): Menu {
  app.setAboutPanelOptions(nativeAboutBuildOptions(APP_BUILD));
  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';
  const commandLineItem: Electron.MenuItemConstructorOptions = {
    id: 'dnaforge-command-line',
    label: 'Command Line…',
    enabled: app.isPackaged,
    click: () => void showDesktopCliHelp(mainWindow),
  };
  const productDocsItem: Electron.MenuItemConstructorOptions = {
    id: 'dnaforge-product-documentation',
    label: 'Product Documentation',
    click: () => openPublicProductDocs(),
  };

  if (is.dev && !app.isPackaged && process.env.VITE_AI_ONLY_INPUT === '1') {
    return Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' as const }] : []),
      {
        label: 'File',
        submenu: [
          {
            label: 'New Chat',
            click: () => sendRendererIpc(mainWindow.webContents, 'menu:new-chat'),
          },
        ],
      },
      { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'toggleDevTools' }] },
      { role: 'windowMenu' },
    ]);
  }

  const importMenuItems: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Import Files...',
      accelerator: electronAccelerator('files.import-files'),
      click: () => sendRendererIpc(mainWindow.webContents, 'menu:import-files'),
    },
    {
      label: 'Import Folder...',
      accelerator: electronAccelerator('files.import-folder'),
      click: () => sendRendererIpc(mainWindow.webContents, 'menu:import-folder'),
    },
    {
      label: 'Bulk Import Registry Records...',
      click: () => sendRendererIpc(mainWindow.webContents, 'menu:import-registry-records'),
    },
  ];
  const newChatMenuItems: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'New Chat',
      accelerator: electronAccelerator('app.new-chat'),
      click: () => sendRendererIpc(mainWindow.webContents, 'menu:new-chat'),
    },
    { type: 'separator' },
  ];
  const recoveryMenuItems: Electron.MenuItemConstructorOptions[] = [
    { type: 'separator' },
    {
      id: 'dnaforge-scientific-storage-recovery',
      label: 'Scientific Storage Recovery…',
      click: () => {
        showScientificStorageRecovery(mainWindow).catch(() => {});
      },
    },
  ];

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Check for Updates...',
                click: () => sendRendererIpc(mainWindow.webContents, 'menu:check-for-updates'),
              },
              { type: 'separator' as const },
              {
                label: 'Settings...',
                accelerator: electronAccelerator('app.settings'),
                click: () => sendRendererIpc(mainWindow.webContents, 'menu:settings'),
              },
              commandLineItem,
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
          {
            label: 'File',
            submenu: [...newChatMenuItems, ...importMenuItems, ...recoveryMenuItems],
          },
        ]
      : [
          {
            label: 'File',
            submenu: [
              ...newChatMenuItems,
              ...importMenuItems,
              ...recoveryMenuItems,
              { type: 'separator' as const },
              {
                label: 'Settings...',
                accelerator: electronAccelerator('app.settings'),
                click: () => sendRendererIpc(mainWindow.webContents, 'menu:settings'),
              },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]),
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: electronAccelerator('app.undo'),
          click: () => sendRendererIpc(mainWindow.webContents, 'menu:undo'),
        },
        {
          label: 'Redo',
          accelerator: electronAccelerator('app.redo'),
          click: () => sendRendererIpc(mainWindow.webContents, 'menu:redo'),
        },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Explorer',
          accelerator: electronAccelerator('app.explorer'),
          click: () => sendRendererIpc(mainWindow.webContents, 'menu:explorer'),
        },
        {
          label: 'Search',
          accelerator: electronAccelerator('app.search'),
          click: () => sendRendererIpc(mainWindow.webContents, 'menu:search'),
        },
        { type: 'separator' },
        {
          label: 'Reload',
          accelerator: electronAccelerator('tabs.reload'),
          click: () => {
            // global crash reporter and be filed as a product crash.
            reloadGuarded(mainWindow, false).catch(() => {});
          },
        },
        {
          label: 'Force Reload',
          accelerator: electronAccelerator('tabs.force-reload'),
          click: () => {
            reloadGuarded(mainWindow, true).catch(() => {});
          },
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(is.dev ? [{ type: 'separator' as const }, { role: 'toggleDevTools' as const }] : []),
      ],
    },
    {
      label: 'Window',
      submenu: [
        {
          label: 'Close Tab',
          accelerator: electronAccelerator('tabs.close'),
          click: () => sendRendererIpc(mainWindow.webContents, 'menu:close-tab'),
        },
        {
          label: 'Reopen Closed Tab',
          accelerator: electronAccelerator('tabs.reopen'),
          click: () => sendRendererIpc(mainWindow.webContents, 'menu:reopen-closed-tab'),
        },
        { type: 'separator' as const },
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        { type: 'separator' as const },

        { label: 'Close Window', click: () => mainWindow.close() },
      ],
    },

    {
      role: 'help' as const,
      submenu: isMac
        ? [productDocsItem]
        : [
            productDocsItem,
            commandLineItem,
            {
              label: 'Check for Updates...',
              click: () => sendRendererIpc(mainWindow.webContents, 'menu:check-for-updates'),
            },
          ],
    },
  ];

  if (isWindows) {
    const file = template.find((item) => item.label === 'File');
    const view = template.find((item) => item.label === 'View');
    const windowMenu = template.find((item) => item.label === 'Window');
    if (file && Array.isArray(file.submenu) && view && Array.isArray(view.submenu)) {
      const settings = file.submenu.find((item) => item.label === 'Settings...');

      file.submenu = file.submenu.filter(
        (item, index, items) =>
          item !== settings && !(item.type === 'separator' && items[index + 1] === settings)
      );
      if (Array.isArray(windowMenu?.submenu)) {
        view.submenu.push({ type: 'separator' }, ...windowMenu.submenu);
      }
      const windowsTemplate = template.filter((item) => item !== windowMenu);
      windowsTemplate.push({ label: 'Options', submenu: settings ? [settings] : [] });
      for (const item of windowsTemplate) {
        item.id = `titlebar-${item.role === 'help' ? 'Help' : item.label}`;
      }
      return Menu.buildFromTemplate(windowsTemplate);
    }
  }

  return Menu.buildFromTemplate(template);
}
