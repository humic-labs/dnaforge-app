import type { App, BrowserWindow as BrowserWindowType } from 'electron';
import {
  backgroundWindowRequested,
  isAgentLaunch as agentLaunch,
  isTestLaunch,
} from '../../scripts/background-window-policy.cjs';

export { testWindowExceedsDisplay } from './test-window-exceeds-display';

export const DNAFORGE_BACKGROUND_WINDOW_ENV = 'DNAFORGE_BACKGROUND_WINDOW';
type ActivationTarget = Pick<
  BrowserWindowType,
  'isDestroyed' | 'isMinimized' | 'restore' | 'focus' | 'isVisible' | 'show'
>;
type ActivationWindow = ActivationTarget &
  Pick<BrowserWindowType, 'id' | 'showInactive' | 'moveTop' | 'setAlwaysOnTop'> & {
    webContents: Pick<BrowserWindowType['webContents'], 'focus'>;
  };
type ActivationApp = Pick<App, 'focus' | 'setActivationPolicy'> & Pick<NodeJS.EventEmitter, 'on'>;
type ActivationWindows = {
  prototype: ActivationWindow;
  getAllWindows(): ActivationWindow[];
  getFocusedWindow(): ActivationWindow | null;
};
const userActivationWindows = new WeakSet<ActivationTarget>();

export function isAgentLaunch(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DNAFORGE_FOREGROUND_WINDOW === '1') return false;
  return agentLaunch(env);
}

export function isBackgroundWindowMode(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  argv: readonly string[] = process.argv
): boolean {
  return backgroundWindowRequested(env, platform, argv);
}

export function focusWindowUnlessBackground(window: ActivationTarget | null): void {
  if (!window || window.isDestroyed() || isBackgroundWindowMode()) return;
  userActivationWindows.add(window);
  try {
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
  } finally {
    userActivationWindows.delete(window);
  }
}

export function applyBackgroundActivationPolicy(
  app: Pick<Electron.App, 'setActivationPolicy'>,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv
): boolean {
  if (platform !== 'darwin' || !isBackgroundWindowMode(env, platform, argv)) return false;
  app.setActivationPolicy('regular');
  return true;
}

export function shouldRunE2EInBackground(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  argv: readonly string[] = []
): boolean {
  return isTestLaunch(env, argv) && backgroundWindowRequested(env, platform, argv);
}

export function shouldInstallBackgroundWindows(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'darwin' && isBackgroundWindowMode(env, platform);
}

export function installBackgroundWindows(
  app: ActivationApp,
  BrowserWindow: ActivationWindows,
  background = true,
  report: (detail: string) => void = () => {}
): void {
  let selected = false;
  const canActivate = (window: ActivationWindow, method: string) => {
    if (selected || userActivationWindows.has(window)) return true;
    report(`blocked method=${method} window=${window.id}`);
    return false;
  };
  const lower = (window: ActivationWindow) => {
    if (background && !window.isDestroyed()) window.setAlwaysOnTop(true, 'normal', -1);
  };
  const restore = (window: ActivationWindow) => {
    if (background && !window.isDestroyed()) window.setAlwaysOnTop(false);
  };
  const originalAppFocus = app.focus.bind(app);
  app.focus = (...args: Parameters<App['focus']>) => {
    if (selected) originalAppFocus(...args);
    else report('blocked method=app.focus');
  };
  const prototype = BrowserWindow.prototype;
  const originalShow = prototype.show;
  const originalShowInactive = prototype.showInactive;
  const originalFocus = prototype.focus;
  const originalMoveTop = prototype.moveTop;
  const originalRestore = prototype.restore;
  prototype.showInactive = function showInactive(this: ActivationWindow) {
    if (!selected) lower(this);
    originalShowInactive.call(this);
    if (!selected) lower(this);
  };
  prototype.show = function show(this: ActivationWindow) {
    if (canActivate(this, 'show')) originalShow.call(this);
    else this.showInactive();
  };
  prototype.focus = function focus(this: ActivationWindow) {
    if (canActivate(this, 'focus')) originalFocus.call(this);
  };
  prototype.moveTop = function moveTop(this: ActivationWindow) {
    if (canActivate(this, 'moveTop')) originalMoveTop.call(this);
  };
  if (originalRestore) {
    prototype.restore = function restore(this: ActivationWindow) {
      if (canActivate(this, 'restore')) originalRestore.call(this);
    };
  }
  app.on('browser-window-created', (_event, window: ActivationWindow) => {
    if (!selected) lower(window);
    const contents = window.webContents;
    if (typeof contents?.focus === 'function') {
      const originalContentsFocus = contents.focus.bind(contents);
      contents.focus = () => {
        if (canActivate(window, 'webContents.focus')) originalContentsFocus();
      };
    }
  });

  app.on('browser-window-focus', (_event, window) => {
    report(`native_focus window=${window?.id}`);
    selected = true;
    for (const window of BrowserWindow.getAllWindows()) restore(window);
  });
  app.on('browser-window-blur', (_event, window) => {
    report(`native_blur window=${window?.id}`);
    selected = false;
    setImmediate(() => {
      if (BrowserWindow.getFocusedWindow()) return;
      for (const window of BrowserWindow.getAllWindows()) lower(window);
    });
  });
}

export function installWindowIdentity(
  app: {
    on(
      event: 'browser-window-created',
      listener: (_event: unknown, window: BrowserWindowType) => void
    ): void;
  },
  title: string
): void {
  app.on('browser-window-created', (_event, window) => {
    const applyTitle = () => {
      if (!window.isDestroyed()) window.setTitle(title);
    };
    applyTitle();

    window.webContents.on('did-finish-load', applyTitle);
    window.on('ready-to-show', applyTitle);
    window.on('page-title-updated', (event) => {
      event.preventDefault();
      applyTitle();
    });
  });
}

export function installBackgroundWindowPolicy(
  app: ActivationApp,
  BrowserWindow: ActivationWindows,
  title: string | null,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  argv: readonly string[] = process.argv,
  report?: (detail: string) => void
): void {
  if (title) installWindowIdentity(app, title);
  if (platform !== 'darwin') return;
  const background = isBackgroundWindowMode(env, platform, argv);
  applyBackgroundActivationPolicy(app, platform, env, argv);
  installBackgroundWindows(app, BrowserWindow, background, report);
}
