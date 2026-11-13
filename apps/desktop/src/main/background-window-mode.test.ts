import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { App, BrowserWindow } from 'electron';

import {
  applyBackgroundActivationPolicy,
  installBackgroundWindows,
  installBackgroundWindowPolicy,
  installWindowIdentity,
  isAgentLaunch,
  isBackgroundWindowMode,
  shouldRunE2EInBackground,
  shouldInstallBackgroundWindows,
} from './background-window-mode';

describe('background window mode', () => {
  it.each([
    ['guarded dev', { DNAFORGE_BACKGROUND_WINDOW: '1', DNAFORGE_BACKGROUND_LAUNCH_SAFE: '1' }, []],
    ['direct agent', { CODEX_HOME: '/agent' }, []],
    ['direct test', { NODE_ENV: 'test' }, []],
    ['sealed test', { NODE_ENV: 'production' }, ['--waypoint-e2e=1']],
    ['physical CI', { NODE_ENV: 'test', CI: 'true', DNAFORGE_BACKGROUND_WINDOW: '1' }, []],
  ] as const)('uses the same background policy for %s launches', (_name, env, argv) => {
    expect(isBackgroundWindowMode(env, 'darwin', argv)).toBe(true);
    const app = { setActivationPolicy: vi.fn() };
    if (argv.length === 0) {
      expect(applyBackgroundActivationPolicy(app, 'darwin', env)).toBe(true);
      expect(app.setActivationPolicy).toHaveBeenCalledWith('regular');
    }
  });

  it('applies to tests and opted-in dev launches only', () => {
    expect(isBackgroundWindowMode({ NODE_ENV: 'test' }, 'darwin', [])).toBe(true);
    expect(isBackgroundWindowMode({ DNAFORGE_BACKGROUND_WINDOW: '1' })).toBe(true);
    expect(isBackgroundWindowMode({ NODE_ENV: 'development' })).toBe(false);
    expect(isBackgroundWindowMode({ DNAFORGE_BACKGROUND_WINDOW: 'true' })).toBe(false);
  });

  it('keeps the Dock icon for a background macOS test launch', () => {
    const app = { setActivationPolicy: vi.fn() };
    expect(applyBackgroundActivationPolicy(app, 'darwin', { NODE_ENV: 'test' })).toBe(true);
    expect(app.setActivationPolicy).toHaveBeenCalledWith('regular');
  });

  it('leaves ordinary launches and other platforms alone', () => {
    const app = { setActivationPolicy: vi.fn() };
    expect(applyBackgroundActivationPolicy(app, 'darwin', {})).toBe(false);
    expect(applyBackgroundActivationPolicy(app, 'linux', { NODE_ENV: 'test' })).toBe(false);
    expect(app.setActivationPolicy).not.toHaveBeenCalled();
  });
});

describe('shouldRunE2EInBackground ', () => {
  it('runs local macOS test launches in the background', () => {
    expect(shouldRunE2EInBackground({ NODE_ENV: 'test' }, 'darwin')).toBe(true);
    expect(shouldRunE2EInBackground({}, 'darwin', ['electron', '.', '--e2e'])).toBe(true);
    expect(shouldRunE2EInBackground({}, 'darwin', ['app', '--waypoint-e2e=1'])).toBe(true);
  });

  it('honors a physical Mac CI runner requesting background windows', () => {
    const env = { NODE_ENV: 'test', CI: 'true', DNAFORGE_BACKGROUND_WINDOW: '1' };
    expect(shouldRunE2EInBackground(env, 'darwin')).toBe(true);
    expect(shouldRunE2EInBackground(env, 'linux')).toBe(false);
    expect(shouldRunE2EInBackground({ ...env, WAYPOINT_E2E_FOREGROUND: '1' }, 'darwin')).toBe(
      false
    );
  });

  it('keeps default CI, other platforms, real launches, and an explicit opt-out unchanged', () => {
    expect(shouldRunE2EInBackground({ NODE_ENV: 'test', CI: 'true' }, 'darwin')).toBe(false);
    expect(shouldRunE2EInBackground({ NODE_ENV: 'test' }, 'linux')).toBe(false);
    expect(shouldRunE2EInBackground({ NODE_ENV: 'production' }, 'darwin')).toBe(false);
    expect(
      shouldRunE2EInBackground({ NODE_ENV: 'test', WAYPOINT_E2E_FOREGROUND: '1' }, 'darwin')
    ).toBe(false);
  });
});

