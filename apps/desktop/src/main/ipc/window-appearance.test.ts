import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MainHandlersOf } from '../../shared/ipc-contract';
import type { windowContract } from '../../shared/ipc/window.contract';
const registration = vi.hoisted(() => {
  const state: {
    handlers: MainHandlersOf<typeof windowContract> | null;
    find: ReturnType<typeof vi.fn>;
  } = { handlers: null, find: vi.fn() };
  return state;
});
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: registration.find }, Menu: {} }));
vi.mock('../../shared/ipc-contract', () => ({
  mainIpc: { handle: vi.fn() },
  handleGroup: (_contract: unknown, handlers: MainHandlersOf<typeof windowContract>) => {
    registration.handlers = handlers;
  },
}));
import { applySendingWindowZoom, registerWindowHandlers } from './window';
function nativeWindow() {
  let factor = 1;
  let destroyed = false;
  let contentsDestroyed = false;
  const window = {
    isDestroyed: () => destroyed,
    setTitleBarOverlay: vi.fn(),
    webContents: {
      id: 41,
      isDestroyed: () => contentsDestroyed,
      setZoomFactor: vi.fn((next: number) => {
        factor = next;
      }),
      getZoomFactor: vi.fn(() => factor),
    },
  };
  return {
    window,
    factor: () => factor,
    destroy: () => {
      destroyed = true;
    },
    destroyContents: () => {
      contentsDestroyed = true;
    },
  };
}
beforeEach(() => {
  registration.handlers = null;
  registration.find.mockReset();
});
describe('actual sending-window zoom implementation and registered handler', () => {
  it.each([0.25, 1.2, 1.25, 5])(
    'acknowledges real factor %s and Windows chrome readback',
    (factor) => {
      const native = nativeWindow();
      expect(applySendingWindowZoom(native.window, 41, factor, true, true)).toEqual({
        status: 'applied',
        factor,
      });
      expect(native.factor()).toBe(factor);
      expect(native.window.setTitleBarOverlay).toHaveBeenCalledWith({
        color: '#161413',
        symbolColor: '#eeece8',
        height: Math.round(32 * factor),
      });
    }
  );
  it('refuses missing, destroyed, destroyed-content and foreign sender windows without setting factor', () => {
    expect(applySendingWindowZoom(null, 41, 1.25, false, false)).toEqual({
      status: 'refused',
      reason: 'window_unavailable',
    });
    const foreign = nativeWindow();
    expect(applySendingWindowZoom(foreign.window, 42, 1.25, false, false).status).toBe('refused');
    expect(foreign.window.webContents.setZoomFactor).not.toHaveBeenCalled();
    const destroyed = nativeWindow();
    destroyed.destroy();
    expect(applySendingWindowZoom(destroyed.window, 41, 1.25, false, false).status).toBe('refused');
    const contents = nativeWindow();
    contents.destroyContents();
    expect(applySendingWindowZoom(contents.window, 41, 1.25, false, false).status).toBe('refused');
  });
  it.each([NaN, Infinity, 0, -1, 0.1, 9])(
    'refuses invalid factor %s before native application',
    (factor) => {
      const native = nativeWindow();
      expect(applySendingWindowZoom(native.window, 41, factor, false, false)).toEqual({
        status: 'refused',
        reason: 'invalid_factor',
      });
      expect(native.window.webContents.setZoomFactor).not.toHaveBeenCalled();
    }
  );
  it('does not acknowledge a clamp, chrome failure or window destruction as success', () => {
    const clamp = nativeWindow();
    clamp.window.webContents.getZoomFactor.mockReturnValue(1.1);
    expect(applySendingWindowZoom(clamp.window, 41, 1.25, true, false)).toEqual({
      status: 'failed',
      reason: 'apply_failed',
      factor: 1.1,
    });
    const chrome = nativeWindow();
    chrome.window.setTitleBarOverlay.mockImplementation(() => {
      throw new Error('native chrome refused');
    });
    expect(applySendingWindowZoom(chrome.window, 41, 1.25, true, false)).toEqual({
      status: 'failed',
      reason: 'apply_failed',
      factor: 1.25,
    });
    const closing = nativeWindow();
    closing.window.webContents.setZoomFactor.mockImplementation(() => closing.destroy());
    expect(applySendingWindowZoom(closing.window, 41, 1.25, false, false)).toEqual({
      status: 'refused',
      reason: 'window_unavailable',
    });
  });
  it('uses the registered governed handler and its actual sender, not a focused-window fallback', () => {
    const native = nativeWindow();
    registration.find.mockReturnValue(native.window);
    registerWindowHandlers();
    const handler = registration.handlers?.setZoomLevel;
    if (!handler) throw new Error('Zoom handler missing');
    const sender = { id: 41, isDestroyed: () => false };
    expect(Reflect.apply(handler, undefined, [{ sender }, 1.25])).toEqual({
      status: 'applied',
      factor: 1.25,
    });
    expect(registration.find).toHaveBeenCalledWith(sender);
    registration.find.mockReturnValue(null);
    expect(Reflect.apply(handler, undefined, [{ sender }, 1.5])).toEqual({
      status: 'refused',
      reason: 'window_unavailable',
    });
    expect(
      Reflect.apply(handler, undefined, [{ sender: { id: 41, isDestroyed: () => true } }, 1.5])
    ).toEqual({ status: 'refused', reason: 'window_unavailable' });
  });
});
