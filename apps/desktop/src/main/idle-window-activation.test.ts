import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  focusWindowUnlessBackground,
  installBackgroundWindowPolicy,
} from './background-window-mode';

function fixture(background = false) {
  const calls: string[] = [];
  class Window extends EventEmitter {
    id = 1;
    static getAllWindows() {
      return [window];
    }
    static getFocusedWindow() {
      return null;
    }
    webContents = Object.assign(new EventEmitter(), {
      focus: () => calls.push('contents.focus'),
    });
    isDestroyed() {
      return false;
    }
    isMinimized() {
      return true;
    }
    isVisible() {
      return true;
    }
    setAlwaysOnTop() {
      calls.push('level');
    }
    showInactive() {
      calls.push('showInactive');
    }
    show() {
      calls.push('show');
    }
    focus() {
      calls.push('focus');
    }
    restore() {
      calls.push('restore');
    }
    moveTop() {
      calls.push('moveTop');
    }
  }
  const app = Object.assign(new EventEmitter(), {
    focus: () => calls.push('app.focus'),
    setActivationPolicy: vi.fn(),
  });
  installBackgroundWindowPolicy(
    app,
    Window,
    null,
    background ? { DNAFORGE_BACKGROUND_WINDOW: '1' } : {},
    'darwin',
    []
  );
  const window = new Window();
  app.emit('browser-window-created', {}, window);
  calls.length = 0;
  return { app, window, calls };
}

afterEach(() => vi.unstubAllEnvs());

describe('idle macOS activation', () => {
  it('guards a normal packaged launch even without agent environment variables', () => {
    const { app, window, calls } = fixture();
    window.focus();
    window.restore();
    window.moveTop();
    window.webContents.focus();
    app.focus();
    expect(calls).toEqual([]);
  });

  it.each([false, true])(
    'blocks delayed work immediately after switching away (background=%s)',
    (background) => {
      const { app, window, calls } = fixture(background);
      app.emit('browser-window-focus', {}, window);
      calls.length = 0;
      app.emit('browser-window-blur', {}, window);
      window.focus();
      window.restore();
      window.moveTop();
      window.webContents.focus();
      app.focus();
      expect(calls).toEqual([]);
    }
  );

  it('preserves programmatic focus while the user is in the application', () => {
    const { app, window, calls } = fixture();
    app.emit('browser-window-focus', {}, window);
    calls.length = 0;
    window.focus();
    window.restore();
    window.moveTop();
    window.webContents.focus();
    app.focus();
    expect(calls).toEqual(['focus', 'restore', 'moveTop', 'contents.focus', 'app.focus']);
  });

  it('allows an explicit file or protocol activation without granting later background work focus', () => {
    vi.stubEnv('DNAFORGE_FOREGROUND_WINDOW', '1');
    vi.stubEnv('DNAFORGE_BACKGROUND_WINDOW', '0');
    const { window, calls } = fixture();
    focusWindowUnlessBackground(window);
    expect(calls).toEqual(['restore', 'focus']);
    calls.length = 0;
    window.focus();
    window.restore();
    window.webContents.focus();
    expect(calls).toEqual([]);
  });

  it('shows background updates without requesting activation or changing the normal window level', () => {
    const { window, calls } = fixture();
    window.show();
    expect(calls).toEqual(['showInactive']);
  });
});
