import { userMessage } from '@waypoint/user-messages';
import { createUserDialogs, type UserMessageBoxOptions } from './user-dialogs';
import { app, dialog, powerMonitor, type BrowserWindow } from 'electron';
import type { HangResolution, HangSource } from './analytics';

let rendererAvailable = false;

export function isRendererAvailable(): boolean {
  return rendererAvailable;
}

export interface RendererRecoveryDeps {
  isQuitting: () => boolean;
  isSafeMode?: () => boolean;
  suppressDialogs: () => boolean;
  devServerUrl?: string;
  appUrl?: string;
  heartbeatMs?: number;
  hungAfterMs?: number;
  showMessageBox?: (
    win: BrowserWindow,
    opts: UserMessageBoxOptions
  ) => Promise<{ response: number }>;
  quit?: () => void;
}

export type RendererHangEvent =
  | { phase: 'detected'; source: HangSource }
  | { phase: 'resolved'; source: HangSource; resolution: HangResolution; durationMs: number };

const hangListeners = new Set<(event: RendererHangEvent) => void>();

export function onRendererHang(listener: (event: RendererHangEvent) => void): () => void {
  hangListeners.add(listener);
  return () => hangListeners.delete(listener);
}

function reportHang(event: RendererHangEvent): void {
  for (const listener of hangListeners) listener(event);
}

const ERR_ABORTED = -3;

