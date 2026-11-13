import { userMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { createUserDialogs } from './user-dialogs';
import { clipboard, dialog, type BrowserWindow } from 'electron';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function showDesktopCliHelp(
  window: BrowserWindow,
  resourcesPath = process.resourcesPath
): Promise<void> {
  const launcher = join(
    resourcesPath,
    'cli',
    process.platform === 'win32' ? 'dnaforge.cmd' : 'dnaforge'
  );
  const available = await stat(launcher).then(
    (file) => file.isFile(),
    () => false
  );
  if (!available) {
    await createUserDialogs(dialog).showMessageBox(window, {
      type: 'error',
      message: userMessage('dialog.the-bundled-command-is-unavailable'),
      detail: userMessage(
        'dialog.install-a-complete-dnaforge-application-to-use-its-bundled-command-lin'
      ),
      buttons: [userMessage('dialog.close')],
    });
    return;
  }
  const { response } = await createUserDialogs(dialog).showMessageBox(window, {
    type: 'info',
    title: userMessage('dialog.dnaforge-command-line'),
    message: userMessage('dialog.use-dnaforge-from-your-shell'),
    detail: userMessageWithValues(
      'dialog.value-run-this-command-with-jobs-help-to-discover-and-manage-tracked-w',
      { value0: userMessageValue(launcher) }
    ),
    buttons: [userMessage('dialog.copy-path'), userMessage('dialog.close')],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) await clipboard.writeText(launcher);
}
