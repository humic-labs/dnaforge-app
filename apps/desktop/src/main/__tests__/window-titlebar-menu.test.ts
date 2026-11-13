import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { windowContract } from '../../shared/ipc/window.contract';

const { handlers, popup, closePopup, menus, setTitleBarOverlay, window } = vi.hoisted(() => {
  const popup = vi.fn((options: { callback: () => void }) => options.callback());
  const closePopup = vi.fn();
  const menus = new Map(
    ['File', 'Edit', 'View', 'Help', 'Options'].map((id) => [
      `titlebar-${id}`,
      { submenu: { popup, closePopup } },
    ])
  );
  const setTitleBarOverlay = vi.fn();
  let factor = 1.25;
  return {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    popup,
    closePopup,
    menus,
    setTitleBarOverlay,
    window: {
      isDestroyed: () => false,
      webContents: {
        id: 41,
        isDestroyed: () => false,
        getZoomFactor: () => factor,
        setZoomFactor: vi.fn((value: number) => {
          factor = value;
        }),
      },
      getContentSize: () => [800, 600],
      setTitleBarOverlay,
    },
  };
});
vi.mock('../../shared/ipc-contract', async () => {
  const { contractEntries } = await vi.importActual<typeof import('../../shared/ipc/contract')>(
    '../../shared/ipc/contract'
  );
  return {
    handleGroup: (
      contract: typeof windowContract,
      group: Record<string, ((...args: unknown[]) => unknown) | null>
    ) => {
      for (const { method, channel } of contractEntries(contract)) {
        const handler = group[method];
        if (handler) handlers.set(channel, handler);
      }
      return () => undefined;
    },
    mainIpc: {
      handle: (name: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(name, handler),
    },
  };
});
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => window },
  Menu: { getApplicationMenu: () => ({ getMenuItemById: (id: string) => menus.get(id) }) },
}));
import { registerWindowHandlers } from '../ipc/window';

describe('Windows titlebar IPC', () => {
  const originalPlatform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    window.webContents.setZoomFactor(1.25);
    vi.clearAllMocks();
    popup.mockImplementation((options) => options.callback());
    closePopup.mockReset();
    registerWindowHandlers();
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });
  const event = { sender: window.webContents };

  it('anchors a native submenu in the originating window at the current zoom', async () => {
    await handlers.get('window:showMenu')!(event, 'File', { x: 20, y: 40 });
    expect(popup).toHaveBeenCalledWith({ window, x: 25, y: 50, callback: expect.any(Function) });
  });

  it.each(['File', 'Edit', 'View', 'Help', 'Options'])(
    'closes %s when its titlebar button is pressed again',
    async (id) => {
      let finish!: () => void;
      popup.mockImplementationOnce((options) => {
        finish = options.callback;
      });
      closePopup.mockImplementationOnce(() => finish());
      const first = handlers.get('window:showMenu')!(event, id, { x: 20, y: 32 });
      await handlers.get('window:showMenu')!(event, id, { x: 20, y: 32 });
      await first;
      expect(popup).toHaveBeenCalledTimes(1);
      expect(closePopup).toHaveBeenCalledWith(window);
    }
  );

  it('keeps a newer popup tracked when the previous popup closes late', async () => {
    const callbacks: (() => void)[] = [];
    popup.mockImplementation((options) => {
      callbacks.push(options.callback);
    });
    const first = handlers.get('window:showMenu')!(event, 'File', { x: 20, y: 32 });
    const second = handlers.get('window:showMenu')!(event, 'Edit', { x: 60, y: 32 });
    callbacks[0]();
    await first;
    await handlers.get('window:showMenu')!(event, 'Edit', { x: 60, y: 32 });
    callbacks[1]();
    await second;
    expect(popup).toHaveBeenCalledTimes(2);
    expect(closePopup).toHaveBeenCalledTimes(2);
  });

  it('rejects unknown menus and invalid coordinates before opening a popup', async () => {
    await expect(
      handlers.get('window:showMenu')!(event, 'Arbitrary', { x: 0, y: 0 })
    ).rejects.toThrow('Invalid');
    await expect(handlers.get('window:showMenu')!(event, 'File', { x: NaN, y: 0 })).rejects.toThrow(
      'Invalid'
    );
    expect(popup).not.toHaveBeenCalled();
  });

  it('updates the native caption symbols and background when theme changes', () => {
    handlers.get('window:setTitleBarTheme')!(event, true);
    expect(setTitleBarOverlay).toHaveBeenCalledWith({
      color: '#161413',
      symbolColor: '#eeece8',
      height: 40,
    });
  });

  it('scales the caption row with Display Scale while retaining its theme', () => {
    handlers.get('window:setTitleBarTheme')!(event, true);
    handlers.get('window:setZoomLevel')!(event, 2);
    expect(window.webContents.setZoomFactor).toHaveBeenCalledWith(2);
    expect(setTitleBarOverlay).toHaveBeenLastCalledWith({
      color: '#161413',
      symbolColor: '#eeece8',
      height: 64,
    });
  });

  it('does not alter macOS chrome', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    await handlers.get('window:showMenu')!(event, 'File', { x: 0, y: 40 });
    handlers.get('window:setTitleBarTheme')!(event, true);
    handlers.get('window:setZoomLevel')!(event, 2);
    expect(popup).not.toHaveBeenCalled();
    expect(setTitleBarOverlay).not.toHaveBeenCalled();
  });
});
