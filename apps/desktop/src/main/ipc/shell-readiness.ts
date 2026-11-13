import { startupContract } from '../../shared/ipc/startup.contract';
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
import { handleGroup } from '../../shared/ipc-contract';
import { isTrustedRendererUrl } from '../security';
import { ShellReadiness } from '../shell-readiness';
import { appendBootLog } from '../boot-log';
import { notifyBootSucceeded } from '../diagnostics-upload';
import { isSentryReportingEnabled } from '../sentry';

let bootReported = false;
const nativeReadiness = new WeakMap<WebContents, ShellReadiness>();
const trustedRendererUrls = new WeakMap<WebContents, string>();
let handlersInstalled = false;

function readinessForEvent(event: IpcMainInvokeEvent): ShellReadiness | undefined {
  const contents = event.sender;
  const readiness = nativeReadiness.get(contents);
  const trustedUrl = trustedRendererUrls.get(contents);
  if (
    !readiness ||
    !trustedUrl ||
    contents.isDestroyed() ||
    event.senderFrame !== contents.mainFrame ||
    !event.senderFrame ||
    !isTrustedRendererUrl(event.senderFrame.url, trustedUrl)
  ) {
    return undefined;
  }
  return readiness;
}

export function getCurrentRendererLoad(
  event: IpcMainInvokeEvent
): Readonly<{ loadId: string }> | undefined {
  const readiness = readinessForEvent(event);
  return readiness ? Object.freeze({ loadId: readiness.snapshot().loadId }) : undefined;
}

function installGlobalHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  handleGroup(startupContract, {
    isErrorReportingEnabled: (event) =>
      readinessForEvent(event) !== undefined && isSentryReportingEnabled(),
    getState: (event) => {
      const readiness = readinessForEvent(event);
      if (!readiness) throw new Error('Untrusted startup sender');
      return readiness.snapshot();
    },
    acknowledge: (event, loadId: string) => {
      return readinessForEvent(event)?.acknowledge(loadId) ?? false;
    },
  });
}

export function getShellReadiness(contents: WebContents) {
  return contents.isDestroyed() ? undefined : nativeReadiness.get(contents)?.snapshot();
}

const shellReadyListeners = new Set<() => void>();

export function onShellReady(listener: () => void): () => void {
  shellReadyListeners.add(listener);
  return () => shellReadyListeners.delete(listener);
}

export function installShellReadiness(
  window: BrowserWindow,
  trustedUrl: string,
  onReady?: (loadId: string) => void
): void {
  const contents = window.webContents;
  const readiness = new ShellReadiness((loadId) => {
    appendBootLog(`renderer_shell_ready load=${loadId}`);
    if (!bootReported) {
      bootReported = true;
      notifyBootSucceeded();
    }
    for (const listener of shellReadyListeners) listener();
    onReady?.(loadId);
  });
  nativeReadiness.set(contents, readiness);
  trustedRendererUrls.set(contents, trustedUrl);
  installGlobalHandlers();
  contents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    if (!isMainFrame || inPlace) return;
    const { loadId } = readiness.beginLoad();
    appendBootLog(`renderer_load_started load=${loadId}`);
  });
  contents.on('did-finish-load', () => {
    appendBootLog(`renderer_did_finish_load load=${readiness.snapshot().loadId}`);
    readiness.pageLoaded();
  });
  contents.on('render-process-gone', () => {
    const { loadId } = readiness.beginLoad();
    appendBootLog(`renderer_shell_invalidated load=${loadId}`);
  });
  window.once('closed', () => {
    nativeReadiness.delete(contents);
    trustedRendererUrls.delete(contents);
  });
}
