import {
  type UserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
} from '@waypoint/user-messages';
import { createUserDialogs, type UserMessageBoxOptions } from './user-dialogs';
import { app, dialog, type BrowserWindow } from 'electron';
import { basename } from 'node:path';
import {
  SaveAllCancelled,
  failedSaveAllResult,
  type SaveAllResult,
} from '../shared/save-all-result';

type QuitConsent = 'pending' | 'granted';
let quitConsent: QuitConsent = 'pending';
let pendingDialog: Promise<'proceed' | 'cancel'> | null = null;

export function setQuitConsentGranted(): void {
  quitConsent = 'granted';
}

export function resetQuitConsent(): void {
  quitConsent = 'pending';
}

export function hasQuitConsent(): boolean {
  return quitConsent === 'granted';
}

export function shouldSuppressBlockingDialogs(): boolean {
  return !app.isPackaged && process.env.WAYPOINT_TEST === '1';
}

export function revealQuitPromptWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed() || typeof win.show !== 'function') return;
  win.show();
}

export type UnsavedWorkAction = 'close' | 'restart' | 'reload';

export interface UnsavedWorkDialogOptions {
  staged: boolean;
  details: string;

  action?: UnsavedWorkAction;
}

export interface UnsavedWorkSaver {
  canSave: () => boolean;
  saveAll: (win: BrowserWindow | null) => Promise<void>;
  readDirty: () =>
    | { hasDirtyWork: boolean; details: string }
    | Promise<{ hasDirtyWork: boolean; details: string }>;
  discardRecoveryCopies?: (win: BrowserWindow | null) => Promise<void>;
}

let saver: UnsavedWorkSaver | null = null;

export function configureUnsavedWorkSaver(next: UnsavedWorkSaver | null): void {
  saver = next;
}

export function showUnsavedWorkDialog(
  win: BrowserWindow | null,
  opts: UnsavedWorkDialogOptions
): Promise<'proceed' | 'cancel'> {
  if (pendingDialog) return pendingDialog;
  pendingDialog = presentUnsavedWorkDialog(win, opts).finally(() => {
    pendingDialog = null;
  });
  return pendingDialog;
}

const ACTION_VERBS: Record<UnsavedWorkAction, string> = {
  close: 'Close',
  restart: 'Restart',
  reload: 'Reload',
};

const CANCEL = 0;
const DISCARD = 1;
const SAVE = 2;

async function presentUnsavedWorkDialog(
  win: BrowserWindow | null,
  opts: UnsavedWorkDialogOptions
): Promise<'proceed' | 'cancel'> {
  const action = opts.action ?? (opts.staged ? 'restart' : 'close');
  const verb = ACTION_VERBS[action];
  const canSave = saver?.canSave() === true;
  const saveShortcut = process.platform === 'darwin' ? 'Cmd+S' : 'Ctrl+S';
  const purpose = action === 'restart' ? ' to install the update' : '';

  let detail: UserMessage;
  if (canSave) {
    detail = userMessageWithValues('dialog.unsavedSaveQuestion', {
      action: userMessageValue(verb.toLowerCase()),
      purpose: userMessageValue(purpose),
    });
  } else if (saver) {
    detail = userMessage('dialog.unsavedNotResponding');
  } else {
    detail = userMessageWithValues('dialog.unsavedManualSave', {
      shortcut: userMessageValue(saveShortcut),
      action: userMessageValue(verb.toLowerCase()),
      purpose: userMessageValue(purpose),
    });
  }
  const buttons = canSave
    ? [
        userMessage('dialog.cancel'),
        userMessageWithValues('dialog.value-without-saving', { value0: userMessageValue(verb) }),
        userMessageWithValues('dialog.unsavedSave', { action: userMessageValue(verb) }),
      ]
    : [
        userMessage('dialog.cancel'),
        userMessageWithValues('dialog.unsavedAnyway', { action: userMessageValue(verb) }),
      ];
  const response = await showWarning(win, {
    title: userMessage('dialog.unsaved-changes'),
    message: userMessageWithValues('dialog.you-have-unsaved-changes-in-value', {
      value0: userMessageValue(opts.details),
    }),
    detail,
    buttons,
    defaultId: canSave ? SAVE : CANCEL,
  });
  if (response === DISCARD) {
    if (canSave && !(await discardCopies(win))) return 'cancel';
    return 'proceed';
  }
  if (!canSave || response !== SAVE || !saver) return 'cancel';

  let saveFailed = false;
  let failureDetails = '';
  try {
    await saver.saveAll(win);
  } catch (error) {
    if (error instanceof SaveAllCancelled) return 'cancel';
    saveFailed = true;
    failureDetails = describeSaveFailures(failedSaveAllResult(error));
    console.warn('[quit-consent] Some changes were not saved:', error);
  }
  let remaining: { hasDirtyWork: boolean; details: string };
  try {
    remaining = await saver.readDirty();
  } catch {
    remaining = {
      hasDirtyWork: true,
      details: 'open documents',
    };
  }
  if (!remaining.hasDirtyWork && !saveFailed) return 'proceed';

  const retry = await showWarning(win, {
    title: userMessage('dialog.some-changes-were-not-saved'),
    message: userMessageWithValues('dialog.dnaforge-couldn-t-save-value', {
      value0: userMessageValue(remaining.details || 'some of your changes'),
    }),
    detail: failureDetails
      ? userMessageWithValues('dialog.unsavedSaveFailure', {
          failures: userMessageValue(failureDetails),
          action: userMessageValue(verb.toLowerCase()),
        })
      : userMessageWithValues(
          'dialog.cancel-to-keep-working-and-try-saving-again-or-value-without-them',
          { value0: userMessageValue(verb.toLowerCase()) }
        ),
    buttons: [
      userMessage('dialog.cancel'),
      userMessageWithValues('dialog.value-without-saving', { value0: userMessageValue(verb) }),
    ],
    defaultId: CANCEL,
  });
  if (retry !== DISCARD) return 'cancel';
  if (!(await discardCopies(win))) return 'cancel';
  return 'proceed';
}