export function installRendererRecovery(win: BrowserWindow, deps: RendererRecoveryDeps): void {
  const showMessageBox =
    deps.showMessageBox ??
    ((owner: BrowserWindow, opts: UserMessageBoxOptions) =>
      createUserDialogs(dialog).showMessageBox(owner, opts));
  const quit = deps.quit ?? (() => app.quit());
  const contents = win.webContents;
  let prompt: Promise<void> | null = null;
  let reloadingAfterKill = false;
  let hang: { source: HangSource; startedAt: number } | null = null;
  const beginHang = (source: HangSource) => {
    if (hang) return;
    hang = { source, startedAt: Date.now() };
    reportHang({ phase: 'detected', source });
  };
  const endHang = (resolution: HangResolution) => {
    if (!hang) return;
    const ended = hang;
    hang = null;
    reportHang({
      phase: 'resolved',
      source: ended.source,
      resolution,
      durationMs: Date.now() - ended.startedAt,
    });
  };
  const heartbeatMs = deps.heartbeatMs ?? 5000;
  const hungAfterMs = deps.hungAfterMs ?? 15_000;
  let lastAnswerAt = Date.now();
  let lastHeartbeatAt = lastAnswerAt;
  let wakeGraceUntil = 0;
  let probing: object | null = null;
  let reportedHung = false;
  let suspended = false;
  let closed = false;
  let hangPromptAbort: AbortController | null = null;
  let deferredPrompt: {
    opts: Omit<UserMessageBoxOptions, 'type' | 'noLink'>;
    onAnswer: (response: number) => void;
  } | null = null;

  const clearDeferredPrompt = () => {
    deferredPrompt?.opts.signal?.removeEventListener('abort', clearDeferredPrompt);
    deferredPrompt = null;
    win.removeListener('focus', presentDeferredPrompt);
  };
  function presentDeferredPrompt() {
    if (!deferredPrompt || !win.isFocused()) return;
    const request = deferredPrompt;
    clearDeferredPrompt();
    ask(request.opts, request.onAnswer);
  }

  const dismissHangPrompt = () => {
    hangPromptAbort?.abort();
    hangPromptAbort = null;
  };

  const resetHeartbeat = () => {
    lastAnswerAt = Date.now();
    lastHeartbeatAt = lastAnswerAt;
    wakeGraceUntil = lastAnswerAt + hungAfterMs;
    probing = null;
    reportedHung = false;
  };
  const acknowledgeRenderer = () => {
    if (deps.isSafeMode?.()) {
      rendererAvailable = false;
      return;
    }
    clearDeferredPrompt();
    dismissHangPrompt();
    endHang('recovered');
    lastAnswerAt = Date.now();
    reportedHung = false;
    rendererAvailable = true;
  };
  const probeRenderer = () => {
    if (probing || suspended || closed || win.isDestroyed()) return;
    const probe = {};
    probing = probe;
    void contents
      .executeJavaScript('1')
      .then(() => {
        if (probing === probe && !suspended && !closed && !win.isDestroyed()) {
          acknowledgeRenderer();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (probing === probe) probing = null;
      });
  };

  const ask = (
    opts: Omit<UserMessageBoxOptions, 'type' | 'noLink'>,
    onAnswer: (response: number) => void
  ): void => {
    if (
      closed ||
      prompt ||
      deferredPrompt ||
      opts.signal?.aborted ||
      deps.isQuitting() ||
      deps.isSafeMode?.() ||
      win.isDestroyed()
    )
      return;
    if (deps.suppressDialogs()) {
      console.warn('[renderer-recovery]', opts.message);
      return;
    }
    if (!win.isFocused()) {
      deferredPrompt = { opts, onAnswer };
      win.on('focus', presentDeferredPrompt);
      opts.signal?.addEventListener('abort', clearDeferredPrompt, { once: true });
      return;
    }
    prompt = showMessageBox(win, { type: 'warning', noLink: true, ...opts })
      .then(({ response }) => {
        if (!opts.signal?.aborted && !win.isDestroyed() && !deps.isSafeMode?.()) onAnswer(response);
      })
      .catch((error: unknown) => console.error('[renderer-recovery] prompt failed:', error))
      .finally(() => {
        prompt = null;
      });
  };

  contents.on('did-finish-load', acknowledgeRenderer);
  contents.on('responsive', acknowledgeRenderer);

  let finishReplacement: (() => void) | null = null;
  const replaceHungRenderer = () => {
    endHang('reloaded');
    reloadingAfterKill = true;
    const pid = contents.getOSProcessId();
    let done = false;
    const reload = () => {
      if (done || win.isDestroyed() || deps.isSafeMode?.()) return;
      done = true;
      finishReplacement = null;
      clearTimeout(fallback);
      contents.reload();
    };
    const fallback = setTimeout(reload, 3000);
    finishReplacement = reload;
    if (pid > 0) {
      try {
        process.kill(pid, 'SIGKILL');
        return;
      } catch {}
    }
    contents.forcefullyCrashRenderer();
  };

  contents.on('render-process-gone', () => {
    probing = null;
    rendererAvailable = false;
    endHang('crashed');
    if (deps.isSafeMode?.()) return;
    if (reloadingAfterKill) {
      reloadingAfterKill = false;
      finishReplacement?.();
      return;
    }
    ask(
      {
        title: userMessage('dialog.window-stopped-working'),
        message: userMessage('dialog.the-dnaforge-window-stopped-working'),
        detail: userMessage(
          'dialog.reload-the-window-to-continue-unsaved-sequence-edits-are-kept-and-dnaf'
        ),
        buttons: [userMessage('dialog.reload-window'), userMessage('dialog.quit-dnaforge')],
        defaultId: 0,
        cancelId: 0,
      },
      (response) => (response === 1 ? quit() : contents.reload())
    );
  });

  const promptUnresponsive = () => {
    const now = Date.now();
    const elapsed = now - lastHeartbeatAt;
    if (elapsed > heartbeatMs * 2 || elapsed < 0) resetHeartbeat();
    if (suspended || now < wakeGraceUntil || prompt) return;
    rendererAvailable = false;
    hangPromptAbort = new AbortController();
    ask(
      {
        signal: hangPromptAbort.signal,
        title: userMessage('dialog.not-responding'),
        message: userMessage('dialog.dnaforge-isn-t-responding'),
        detail: userMessage(
          'dialog.you-can-wait-for-it-to-finish-or-reload-the-window-reloading-keeps-uns'
        ),
        buttons: [userMessage('dialog.wait'), userMessage('dialog.reload-window')],
        defaultId: 0,
        cancelId: 0,
      },
      (response) => {
        if (response !== 1) return;
        replaceHungRenderer();
      }
    );
  };
  contents.on('unresponsive', () => {
    beginHang('chromium');
    promptUnresponsive();
  });
  const onSuspend = () => {
    dismissHangPrompt();
    suspended = true;
    resetHeartbeat();
  };
  const onResume = () => {
    suspended = false;
    resetHeartbeat();
    probeRenderer();
  };
  powerMonitor.on('suspend', onSuspend);
  powerMonitor.on('resume', onResume);

  const dispose = () => {
    clearDeferredPrompt();
    dismissHangPrompt();
    closed = true;
    probing = null;
    clearInterval(heartbeat);
    powerMonitor.removeListener('suspend', onSuspend);
    powerMonitor.removeListener('resume', onResume);
  };
  const heartbeat = setInterval(() => {
    if (win.isDestroyed()) {
      dispose();
      return;
    }
    if (suspended || deps.isQuitting() || deps.isSafeMode?.()) return;
    const now = Date.now();
    const elapsed = now - lastHeartbeatAt;
    if (elapsed > heartbeatMs * 2 || elapsed < 0) resetHeartbeat();
    lastHeartbeatAt = now;
    if (contents.isLoadingMainFrame() || contents.isCrashed()) {
      lastAnswerAt = now;
      return;
    }
    probeRenderer();
    if (!reportedHung && now - lastAnswerAt > hungAfterMs) {
      reportedHung = true;
      beginHang('heartbeat');
      promptUnresponsive();
    }
  }, heartbeatMs);
  win.once('closed', () => {
    dispose();
    endHang(deps.isQuitting() ? 'app_quit' : 'window_closed');
  });

  contents.on(
    'did-fail-load',
    (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === ERR_ABORTED) return;
      rendererAvailable = false;
      const devServer = deps.devServerUrl && validatedURL.startsWith(deps.devServerUrl);
      ask(
        {
          title: userMessage('dialog.couldn-t-load-the-window'),
          message: devServer
            ? userMessage('dialog.dnaforge-can-t-reach-its-development-server')
            : userMessage('dialog.the-dnaforge-window-couldn-t-load'),
          detail: userMessage('startup.reloadWindow'),
          buttons: [userMessage('dialog.try-again'), userMessage('dialog.quit-dnaforge')],
          defaultId: 0,
          cancelId: 0,
        },
        (response) => {
          if (response === 1) quit();
          else if (deps.appUrl) void contents.loadURL(deps.appUrl).catch(() => undefined);
          else contents.reload();
        }
      );
    }
  );
}

export function resetRendererRecoveryForTests(): void {
  rendererAvailable = false;
  hangListeners.clear();
}
