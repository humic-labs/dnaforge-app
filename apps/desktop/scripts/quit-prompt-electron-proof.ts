import {
  app,
  BrowserWindow,
  dialog,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
} from 'electron';
import { writeFileSync } from 'node:fs';

const userData = process.env.QUIT_PROOF_USER_DATA;
if (userData) app.setPath('userData', userData);
import { createQuitPromptBinding } from '../src/main/quit-prompt-binding';
import { showUnsavedWorkDialog } from '../src/main/quit-consent';
import { quitPromptSuppressed } from '../src/main/quit-prompt-timing';

type ProofResult = {
  mode: string;
  packaged: boolean;
  execPath: string;
  waypointTest: string | null;
  suppressed: boolean;
  phase: string;
  listenerReturned: boolean;
  dialogShown: boolean;
  visible: boolean | null;
  destroyed: boolean | null;
  windowCount: number;
  afterVisible: boolean | null;
  afterDestroyed: boolean | null;
  decision: string | null;
  dialogParented: boolean | null;
  dialogNoLink: boolean | null;
  dialogDetail: string | null;
  ownerDisabledDuringDialog: boolean | null;
  afterEnabled: boolean | null;
  afterRendererText: string | null;
};

const mode = process.env.QUIT_PROOF_MODE ?? 'fixed-quit';
const resultPath = process.env.QUIT_PROOF_RESULT;
if (!resultPath) {
  console.error('QUIT_PROOF_RESULT is required');
  process.exit(2);
}

const result: ProofResult = {
  mode,
  packaged: false,
  execPath: process.execPath,
  waypointTest: process.env.WAYPOINT_TEST ?? null,
  suppressed: false,
  phase: 'starting',
  listenerReturned: false,
  dialogShown: false,
  visible: null,
  destroyed: null,
  windowCount: 0,
  afterVisible: null,
  afterDestroyed: null,
  decision: null,
  dialogParented: null,
  dialogNoLink: null,
  dialogDetail: null,
  ownerDisabledDuringDialog: null,
  afterEnabled: null,
  afterRendererText: null,
};

function publish(patch: Partial<ProofResult>): void {
  Object.assign(result, patch);
  writeFileSync(resultPath!, JSON.stringify(result));
}

let proofWindow: BrowserWindow | null = null;
let listenerReturned = false;

function windowSnapshot(): { visible: boolean; destroyed: boolean; windowCount: number } {
  const win = proofWindow;
  const destroyed = !win || win.isDestroyed();
  return {
    visible: destroyed ? false : win.isVisible(),
    destroyed,
    windowCount: BrowserWindow.getAllWindows().filter((item) => !item.isDestroyed()).length,
  };
}

const originalShowMessageBox = dialog.showMessageBox.bind(dialog);
dialog.showMessageBox = ((...args: unknown[]) => {
  const entered = windowSnapshot();
  const options = args.at(-1) as MessageBoxOptions;
  if (process.platform === 'win32' && process.env.QUIT_PROOF_AUTO_CANCEL === '1') {
    const cancellation = new AbortController();
    options.signal = cancellation.signal;
    setTimeout(() => cancellation.abort(), 750);
  }
  publish({
    phase: 'dialog-entered',
    listenerReturned,
    dialogShown: true,
    visible: entered.visible,
    destroyed: entered.destroyed,
    windowCount: entered.windowCount,
    dialogParented: args.length === 2 && args[0] === proofWindow,
    dialogNoLink: options.noLink ?? false,
    dialogDetail: options.detail ?? null,
  });
  if (process.platform === 'win32') {
    setImmediate(() => {
      if (proofWindow && !proofWindow.isDestroyed()) {
        publish({ ownerDisabledDuringDialog: !proofWindow.isEnabled() });
      }
    });
  }
  return originalShowMessageBox(...(args as [MessageBoxOptions])) as Promise<MessageBoxReturnValue>;
}) as typeof dialog.showMessageBox;

function legacyDialog(): Promise<MessageBoxReturnValue> {
  return dialog.showMessageBox({
    type: 'warning',
    title: 'Unsaved Changes',
    message: 'You have unsaved changes in 2 sequences.',
    detail: 'Save your work with Cmd+S before closing, or close anyway and lose the changes.',
    buttons: ['Cancel', 'Close Anyway'],
    defaultId: 0,
    cancelId: 0,
  });
}