class FakeWindow {
  static windows: FakeWindow[] = [];
  static getAllWindows() {
    return FakeWindow.windows;
  }
  static getFocusedWindow() {
    return null;
  }
  opacity = 1;
  ignoresMouse = false;
  shownInactive = 0;
  level = vi.fn();
  constructor() {
    FakeWindow.windows.push(this);
  }
  isDestroyed() {
    return false;
  }
  setOpacity(value: number) {
    this.opacity = value;
  }
  setIgnoreMouseEvents(value: boolean) {
    this.ignoresMouse = value;
  }
  setAlwaysOnTop(...args: [boolean, string?, number?]) {
    this.level(...args);
  }
  showInactive() {
    this.shownInactive += 1;
  }
  show() {
    throw new Error('the original show() would activate the app');
  }
  focus() {
    throw new Error('the original focus() would take keyboard focus');
  }
  moveTop() {
    throw new Error('the original moveTop() would raise the window');
  }
}

describe('installBackgroundWindowPolicy ', () => {
  it('keeps test windows visible and interactive with a Dock entry and without automatic focus', () => {
    const app = Object.assign(new EventEmitter(), {
      setActivationPolicy: vi.fn(),
      dock: { hide: vi.fn() },
      focus: vi.fn(() => {
        throw new Error('the original app.focus() would steal focus');
      }),
    });
    installBackgroundWindowPolicy(
      app as unknown as App,
      FakeWindow as unknown as typeof BrowserWindow,
      null,
      { NODE_ENV: 'test' },
      'darwin',
      []
    );

    expect(app.setActivationPolicy).toHaveBeenCalledWith('regular');
    expect(app.dock.hide).not.toHaveBeenCalled();
    expect(() => app.focus()).not.toThrow();

    const window = new FakeWindow();
    window.show();
    window.focus();
    window.moveTop();
    expect(window.shownInactive).toBe(1);
    expect(window.opacity).toBe(1);
    expect(window.ignoresMouse).toBe(false);
    expect(window.level).toHaveBeenLastCalledWith(true, 'normal', -1);

    const created = new FakeWindow();
    app.emit('browser-window-created', {}, created);
    expect(created.opacity).toBe(1);
    expect(created.ignoresMouse).toBe(false);
    expect(created.level).toHaveBeenLastCalledWith(true, 'normal', -1);
    expect(app.setActivationPolicy).toHaveBeenCalledTimes(1);
  });
});

