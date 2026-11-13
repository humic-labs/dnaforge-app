import { BrowserWindow, webContents, type WebPreferences } from 'electron';
import { TerminalService } from './terminal-service';
import { getMainWindowChromeOptions } from '../window-chrome';
import { isTrustedRendererUrl } from '../security';

export class TerminalWindows {
  private readonly windows = new Map<
    number,
    { window: BrowserWindow; root: number; groupId: string }
  >();
  constructor(
    private readonly options: {
      terminals: TerminalService;
      trustedRendererUrl(): string | null;
      primaryOwner(): number | null;
      preload(): Pick<WebPreferences, 'preload' | 'additionalArguments'>;
      stopping(): boolean;
      changed(owner: number): void;
    }
  ) {}

  owners(root: number): number[] {
    return [...this.windows].filter(([, entry]) => entry.root === root).map(([owner]) => owner);
  }

  group(owner: number): string | undefined {
    return this.windows.get(owner)?.groupId;
  }

  root(owner: number): number | null {
    return this.windows.get(owner)?.root ?? (owner === this.options.primaryOwner() ? owner : null);
  }

  async move(owner: number, ids: string[], groupId: string): Promise<void> {
    const root = this.root(owner);
    const url = this.options.trustedRendererUrl();
    const sender = webContents.fromId(owner);
    const parent = sender && BrowserWindow.fromWebContents(sender);
    if (!root || !url || !parent || parent.isDestroyed())
      throw new Error('The terminal window is unavailable.');
    if (
      typeof groupId !== 'string' ||
      !/^[\da-f-]{36}$/i.test(groupId) ||
      !Array.isArray(ids) ||
      !ids.length ||
      new Set(ids).size !== ids.length
    )
      throw new Error('Invalid terminal group.');
    const owned = new Set(this.options.terminals.list(owner).map((session) => session.id));
    if (ids.some((id) => !owned.has(id))) throw new Error('Terminal is not owned by this window.');
    const preferences = this.options.preload();
    if (!preferences.preload) throw new Error('The terminal preload is unavailable.');
    const window = new BrowserWindow({
      width: 900,
      height: 600,
      minWidth: 450,
      minHeight: 250,
      show: false,
      title: 'DNAForge Terminal',
      ...getMainWindowChromeOptions(),
      webPreferences: {
        preload: preferences.preload,
        additionalArguments: preferences.additionalArguments,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    const target = window.webContents.id;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, destination) => {
      if (!isTrustedRendererUrl(destination, url)) event.preventDefault();
    });
    this.windows.set(target, { window, root, groupId });
    window.on('close', () => this.release(target));
    window.once('closed', () => {
      this.release(target);
      this.windows.delete(target);
      this.options.changed(root);
    });
    window.once('ready-to-show', () => {
      if (!window.isDestroyed()) window.showInactive();
    });
    try {
      this.options.terminals.transferSessions(owner, target, ids);
      const renderer = new URL(url);
      renderer.searchParams.set('terminal-window', groupId);
      await window.loadURL(renderer.toString());
    } catch (error) {
      const sessions = this.options.terminals.list(target);
      if (sessions.length)
        this.options.terminals.transferSessions(
          target,
          owner,
          sessions.map((session) => session.id),
          groupId
        );
      window.destroy();
      throw error;
    }
  }

  release(owner: number): void {
    const entry = this.windows.get(owner);
    if (!entry || this.options.stopping()) return;
    const destination = webContents.fromId(entry.root);
    if (destination && !destination.isDestroyed()) {
      const sessions = this.options.terminals.list(owner);
      if (sessions.length)
        this.options.terminals.transferSessions(
          owner,
          entry.root,
          sessions.map((session) => session.id),
          entry.groupId
        );
    }
  }

  returnToMain(owner: number): void {
    const entry = this.windows.get(owner);
    if (!entry) throw new Error('This is not a floating terminal window.');
    const destination = webContents.fromId(entry.root);
    if (!destination || destination.isDestroyed()) throw new Error('The main window has closed.');
    entry.window.close();
  }
}