async function finish(decision: string): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  const after = windowSnapshot();
  let afterRendererText: string | null = null;
  if (decision === 'cancel' && proofWindow && !proofWindow.isDestroyed()) {
    afterRendererText = await proofWindow.webContents.executeJavaScript('document.body.innerText');
  }
  const afterEnabled = proofWindow && !proofWindow.isDestroyed() ? proofWindow.isEnabled() : null;
  const passed =
    decision !== 'cancel' ||
    (after.visible &&
      !after.destroyed &&
      afterEnabled &&
      afterRendererText?.includes('2 unsaved sequences'));
  publish({
    phase: passed ? 'finished' : 'failed',
    decision,
    afterVisible: after.visible,
    afterDestroyed: after.destroyed,
    afterEnabled,
    afterRendererText,
  });
  if (passed && decision === 'cancel' && process.env.QUIT_PROOF_KEEP_OPEN === '1') return;
  app.exit(passed ? 0 : 1);
}

app.whenReady().then(async () => {
  result.packaged = app.isPackaged;
  result.suppressed = quitPromptSuppressed(app.isPackaged, process.env.WAYPOINT_TEST);
  publish({ phase: 'ready', packaged: result.packaged, suppressed: result.suppressed });

  const win = new BrowserWindow({
    width: 480,
    height: 320,
    show: true,
    title: 'DNAForge Quit Proof',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  proofWindow = win;
  win.on('closed', () => {
    if (result.phase !== 'finished' && result.phase !== 'failed') {
      publish({ phase: 'window-closed', afterVisible: false, afterDestroyed: true });
    }
  });
  await win.loadURL('data:text/html,<title>DNAForge Quit Proof</title><p>2 unsaved sequences</p>');
  win.setTitle('DNAForge Quit Proof');
  win.show();
  publish({ phase: 'window-visible', ...windowSnapshot() });

  if (mode === 'legacy-quit') {
    let quitting = false;
    app.on('before-quit', (event) => {
      if (quitting) return;
      quitting = true;
      event.preventDefault();
      if (!win.isDestroyed()) win.hide();
      void legacyDialog().then((choice) => {
        if (choice.response === 0 && !win.isDestroyed()) win.show();
        finish(choice.response === 0 ? 'cancel' : 'proceed');
      });
      listenerReturned = true;
    });
    app.quit();
    return;
  }

  if (mode === 'legacy-close') {
    win.on('close', (event) => {
      event.preventDefault();
      void legacyDialog().then((choice) => {
        finish(choice.response === 0 ? 'cancel' : 'proceed');
      });
      listenerReturned = true;
    });
    win.close();
    return;
  }

  const binding = createQuitPromptBinding({
    isSuppressed: () => quitPromptSuppressed(app.isPackaged, process.env.WAYPOINT_TEST),
    isCutoverBuild: () => false,
    getDirty: () => ({ hasDirtyWork: true, details: '2 sequences' }),
    isUpdateStaged: () => false,
    hasConsent: () => false,
    grantConsent: () => undefined,
    showDialog: async (target, opts) => {
      const decision = await showUnsavedWorkDialog(target as BrowserWindow | null, opts);
      setImmediate(() => finish(decision));
      return decision;
    },
    getWindow: () => proofWindow,
    runQuit: async (controls) => {
      controls.freezeRenderer();
      if (!quitPromptSuppressed(app.isPackaged, process.env.WAYPOINT_TEST)) {
        const decision = await showUnsavedWorkDialog(win, {
          staged: false,
          details: '2 sequences',
        });
        if (decision === 'cancel') {
          controls.restoreRenderer();
          finish('cancel');
          return { cancelled: true };
        }
      }
      controls.concealRenderer();
      finish(result.suppressed ? 'suppressed' : 'proceed');
      return { cancelled: false };
    },
  });

  win.on('close', (event) => {
    binding.onWindowClose(event, win);
    listenerReturned = true;
  });
  if (mode === 'fixed-close') {
    win.close();
    return;
  }

  app.on('before-quit', (event) => {
    binding.onBeforeQuit(event);
    listenerReturned = true;
  });
  app.quit();
  if (mode === 'fixed-quit-repeat') {
    setTimeout(() => {
      app.quit();
      if (!win.isDestroyed()) win.close();
    }, 250);
  }
});