describe('agent launches stay behind the developer ', () => {
  it('applies launch identity to every window and prevents page titles removing it', () => {
    const app = Object.assign(new EventEmitter(), { focus: vi.fn() });
    installWindowIdentity(app, 'DNAForge · :49326 · fixture-task');
    for (let index = 0; index < 2; index += 1) {
      const window = Object.assign(new EventEmitter(), {
        setTitle: vi.fn(),
        isDestroyed: () => false,
        webContents: new EventEmitter(),
      });
      app.emit('browser-window-created', {}, window);
      expect(window.setTitle).toHaveBeenCalledWith('DNAForge · :49326 · fixture-task');
      window.setTitle('Electron');
      window.webContents.emit('did-finish-load');
      expect(window.setTitle).toHaveBeenLastCalledWith('DNAForge · :49326 · fixture-task');
      const event = { preventDefault: vi.fn() };
      window.emit('page-title-updated', event, 'Anonymous window');
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
  });

  it('installs one lower-window guard for every background macOS launch', () => {
    const protectedEnv = {
      NODE_ENV: 'development',
      DNAFORGE_BACKGROUND_WINDOW: '1',
      DNAFORGE_BACKGROUND_LAUNCH_SAFE: '1',
    };
    expect(shouldInstallBackgroundWindows(protectedEnv, 'darwin')).toBe(true);
    expect(shouldInstallBackgroundWindows(protectedEnv, 'linux')).toBe(false);
    expect(shouldInstallBackgroundWindows({ ...protectedEnv, NODE_ENV: 'test' }, 'darwin')).toBe(
      true
    );
    expect(
      shouldInstallBackgroundWindows(
        { ...protectedEnv, DNAFORGE_BACKGROUND_LAUNCH_SAFE: '0' },
        'darwin'
      )
    ).toBe(true);
  });

  it('keeps a regular dev window below normal windows and blocks automatic focus until selected', async () => {
    const originalShow = vi.fn();
    const originalFocus = vi.fn();
    const originalMoveTop = vi.fn();
    const originalAppFocus = vi.fn();
    class DevWindow {
      static windows: DevWindow[] = [];
      static getAllWindows() {
        return DevWindow.windows;
      }
      static getFocusedWindow() {
        return null;
      }
      level = vi.fn();
      shownInactive = vi.fn();
      constructor() {
        DevWindow.windows.push(this);
      }
      isDestroyed() {
        return false;
      }
      setAlwaysOnTop(...args: [boolean, string?, number?]) {
        this.level(...args);
      }
      showInactive() {
        this.shownInactive();
      }
      show() {
        originalShow();
      }
      focus() {
        originalFocus();
      }
      moveTop() {
        originalMoveTop();
      }
    }
    const app = Object.assign(new EventEmitter(), { focus: originalAppFocus });
    installBackgroundWindows(app as unknown as App, DevWindow as unknown as typeof BrowserWindow);
    const window = new DevWindow();
    app.emit('browser-window-created', {}, window);
    expect(window.level).toHaveBeenLastCalledWith(true, 'normal', -1);

    window.show();
    window.focus();
    window.moveTop();
    app.focus();
    expect(window.shownInactive).toHaveBeenCalledTimes(1);
    expect(originalShow).not.toHaveBeenCalled();
    expect(originalFocus).not.toHaveBeenCalled();
    expect(originalMoveTop).not.toHaveBeenCalled();
    expect(originalAppFocus).not.toHaveBeenCalled();

    app.emit('activate');
    expect(window.level).toHaveBeenLastCalledWith(true, 'normal', -1);
    window.focus();
    expect(originalFocus).not.toHaveBeenCalled();

    app.emit('browser-window-focus', {}, window);
    expect(window.level).toHaveBeenLastCalledWith(false);
    window.focus();
    expect(originalFocus).toHaveBeenCalledTimes(1);

    app.emit('browser-window-blur');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(window.level).toHaveBeenLastCalledWith(true, 'normal', -1);
    window.focus();
    expect(originalFocus).toHaveBeenCalledTimes(1);
  });

  it('recognises launches from Claude Code and Codex sessions', () => {
    expect(isAgentLaunch({ CLAUDECODE: '1' })).toBe(true);
    expect(isAgentLaunch({ CODEX_HOME: '/Users/x/.codex' })).toBe(true);
    expect(isAgentLaunch({ CODEX_CLI_PATH: '/opt/codex' })).toBe(true);
    expect(isAgentLaunch({})).toBe(false);
  });

  it('keeps an agent dev window visible and accessible without activating it', () => {
    expect(isBackgroundWindowMode({ CLAUDECODE: '1', NODE_ENV: 'development' })).toBe(true);
    expect(shouldRunE2EInBackground({ CODEX_HOME: '/x', NODE_ENV: 'development' }, 'darwin')).toBe(
      false
    );
    const app = { setActivationPolicy: vi.fn() };
    expect(
      applyBackgroundActivationPolicy(app, 'darwin', {
        CODEX_HOME: '/x',
        NODE_ENV: 'development',
        DNAFORGE_BACKGROUND_WINDOW: '1',
        DNAFORGE_BACKGROUND_LAUNCH_SAFE: '1',
      })
    ).toBe(true);
    expect(app.setActivationPolicy).toHaveBeenCalledWith('regular');
  });

  it('preserves the Dock icon even if a background launch bypasses the dev launcher', () => {
    const app = { setActivationPolicy: vi.fn() };
    expect(
      applyBackgroundActivationPolicy(app, 'darwin', {
        NODE_ENV: 'development',
        DNAFORGE_BACKGROUND_WINDOW: '1',
      })
    ).toBe(true);
    expect(app.setActivationPolicy).toHaveBeenCalledWith('regular');
  });

  it('lets the developer bring an agent launch forward on request, and leaves their own launches alone', () => {
    const foreground = { CLAUDECODE: '1', DNAFORGE_FOREGROUND_WINDOW: '1' };
    expect(isAgentLaunch(foreground)).toBe(false);
    expect(isBackgroundWindowMode({ ...foreground, NODE_ENV: 'development' })).toBe(false);
    expect(shouldRunE2EInBackground({ NODE_ENV: 'development' }, 'darwin')).toBe(false);
  });
});
