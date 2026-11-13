import {
  userMessage,
  toUserMessage,
  userMessageWithValues,
  userMessageValue,
  userEntityLabel,
} from '@waypoint/user-messages';
import { createUserDialogs } from '../user-dialogs';
import { dialog } from 'electron';
import { sendRendererIpc } from '../../shared/ipc-contract';
import { getActiveSession, getAuthState } from '../auth/controller';
import { focusWindowUnlessBackground } from '../background-window-mode';
import { getDb } from '../ipc/database';
import { managedRootDir } from '../ipc/workspace-git';
import {
  createAuthenticatedDeepShareImportClient,
  importShareIntoManagedWorkspace,
  prepareDeepShareImport,
} from '../workspace-sync-import-share';
import { createDesktopSyncClient } from '../desktop-sync-client';
import { assertCommittedDatabaseReadAllowed } from '../workspace-sync-database-fence';
import {
  PendingImportShareUrl,
  isImportShareUrl,
  parseImportShareUrl,
} from '../workspace-sync-import-share-url';
import {
  PendingOpenOrganizationsUrl,
  isOpenOrganizationsUrl,
} from '../workspace-sync-open-organizations-url';
import {
  PendingOpenSharedProjectUrl,
  isOpenSharedProjectUrl,
  parseOpenSharedProjectUrl,
} from '../workspace-sync-open-shared-project-url';
import type { MainFeature, MainFeatureContext } from './main-feature';

function focusMainWindow(context: MainFeatureContext): void {
  focusWindowUnlessBackground(context.getMainWindow());
}