function describeSaveFailures(result: Extract<SaveAllResult, { status: 'failed' }>): string {
  const lines = result.failures.slice(0, 5).map((failure) => {
    const name = failure.path ? basename(failure.path.replaceAll('\\', '/')) : '';
    const reason = (failure.path ? failure.error.replaceAll(failure.path, name) : failure.error)
      .replace(/^Error invoking remote method '[^'\n]{1,128}':\s*/, '')
      .replace(/^(?:(?:Error|NativeDocumentCommandError):\s*){1,3}/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);
    const safeReason =
      userMessageValue(reason) === reason ? reason : userMessage('operation.failed');
    return name
      ? `${userMessageValue(name.replace(/\s+/g, ' ').slice(0, 120))}: ${safeReason}`
      : safeReason;
  });
  const omitted = result.failures.length - lines.length;
  if (omitted) lines.push(`And ${omitted} more save ${omitted === 1 ? 'failure' : 'failures'}.`);
  return lines.join('; ');
}

async function discardCopies(win: BrowserWindow | null): Promise<boolean> {
  try {
    await saver?.discardRecoveryCopies?.(win);
    return true;
  } catch (error: unknown) {
    console.warn('[quit-consent] Could not drop recovery copies:', error);
    await showWarning(win, {
      title: userMessage('dialog.discard-could-not-be-confirmed'),
      message: userMessage(
        'dialog.dnaforge-could-not-confirm-that-all-unsaved-changes-were-discarded'
      ),
      detail: userMessage(
        'dialog.the-app-will-stay-open-inspect-the-remaining-changes-after-the-current'
      ),
      buttons: [userMessage('dialog.cancel')],
      defaultId: CANCEL,
    });
    return false;
  }
}

async function showWarning(
  win: BrowserWindow | null,
  opts: Pick<UserMessageBoxOptions, 'title' | 'message' | 'detail' | 'buttons' | 'defaultId'>
): Promise<number> {
  const windows = process.platform === 'win32';
  const dialogOpts: UserMessageBoxOptions = {
    type: 'warning',
    ...opts,
    cancelId: CANCEL,

    ...(windows ? { noLink: true } : {}),
  };
  revealQuitPromptWindow(win);
  const owner = windows && win && !win.isDestroyed() ? win : null;
  const result = owner
    ? await createUserDialogs(dialog).showMessageBox(owner, dialogOpts)
    : await createUserDialogs(dialog).showMessageBox(dialogOpts);
  return result.response;
}
