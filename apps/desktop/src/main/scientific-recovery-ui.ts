import { createUserDialogs } from './user-dialogs';
import {
  toUserMessage,
  withUserMessage,
  userMessagePayload,
  userMessage,
  userMessageWithValues,
  userMessageValue,
} from '@waypoint/user-messages';
import { dialog, shell, type BrowserWindow } from 'electron';
import { getDirtyState } from './dirty-state-cache';

interface RecoveryProject {
  id: number;
  name: string;
  path: string;
}

let recoveryDialogOpen = false;

function assertSavedChanges(): void {
  const dirty = getDirtyState();
  if (dirty.hasDirtyWork) {
    throw withUserMessage(
      new Error(
        `Save your changes in ${dirty.details || 'your open documents'} before creating a recovery copy. ` +
          'Unsaved edits cannot be included in a disk checkpoint.'
      ),
      userMessagePayload('recovery.saveChanges', {
        documents: userMessageValue(dirty.details || 'your open documents'),
      })
    );
  }
}

export async function showScientificStorageRecovery(window: BrowserWindow): Promise<void> {
  if (recoveryDialogOpen) return;
  recoveryDialogOpen = true;
  let completedDirectory: string | undefined;
  try {
    const dirty = getDirtyState();
    if (dirty.hasDirtyWork) {
      await createUserDialogs(dialog).showMessageBox(window, {
        type: 'warning',
        title: userMessage('dialog.scientific-storage-recovery'),
        message: userMessage('dialog.save-your-changes-before-creating-a-recovery-copy'),
        detail: userMessageWithValues(
          'dialog.there-are-unsaved-changes-in-value-unsaved-edits-cannot-be-included-in',
          { value0: userMessageValue(dirty.details || 'your open documents') }
        ),
        buttons: [userMessage('dialog.close')],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return;
    }

    const [{ getDb }, recovery, { scientificWorkspaceIdForRoot }] = await Promise.all([
      import('./ipc/database'),
      import('./scientific-migration-recovery'),
      import('./scientific-workspace-identity'),
    ]);
    const db = getDb({ interactive: false });
    const projects = db
      .prepare(
        `SELECT id, name, path FROM workspaces
         WHERE archived_at IS NULL AND trashed_at IS NULL
         ORDER BY name COLLATE NOCASE, id`
      )
      .all() as RecoveryProject[];
    const eligible: RecoveryProject[] = [];
    for (const project of projects) {
      const checkpoints = await recovery.listScientificRecoveryCheckpoints(db, project.id);
      if (checkpoints.some((checkpoint) => checkpoint.kind === 'pre-enrollment')) {
        eligible.push(project);
      }
    }

    const firstProject = eligible[0];
    if (!firstProject) {
      await createUserDialogs(dialog).showMessageBox(window, {
        type: 'info',
        title: userMessage('dialog.scientific-storage-recovery'),
        message: userMessage('dialog.no-scientific-storage-recovery-checkpoint-is-available'),
        detail: userMessage(
          'dialog.recovery-requires-a-checkpoint-saved-before-scientific-database-storag'
        ),
        buttons: [userMessage('dialog.close')],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return;
    }

    const { response: scopeResponse } = await createUserDialogs(dialog).showMessageBox(window, {
      type: 'info',
      title: userMessage('dialog.scientific-storage-recovery'),
      message: userMessage(
        'dialog.create-a-separate-copy-from-before-scientific-storage-was-enabled'
      ),
      detail: userMessageWithValues(
        'dialog.recovery-copies-the-saved-project-and-database-profile-from-the-pre-en',
        {
          value0: userMessageValue(
            eligible
              .map((project) => `${project.name}\n${project.path}`)
              .join('\n\n')
              .replace(/\r?\n/g, ', ')
          ),
        }
      ),
      buttons: [userMessage('dialog.choose-project'), userMessage('dialog.cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (scopeResponse !== 0) return;

    const selected = await dialog.showOpenDialog(window, {
      title: 'Choose the original project folder to recover',
      defaultPath: firstProject.path,
      buttonLabel: 'Choose Project',
      properties: ['openDirectory', 'dontAddToRecent'],
    });
    const root = selected.filePaths[0];
    if (selected.canceled || selected.filePaths.length !== 1 || root === undefined) return;
    if (getDb({ interactive: false }) !== db) {
      throw withUserMessage(
        new Error('The active database changed. Open Scientific Storage Recovery again.'),
        'recovery.dataChanged'
      );
    }
    const workspaceId = scientificWorkspaceIdForRoot(db, root);
    const project = eligible.find((candidate) => candidate.id === workspaceId);
    if (!project) {
      throw withUserMessage(
        new Error(
          'Choose an active project folder from the list of projects with recovery checkpoints.'
        ),
        'recovery.projectRequired'
      );
    }
    const checkpoints = await recovery.listScientificRecoveryCheckpoints(db, project.id);
    const baseline = checkpoints.find((checkpoint) => checkpoint.kind === 'pre-enrollment');
    if (!baseline) {
      throw withUserMessage(
        new Error('This project no longer has a pre-enrollment recovery checkpoint.'),
        'recovery.checkpointUnavailable'
      );
    }
    const { response: confirmResponse } = await createUserDialogs(dialog).showMessageBox(window, {
      type: 'warning',
      title: userMessage('dialog.scientific-storage-recovery'),
      message: userMessageWithValues('dialog.create-a-recovery-copy-of-value', {
        value0: userMessageValue(project.name),
      }),
      detail: userMessage(
        'dialog.the-recovered-copy-contains-the-saved-state-from-before-scientific-dat'
      ),
      buttons: [userMessage('dialog.create-recovery-copy'), userMessage('dialog.cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (confirmResponse !== 0) return;
    assertSavedChanges();
    if (getDb({ interactive: false }) !== db) {
      throw withUserMessage(
        new Error('The active database changed. Open Scientific Storage Recovery again.'),
        'recovery.dataChanged'
      );
    }
    if (scientificWorkspaceIdForRoot(db, root) !== project.id) {
      throw withUserMessage(
        new Error('The selected project owner changed. Open Scientific Storage Recovery again.'),
        'recovery.ownerChanged'
      );
    }
    const result = await recovery.createScientificLegacyRecovery({
      db,
      workspaceId: project.id,
      checkpointId: baseline.id,
      beforeSnapshot: assertSavedChanges,
    });
    completedDirectory = result.directory;
    const { response: revealResponse } = await createUserDialogs(dialog).showMessageBox(window, {
      type: 'info',
      title: userMessage('dialog.scientific-storage-recovery'),
      message: userMessage('dialog.the-separate-recovery-copy-is-ready'),
      detail: userMessageWithValues(
        'dialog.recovered-project-value-isolated-database-profile-value-your-original-',
        {
          value0: userMessageValue(result.projectPath),
          value1: userMessageValue(result.profilePath),
        }
      ),
      buttons: [userMessage('dialog.reveal-recovery-copy'), userMessage('dialog.close')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (revealResponse === 0) shell.showItemInFolder(result.directory);
  } catch (error) {
    await createUserDialogs(dialog).showMessageBox(window, {
      type: 'error',
      title: userMessage('dialog.scientific-storage-recovery'),
      message: completedDirectory
        ? userMessage('dialog.the-recovery-copy-was-created-but-could-not-be-shown')
        : userMessage('dialog.recovery-copy-was-not-created'),
      detail: completedDirectory
        ? userMessageWithValues('recovery.copyCreated', {
            directory: userMessageValue(completedDirectory),
          })
        : toUserMessage(error, 'recovery.failed'),
      buttons: [userMessage('dialog.close')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
  } finally {
    recoveryDialogOpen = false;
  }
}