export function createShareLinksFeature(): MainFeature {
  const pendingImportShareUrl = new PendingImportShareUrl();
  let importShareRunning = false;
  const pendingOpenSharedProjectUrl = new PendingOpenSharedProjectUrl();
  let openSharedProjectRunning = false;
  const pendingOpenOrganizationsUrl = new PendingOpenOrganizationsUrl();

  function handleOpenOrganizationsUrl(url: string, context: MainFeatureContext): void {
    if (!isOpenOrganizationsUrl(url)) return;
    if (getAuthState().status !== 'signed-in') {
      pendingOpenOrganizationsUrl.replace(url);
      focusMainWindow(context);
      void createUserDialogs(dialog).showMessageBox({
        type: 'info',
        message: userMessage('dialog.sign-in-to-open-your-organizations'),
        detail: userMessage(
          'dialog.dnaforge-will-open-organization-settings-once-sign-in-completes'
        ),
      });
      return;
    }
    const mainWindow = context.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      focusMainWindow(context);
      sendRendererIpc(mainWindow.webContents, 'menu:organizations');
    }
  }

  async function handleOpenSharedProjectUrl(
    url: string,
    context: MainFeatureContext
  ): Promise<void> {
    const parsed = parseOpenSharedProjectUrl(url);
    if (!parsed) return;
    if (getAuthState().status !== 'signed-in' || openSharedProjectRunning) {
      pendingOpenSharedProjectUrl.replace(url);
      focusMainWindow(context);
      if (getAuthState().status !== 'signed-in') {
        void createUserDialogs(dialog).showMessageBox({
          type: 'info',
          message: userMessage('dialog.sign-in-to-open-this-shared-project'),
          detail: userMessage('dialog.dnaforge-will-open-the-project-once-sign-in-completes'),
        });
      }
      return;
    }

    openSharedProjectRunning = true;
    try {
      const { openWorkspaceSyncProject } = await import('../workspace-sync-projects');
      const result = await openWorkspaceSyncProject(getDb(), {
        remoteWorkspaceId: parsed.remoteWorkspaceId,
        managedRootDir: managedRootDir(),
      });
      if (!result.ok) {
        createUserDialogs(dialog).showErrorBox(
          userMessage('dialog.could-not-open-shared-project'),
          toUserMessage(result, 'sharing.openFailed')
        );
        return;
      }
      const row = getDb()
        .prepare(`SELECT path, name FROM workspaces WHERE repo_uuid = ? LIMIT 1`)
        .get(result.workspaceUuid) as { path: string; name: string } | undefined;
      if (!row) {
        createUserDialogs(dialog).showErrorBox(
          userMessage('dialog.could-not-open-shared-project'),
          userMessage('dialog.the-project-was-downloaded-but-its-local-record-was-not-found')
        );
        return;
      }
      const mainWindow = context.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        focusMainWindow(context);
        sendRendererIpc(
          mainWindow.webContents,
          'workspace:set-path',
          row.path,
          crypto.randomUUID(),
          'managed_sync'
        );
      }
      if (result.warnings && result.warnings.length > 0) {
        createUserDialogs(dialog).showMessageBox({
          type: 'info',
          message: userMessageWithValues('dialog.opened-value', {
            value0: userMessageValue(row.name),
          }),
          detail: userMessageWithValues('sharing.openedWithNoticeCount', {
            count: userMessageValue(result.warnings.length),
          }),
        });
      }
    } catch (error) {
      createUserDialogs(dialog).showErrorBox(
        userMessage('dialog.could-not-open-shared-project'),
        toUserMessage(error, 'sharing.openFailed')
      );
    } finally {
      openSharedProjectRunning = false;
      if (getAuthState().status === 'signed-in') {
        const nextUrl = pendingOpenSharedProjectUrl.take();
        if (nextUrl) void handleOpenSharedProjectUrl(nextUrl, context);
      }
    }
  }

  async function handleImportShareUrl(url: string, context: MainFeatureContext): Promise<void> {
    const parsed = parseImportShareUrl(url);
    if (!parsed) return;
    if (getAuthState().status !== 'signed-in' || importShareRunning) {
      pendingImportShareUrl.replace(url);
      focusMainWindow(context);
      if (getAuthState().status !== 'signed-in') {
        void createUserDialogs(dialog).showMessageBox({
          type: 'info',
          message: userMessage('dialog.sign-in-to-import-this-deep-share'),
          detail: userMessage(
            'dialog.dnaforge-will-resume-the-private-fork-import-once-sign-in-completes'
          ),
        });
      }
      return;
    }

    importShareRunning = true;
    try {
      const session = await getActiveSession();
      if (!session) throw new Error('Sign in before importing this private fork.');
      const db = getDb();
      const root = managedRootDir();
      const assertAuthority = async () => {
        const current = await getActiveSession();
        if (
          !current ||
          current.accountId !== session.accountId ||
          current.desktopSessionId !== session.desktopSessionId ||
          managedRootDir() !== root
        )
          throw new Error(
            'The import account or destination changed. Open the original share link again.'
          );
        assertCommittedDatabaseReadAllowed(db);
      };
      const prepared = await prepareDeepShareImport({
        ...parsed,
        managedRootDir: root,
        db,
        client: createAuthenticatedDeepShareImportClient(
          createDesktopSyncClient(),
          session.accountId
        ),
        assertAuthority,
      });
      const decision = await createUserDialogs(dialog).showMessageBox({
        type: 'question',
        message: userMessageWithValues('dialog.import-value-as-a-private-fork', {
          value0: userMessageValue(prepared.review.source.artifactName),
        }),
        detail: userMessageWithValues('sharing.importReview', {
          files: userMessageValue(prepared.review.source.fileCount),
          conversations: userMessageValue(prepared.review.source.conversationCount),
          project: userMessageValue(
            userEntityLabel(prepared.review.destination.displayName, 'project.untitled')
          ),
          location: userMessageValue(prepared.review.destination.repoPath),
          account: userMessageValue(userEntityLabel(session.email, 'identity.user')),
        }),
        buttons: [userMessage('dialog.cancel'), userMessage('dialog.import-private-fork')],
        cancelId: 0,
        defaultId: 0,
        noLink: true,
      });
      if (decision.response !== 1) return;
      await assertAuthority();
      const result = await importShareIntoManagedWorkspace({
        shortId: parsed.shortId,
        token: '',
        managedRootDir: root,
        db,
        prepared,
        assertAuthority,
      });
      const mainWindow = context.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        focusMainWindow(context);
        sendRendererIpc(
          mainWindow.webContents,
          'workspace:set-path',
          result.repoPath,
          crypto.randomUUID(),
          'managed_sync'
        );
      }
      createUserDialogs(dialog).showMessageBox({
        type: 'info',
        message: userMessage('dialog.private-fork-opened'),
        detail:
          result.warnings.length > 0
            ? userMessageWithValues('sharing.importOpenedWithNotices', {
                project: userMessageValue(userEntityLabel(result.displayName, 'project.untitled')),
                count: userMessageValue(result.warnings.length),
              })
            : userMessageWithValues('sharing.importOpened', {
                project: userMessageValue(userEntityLabel(result.displayName, 'project.untitled')),
              }),
      });
    } catch (error) {
      createUserDialogs(dialog).showErrorBox(
        userMessage('dialog.could-not-open-shared-project'),
        toUserMessage(error, 'sharing.openFailed')
      );
    } finally {
      importShareRunning = false;
      if (getAuthState().status === 'signed-in') {
        const nextUrl = pendingImportShareUrl.take();
        if (nextUrl) void handleImportShareUrl(nextUrl, context);
      }
    }
  }

  return {
    id: 'share-links',
    protocolRoutes: [
      {
        matches: isImportShareUrl,
        open: (url, context) => void handleImportShareUrl(url, context),
      },
      {
        matches: isOpenSharedProjectUrl,
        open: (url, context) => void handleOpenSharedProjectUrl(url, context),
      },
      { matches: isOpenOrganizationsUrl, open: handleOpenOrganizationsUrl },
    ],
    onSignedIn: (context) => {
      const pendingUrl = pendingImportShareUrl.take();
      if (pendingUrl) void handleImportShareUrl(pendingUrl, context);
      const pendingOpenUrl = pendingOpenSharedProjectUrl.take();
      if (pendingOpenUrl) void handleOpenSharedProjectUrl(pendingOpenUrl, context);
      const pendingOrgsUrl = pendingOpenOrganizationsUrl.take();
      if (pendingOrgsUrl) handleOpenOrganizationsUrl(pendingOrgsUrl, context);
    },
  };
}

export const shareLinksFeature = createShareLinksFeature();
