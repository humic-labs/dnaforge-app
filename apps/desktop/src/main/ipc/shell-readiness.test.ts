import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { contractEntries } from '../../shared/ipc/contract';
import { startupContract } from '../../shared/ipc/startup.contract';

const declaredStartupHandlers = contractEntries(startupContract)
  .filter(({ kind }) => kind === 'invoke')
  .map(({ channel }) => channel)
  .sort();

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, value?: string) => unknown>(),
  boot: vi.fn(),
  log: vi.fn(),
  reportingEnabled: vi.fn(() => true),
}));
vi.mock('../../shared/ipc-contract', () => ({
  mainIpc: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, value?: string) => unknown) => {
      if (mocks.handlers.has(name)) {
        throw new Error(`Attempted to register a second handler for '${name}'`);
      }
      mocks.handlers.set(name, handler);
    },
    removeHandler: (name: string) => mocks.handlers.delete(name),
  },
  handleGroup: (
    contract: { readonly name: string },
    handlers: Readonly<
      Record<string, ((event: IpcMainInvokeEvent, value?: string) => unknown) | null>
    >
  ) => {
    for (const [method, handler] of Object.entries(handlers)) {
      if (!handler) continue;
      const channel = `${contract.name}:${method}`;
      if (mocks.handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`);
      }
      mocks.handlers.set(channel, handler);
    }
    return () => undefined;
  },
}));
vi.mock('../diagnostics-upload', () => ({ notifyBootSucceeded: mocks.boot }));
vi.mock('../boot-log', () => ({ appendBootLog: mocks.log }));
vi.mock('../sentry', () => ({ isSentryReportingEnabled: mocks.reportingEnabled }));

describe('native startup acknowledgement boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.handlers.clear();
    vi.clearAllMocks();
    mocks.reportingEnabled.mockReturnValue(true);
  });

  it('accepts only the current top-level product frame and removes window state on close', async () => {
    const { installShellReadiness, getShellReadiness } = await import('./shell-readiness');
    const url = 'file:///app/renderer/index.html';
    const frame = { url };
    const contents = Object.assign(new EventEmitter(), {
      mainFrame: frame,
      isDestroyed: () => false,
    });
    const window = Object.assign(new EventEmitter(), { webContents: contents });
    const onReady = vi.fn();
    installShellReadiness(window as unknown as BrowserWindow, url, onReady);
    const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    const read = () =>
      mocks.handlers.get('startup:getState')!(event) as { loadId: string; shellReady: boolean };
    const ack = mocks.handlers.get('startup:acknowledge')!;
    const reportingEnabled = mocks.handlers.get('startup:isErrorReportingEnabled')!;
    expect(reportingEnabled(event)).toBe(true);
    mocks.reportingEnabled.mockReturnValue(false);
    expect(reportingEnabled(event)).toBe(false);
    mocks.reportingEnabled.mockReturnValue(true);
    contents.emit('did-start-navigation', {}, url, false, true);
    const old = read();
    contents.emit('did-finish-load');
    expect(read().shellReady).toBe(false);
    for (const untrusted of [
      { sender: {}, senderFrame: frame },
      { sender: contents, senderFrame: { url } },
      { sender: contents, senderFrame: null },
    ]) {
      const untrustedEvent: IpcMainInvokeEvent = untrusted as unknown as IpcMainInvokeEvent;
      expect(ack(untrustedEvent, old.loadId)).toBe(false);
      expect(reportingEnabled(untrustedEvent)).toBe(false);
    }
    frame.url = 'https://untrusted.example';
    expect(ack(event, old.loadId)).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
    frame.url = url;
    expect(ack(event, old.loadId)).toBe(true);
    expect(onReady).toHaveBeenCalledExactlyOnceWith(old.loadId);
    expect(ack(event, old.loadId)).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(
      getShellReadiness(window.webContents as unknown as BrowserWindow['webContents'])
    ).toMatchObject({
      loadId: old.loadId,
      shellReady: true,
    });
    expect(mocks.boot).toHaveBeenCalledTimes(1);
    contents.emit('did-start-navigation', {}, url, true, true);
    contents.emit('did-start-navigation', {}, url, false, false);
    expect(read().loadId).toBe(old.loadId);
    contents.emit('did-start-navigation', {}, url, false, true);
    expect(ack(event, old.loadId)).toBe(false);
    expect(onReady).toHaveBeenCalledTimes(1);
    contents.emit('did-finish-load');
    expect(ack(event, read().loadId)).toBe(true);
    expect(onReady).toHaveBeenLastCalledWith(read().loadId);
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(mocks.boot).toHaveBeenCalledTimes(1);
    expect(
      mocks.log.mock.calls.filter(([line]) => line.startsWith('renderer_shell_ready'))
    ).toHaveLength(2);
    const beforeCrash = read();
    contents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(read().shellReady).toBe(false);
    expect(read().loadId).not.toBe(beforeCrash.loadId);
    expect(ack(event, beforeCrash.loadId)).toBe(false);
    expect(mocks.log).toHaveBeenLastCalledWith(`renderer_shell_invalidated load=${read().loadId}`);
    window.emit('closed');
    expect(
      getShellReadiness(window.webContents as unknown as BrowserWindow['webContents'])
    ).toBeUndefined();
    expect([...mocks.handlers.keys()].sort()).toEqual(declaredStartupHandlers);
  });

  it('installs process-global handlers once and routes simultaneous windows by sender', async () => {
    const { installShellReadiness, getShellReadiness } = await import('./shell-readiness');
    const createWindow = (url: string) => {
      const frame = { url };
      const contents = Object.assign(new EventEmitter(), {
        mainFrame: frame,
        isDestroyed: () => false,
      });
      const window = Object.assign(new EventEmitter(), { webContents: contents });
      return { frame, contents, window };
    };
    const first = createWindow('file:///app/renderer/index.html');
    const second = createWindow('file:///app/renderer/index.html');

    installShellReadiness(first.window as unknown as BrowserWindow, first.frame.url);
    expect(() =>
      installShellReadiness(second.window as unknown as BrowserWindow, second.frame.url)
    ).not.toThrow();
    expect([...mocks.handlers.keys()].sort()).toEqual(declaredStartupHandlers);

    const read = mocks.handlers.get('startup:getState')!;
    second.contents.emit('did-start-navigation', {}, second.frame.url, false, true);
    const firstState = read({
      sender: first.contents,
      senderFrame: first.frame,
    } as unknown as IpcMainInvokeEvent);
    const secondState = read({
      sender: second.contents,
      senderFrame: second.frame,
    } as unknown as IpcMainInvokeEvent);
    expect(firstState).not.toEqual(secondState);

    first.window.emit('closed');
    expect(
      getShellReadiness(first.contents as unknown as BrowserWindow['webContents'])
    ).toBeUndefined();
    expect(() =>
      read({
        sender: second.contents,
        senderFrame: second.frame,
      } as unknown as IpcMainInvokeEvent)
    ).not.toThrow();
  });
});
